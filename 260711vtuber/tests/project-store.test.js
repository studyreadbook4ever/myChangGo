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

function createLocalDraftDatabase({
  projects = [],
  drafts = []
} = {}) {
  const state = {
    projects: new Map(projects.map((project) => [project.id, structuredClone(project)])),
    drafts: new Map(drafts.map((draft) => [draft.id, structuredClone(draft)]))
  };

  const database = {
    state,
    close() {},
    transaction(storeNames, mode) {
      const requestedStores = Array.isArray(storeNames) ? storeNames : [storeNames];
      const tx = {
        mode,
        error: null
      };
      let pendingRequests = 0;
      let completionQueued = false;

      const maybeComplete = () => {
        if (pendingRequests > 0 || completionQueued) {
          return;
        }
        completionQueued = true;
        queueMicrotask(() => {
          completionQueued = false;
          if (pendingRequests === 0) {
            tx.oncomplete?.();
          } else {
            maybeComplete();
          }
        });
      };
      const request = (read) => {
        const result = {};
        pendingRequests += 1;
        queueMicrotask(() => {
          try {
            result.result = structuredClone(read());
            result.onsuccess?.();
          } catch (error) {
            result.error = error;
            tx.error = error;
            result.onerror?.();
            tx.onerror?.();
          } finally {
            pendingRequests -= 1;
            maybeComplete();
          }
        });
        return result;
      };
      const projectStore = {
        put(project) {
          state.projects.set(project.id, structuredClone(project));
          return {};
        },
        get(projectId) {
          return request(() => state.projects.get(projectId));
        }
      };
      const draftStore = {
        put(draft) {
          state.drafts.set(draft.id, structuredClone(draft));
          return {};
        },
        get(draftId) {
          return request(() => state.drafts.get(draftId));
        },
        delete(draftId) {
          state.drafts.delete(draftId);
          return {};
        },
        index(indexName) {
          assert.equal(indexName, "projectId");
          return {
            getAll(projectId) {
              return request(() => [...state.drafts.values()].filter(
                (draft) => draft.projectId === projectId
              ));
            }
          };
        }
      };

      tx.objectStore = (storeName) => {
        assert(requestedStores.includes(storeName));
        if (storeName === "projects") {
          return projectStore;
        }
        if (storeName === "local-drafts") {
          return draftStore;
        }
        throw new Error(`Unexpected store: ${storeName}`);
      };
      queueMicrotask(maybeComplete);
      return tx;
    }
  };
  return database;
}

function useOpenedDatabase(database, onOpen = () => {}) {
  globalThis.indexedDB = {
    open(name, version) {
      onOpen(name, version);
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    }
  };
}

