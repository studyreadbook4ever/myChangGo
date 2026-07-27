import assert from "node:assert/strict";
import test from "node:test";

function freshProjectStore(label) {
  return import(`../src/editor/project-store.js?${label}-${Date.now()}-${Math.random()}`);
}

function readableProjectDatabase(project) {
  return {
    close() {},
    transaction(storeName, mode) {
      assert.equal(storeName, "projects");
      assert.equal(mode, "readonly");
      const tx = {
        objectStore() {
          return {
            get() {
              return { result: project };
            }
          };
        }
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }
  };
}

async function waitForRequestCount(requests, expected) {
  for (let attempt = 0; attempt < 20 && requests.length < expected; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(requests.length, expected);
}

test("IndexedDB 업그레이드 차단은 즉시 실패하고 재시도하며 늦은 성공 DB를 닫는다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      return request;
    }
  };

  try {
    const store = await freshProjectStore("blocked");
    const blockedLoad = store.loadProject("project");
    const blockedAssertion = assert.rejects(blockedLoad, /다른 편집기 탭.*닫고 다시 시도/);
    requests[0].onblocked();
    await blockedAssertion;

    const retryLoad = store.loadProject("project");
    assert.equal(requests.length, 2);

    let lateCloseCount = 0;
    requests[0].result = {
      close() {
        lateCloseCount += 1;
      }
    };
    requests[0].onsuccess();
    assert.equal(lateCloseCount, 1);

    let currentCloseCount = 0;
    const database = readableProjectDatabase({ id: "project", name: "복구됨" });
    database.close = () => {
      currentCloseCount += 1;
    };
    requests[1].result = database;
    requests[1].onsuccess();
    assert.deepEqual(await retryLoad, { id: "project", name: "복구됨" });

    database.onversionchange();
    assert.equal(currentCloseCount, 1);
    const reopenedLoad = store.loadProject("project");
    assert.equal(requests.length, 3);
    requests[2].result = readableProjectDatabase({ id: "project", name: "재개방됨" });
    requests[2].onsuccess();
    assert.deepEqual(await reopenedLoad, { id: "project", name: "재개방됨" });
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test("닫힌 IndexedDB 연결은 캐시를 버리고 한 번 재개방해 트랜잭션을 재시도한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      return request;
    }
  };

  try {
    const store = await freshProjectStore("closed-retry");
    const loadPromise = store.loadProject("project");
    let closeCount = 0;
    requests[0].result = {
      close() {
        closeCount += 1;
      },
      transaction() {
        throw new DOMException("connection is closed", "InvalidStateError");
      }
    };
    requests[0].onsuccess();
    await waitForRequestCount(requests, 2);
    assert.equal(closeCount, 1);

    requests[1].result = readableProjectDatabase({ id: "project", name: "재시도 성공" });
    requests[1].onsuccess();
    assert.deepEqual(await loadPromise, { id: "project", name: "재시도 성공" });
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test("프로젝트와 새 이미지 Blob은 두 저장소의 단일 readwrite 트랜잭션에 저장한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  const writes = [];
  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      return request;
    }
  };

  try {
    const store = await freshProjectStore("atomic-save");
    const project = { id: "target", imageAssets: [] };
    const blob = new Blob(["asset"], { type: "image/png" });
    const savePromise = store.saveProjectWithImageAssetBlob(project, "asset", blob);
    const database = {
      close() {},
      transaction(storeNames, mode) {
        assert.deepEqual(storeNames, ["projects", "image-assets"]);
        assert.equal(mode, "readwrite");
        const tx = {
          objectStore(storeName) {
            return {
              put(...args) {
                writes.push([storeName, ...args]);
                return {};
              }
            };
          }
        };
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      }
    };
    requests[0].result = database;
    requests[0].onsuccess();

    assert.equal(await savePromise, project);
    assert.deepEqual(writes, [
      ["projects", project],
      ["image-assets", blob, ["target", "asset"]]
    ]);
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test("고아 이미지 Blob 정리는 최신 프로젝트 참조와 keep 밖의 같은 프로젝트 키만 삭제한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  const entries = [
    { key: ["target", "keep"], deleted: false },
    { key: ["target", "remove-a"], deleted: false },
    { key: ["other", "remove-a"], deleted: false },
    { key: ["target", "remove-b"], deleted: false },
    { key: "legacy-key", deleted: false }
  ];

  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      return request;
    }
  };

  try {
    const store = await freshProjectStore("prune");
    const prunePromise = store.pruneImageAssetBlobs("target", ["keep"]);
    const database = {
      close() {},
      transaction(storeName, mode) {
        assert.deepEqual(storeName, ["projects", "image-assets"]);
        assert.equal(mode, "readwrite");
        const tx = {};
        const projectStore = {
          get() {
            const request = {
              result: {
                id: "target",
                imageAssets: [{
                  id: "remove-a",
                  source: { kind: "blob-key", value: "remove-a" }
                }]
              }
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          }
        };
        const imageStore = {
          delete(key) {
            const entry = entries.find((candidate) => (
              JSON.stringify(candidate.key) === JSON.stringify(key)
            ));
            if (entry) {
              entry.deleted = true;
            }
            return {};
          },
          openKeyCursor() {
            const request = { result: null };
            let index = 0;
            const dispatch = () => {
              queueMicrotask(() => {
                if (index >= entries.length) {
                  request.result = null;
                  request.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                  return;
                }
                const entry = entries[index];
                request.result = {
                  key: entry.key,
                  primaryKey: entry.key,
                  continue() {
                    index += 1;
                    dispatch();
                  }
                };
                request.onsuccess?.();
              });
            };
            dispatch();
            return request;
          }
        };
        tx.objectStore = (name) => name === "projects" ? projectStore : imageStore;
        return tx;
      }
    };
    requests[0].result = database;
    requests[0].onsuccess();

    assert.equal(await prunePromise, 1);
    assert.deepEqual(
      entries.map(({ key, deleted }) => ({ key, deleted })),
      [
        { key: ["target", "keep"], deleted: false },
        { key: ["target", "remove-a"], deleted: false },
        { key: ["other", "remove-a"], deleted: false },
        { key: ["target", "remove-b"], deleted: true },
        { key: "legacy-key", deleted: false }
      ]
    );
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});