test("IndexedDB v3 업그레이드는 local-drafts와 projectId 인덱스를 만든다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  const createdStores = [];
  const createdIndexes = [];
  const existingStores = new Set(["projects", "media-handles", "image-assets"]);
  const localDraftStore = {
    indexNames: {
      contains(indexName) {
        return createdIndexes.some((entry) => entry.name === indexName);
      }
    },
    createIndex(name, keyPath, options) {
      createdIndexes.push({ name, keyPath, options });
      return {};
    }
  };
  const database = readableProjectDatabase({ id: "project", name: "업그레이드됨" });
  database.objectStoreNames = {
    contains(storeName) {
      return existingStores.has(storeName);
    }
  };
  database.createObjectStore = (name, options) => {
    createdStores.push({ name, options });
    existingStores.add(name);
    return name === "local-drafts" ? localDraftStore : {};
  };
  globalThis.indexedDB = {
    open(name, version) {
      assert.equal(name, "chzzk-kirinuki-studio");
      assert.equal(version, 3);
      const request = {};
      requests.push(request);
      return request;
    }
  };

  try {
    const store = await freshProjectStore("v3-upgrade");
    const loadPromise = store.loadProject("project");
    requests[0].result = database;
    requests[0].transaction = {
      objectStore(storeName) {
        assert.equal(storeName, "local-drafts");
        return localDraftStore;
      }
    };
    requests[0].onupgradeneeded();
    requests[0].onsuccess();

    assert.deepEqual(await loadPromise, { id: "project", name: "업그레이드됨" });
    assert.deepEqual(createdStores, [{
      name: "local-drafts",
      options: { keyPath: "id" }
    }]);
    assert.deepEqual(createdIndexes, [{
      name: "projectId",
      keyPath: "projectId",
      options: { unique: false }
    }]);
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

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

test("로컬 임시저장은 프로젝트별 최신 5개만 원자적으로 남기고 복사본을 반환한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const database = createLocalDraftDatabase();
  const openedVersions = [];
  useOpenedDatabase(database, (_name, version) => openedVersions.push(version));

  try {
    const store = await freshProjectStore("local-draft-retention");
    for (let index = 0; index < 6; index += 1) {
      const project = {
        id: "target",
        name: `버전 ${index}`,
        imageAssets: []
      };
      const saved = await store.saveLocalDraft(project, {
        reason: index % 2 === 0 ? "auto" : "manual",
        now: Date.UTC(2026, 6, 28, 0, index),
        id: `target-${index}`
      });
      project.name = "호출 뒤 변경";
      saved.project.name = "반환본 변경";
    }
    await store.saveLocalDraft({
      id: "other",
      name: "다른 프로젝트",
      imageAssets: []
    }, {
      reason: "manual",
      now: Date.UTC(2026, 6, 28, 1, 0),
      id: "other-0"
    });

    const targetDrafts = await store.listLocalDrafts("target");
    assert.deepEqual(
      targetDrafts.map((draft) => draft.id),
      ["target-5", "target-4", "target-3", "target-2", "target-1"]
    );
    assert.deepEqual(
      targetDrafts.map((draft) => draft.project.name),
      ["버전 5", "버전 4", "버전 3", "버전 2", "버전 1"]
    );
    assert.equal(database.state.drafts.has("target-0"), false);
    assert.equal(database.state.drafts.has("other-0"), true);
    assert.equal(database.state.projects.get("target").name, "버전 5");
    assert.equal(database.state.projects.get("other").name, "다른 프로젝트");
    assert.deepEqual(
      (await store.listLocalDrafts("target", { limit: 2 })).map((draft) => draft.id),
      ["target-5", "target-4"]
    );

    const loaded = await store.loadLocalDraft("target", "target-5");
    assert.equal(loaded.project.name, "버전 5");
    loaded.project.name = "불러온 복사본 변경";
    assert.equal(database.state.drafts.get("target-5").project.name, "버전 5");
    assert.equal(await store.loadLocalDraft("other", "target-5"), null);
    assert.deepEqual(openedVersions, [3]);
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test("가장 오래된 5번째 임시저장도 불러오기 직전본 생성 후 안전하게 복원한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const database = createLocalDraftDatabase();
  useOpenedDatabase(database);

  try {
    const store = await freshProjectStore("local-draft-restore");
    for (let index = 0; index < 5; index += 1) {
      await store.saveLocalDraft({
        id: "target",
        name: `저장본 ${index}`,
        imageAssets: []
      }, {
        reason: "manual",
        now: Date.UTC(2026, 6, 28, 0, index),
        id: `target-${index}`
      });
    }
    const oldestDraft = await store.loadLocalDraft("target", "target-0");
    assert(oldestDraft);
    const currentProject = {
      id: "target",
      name: "불러오기 직전 현재 작업",
      imageAssets: []
    };
    const restored = await store.restoreLocalDraft(currentProject, oldestDraft, {
      now: Date.UTC(2026, 6, 28, 1, 0),
      id: "target-pre-restore"
    });

    assert.equal(restored.project.name, "저장본 0");
    assert.equal(database.state.projects.get("target").name, "저장본 0");
    assert.equal(restored.preRestoreDraft.reason, "pre-restore");
    assert.equal(restored.preRestoreDraft.restoredFromDraftId, "target-0");
    assert.equal(restored.preRestoreDraft.project.name, "불러오기 직전 현재 작업");
    assert.equal(database.state.drafts.has("target-0"), false);
    assert.deepEqual(
      (await store.listLocalDrafts("target")).map((draft) => draft.id),
      [
        "target-pre-restore",
        "target-4",
        "target-3",
        "target-2",
        "target-1"
      ]
    );

    currentProject.name = "호출 뒤 현재본 변경";
    oldestDraft.project.name = "호출 뒤 대상 변경";
    restored.project.name = "반환 프로젝트 변경";
    restored.preRestoreDraft.project.name = "반환 직전본 변경";
    assert.equal(database.state.projects.get("target").name, "저장본 0");
    assert.equal(
      database.state.drafts.get("target-pre-restore").project.name,
      "불러오기 직전 현재 작업"
    );

    await assert.rejects(
      store.restoreLocalDraft(
        { id: "other", name: "다른 프로젝트" },
        database.state.drafts.get("target-4")
      ),
      /이 프로젝트에서 불러올 수 있는 임시저장본/
    );
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

test("고아 이미지 Blob 정리는 현재 프로젝트와 임시저장본 참조를 모두 보존한다", async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const requests = [];
  const entries = [
    { key: ["target", "keep"], deleted: false },
    { key: ["target", "remove-a"], deleted: false },
    { key: ["target", "draft-only"], deleted: false },
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
        assert.deepEqual(storeName, ["projects", "local-drafts", "image-assets"]);
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
        const draftStore = {
          index(indexName) {
            assert.equal(indexName, "projectId");
            return {
              getAll(projectId) {
                assert.equal(projectId, "target");
                const request = {
                  result: [{
                    schema: "chzzk-kirinuki-local-draft/v1",
                    id: "draft-with-asset",
                    projectId: "target",
                    createdAt: "2026-07-28T00:00:00.000Z",
                    createdAtMs: Date.UTC(2026, 6, 28),
                    reason: "manual",
                    restoredFromDraftId: null,
                    project: {
                      id: "target",
                      imageAssets: [{
                        id: "draft-only",
                        source: { kind: "blob-key", value: "draft-only" }
                      }]
                    }
                  }]
                };
                queueMicrotask(() => request.onsuccess?.());
                return request;
              }
            };
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
        tx.objectStore = (name) => {
          if (name === "projects") {
            return projectStore;
          }
          if (name === "local-drafts") {
            return draftStore;
          }
          return imageStore;
        };
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
        { key: ["target", "draft-only"], deleted: false },
        { key: ["other", "remove-a"], deleted: false },
        { key: ["target", "remove-b"], deleted: true },
        { key: "legacy-key", deleted: false }
      ]
    );
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});
