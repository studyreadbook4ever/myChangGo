import { EDITOR_DATABASE_NAME } from "../../extension/lib/editor-core.js";

const DATABASE_NAME = EDITOR_DATABASE_NAME;
const DATABASE_VERSION = 2;
const PROJECTS = "projects";
const HANDLES = "media-handles";
const IMAGE_ASSETS = "image-assets";

let databasePromise = null;
let activeDatabase = null;

function clearCachedDatabase(database, attempt) {
  if (activeDatabase === database) {
    activeDatabase = null;
  }
  if (databasePromise === attempt) {
    databasePromise = null;
  }
}

function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  let resolveAttempt;
  let rejectAttempt;
  let settled = false;
  const attempt = new Promise((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });
  databasePromise = attempt;

  const rejectOpen = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (databasePromise === attempt) {
      databasePromise = null;
    }
    rejectAttempt(error);
  };

  let request;
  try {
    request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  } catch (error) {
    rejectOpen(error);
    return attempt;
  }

  request.onerror = () => rejectOpen(
    request.error || new Error("편집기 저장소를 열지 못했습니다.")
  );
  request.onblocked = () => rejectOpen(new Error(
    "다른 편집기 탭이 저장소 업그레이드를 막고 있습니다. "
    + "다른 편집기 탭을 닫고 다시 시도해 주세요."
  ));
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(PROJECTS)) {
      database.createObjectStore(PROJECTS, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(HANDLES)) {
      database.createObjectStore(HANDLES);
    }
    if (!database.objectStoreNames.contains(IMAGE_ASSETS)) {
      database.createObjectStore(IMAGE_ASSETS);
    }
  };
  request.onsuccess = () => {
    const database = request.result;
    if (settled) {
      database.close();
      return;
    }
    settled = true;
    activeDatabase = database;
    database.onversionchange = () => {
      database.close();
      clearCachedDatabase(database, attempt);
    };
    database.onclose = () => clearCachedDatabase(database, attempt);
    resolveAttempt(database);
  };

  return attempt;
}

function isClosedDatabaseError(error) {
  return error?.name === "InvalidStateError";
}

function discardDatabase(database) {
  if (activeDatabase === database) {
    activeDatabase = null;
    databasePromise = null;
  }
  try {
    database?.close();
  } catch {
    // A connection that is already closing does not need further cleanup.
  }
}

function runTransaction(database, storeNames, mode, operation) {
  return new Promise((resolve, reject) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    let tx;
    try {
      tx = database.transaction(storeNames, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const stores = Object.fromEntries(
      names.map((storeName) => [storeName, tx.objectStore(storeName)])
    );
    const operationTarget = Array.isArray(storeNames)
      ? stores
      : stores[storeNames];
    let result;
    try {
      result = operation(operationTarget, tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have been aborted by IndexedDB.
      }
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("저장 작업이 중단되었습니다."));
  });
}

async function transaction(storeNames, mode, operation, retryClosedDatabase = true) {
  const database = await openDatabase();
  try {
    return await runTransaction(database, storeNames, mode, operation);
  } catch (error) {
    if (retryClosedDatabase && isClosedDatabaseError(error)) {
      discardDatabase(database);
      return transaction(storeNames, mode, operation, false);
    }
    throw error;
  }
}

export async function loadProject(projectId) {
  return transaction(PROJECTS, "readonly", (store) => store.get(projectId));
}

export async function saveProject(project) {
  await transaction(PROJECTS, "readwrite", (store) => store.put(project));
  return project;
}

export async function saveMediaHandle(projectId, handle) {
  try {
    await transaction(HANDLES, "readwrite", (store) => store.put(handle, projectId));
    return true;
  } catch (error) {
    console.warn("영상 파일 핸들을 저장하지 못했습니다.", error);
    return false;
  }
}

export async function deleteMediaHandle(projectId) {
  try {
    await transaction(HANDLES, "readwrite", (store) => store.delete(projectId));
    return true;
  } catch (error) {
    console.warn("이전 영상 파일 핸들을 지우지 못했습니다.", error);
    return false;
  }
}

export async function loadMediaHandle(projectId) {
  try {
    return await transaction(HANDLES, "readonly", (store) => store.get(projectId));
  } catch (error) {
    console.warn("영상 파일 핸들을 복구하지 못했습니다.", error);
    return null;
  }
}

export async function getFileFromStoredHandle(projectId) {
  try {
    const handle = await loadMediaHandle(projectId);
    if (!handle) {
      return null;
    }
    const permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      return { handle, file: null, permission };
    }
    return { handle, file: await handle.getFile(), permission };
  } catch (error) {
    console.warn("저장된 원본 파일을 다시 열지 못했습니다.", error);
    return { handle: null, file: null, permission: "error", error: error.message };
  }
}

const imageAssetKey = (projectId, assetId) => [
  String(projectId || ""),
  String(assetId || "")
];

export async function saveImageAssetBlob(projectId, assetId, blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new TypeError("저장할 이미지 에셋 Blob이 비어 있습니다.");
  }
  await transaction(
    IMAGE_ASSETS,
    "readwrite",
    (store) => store.put(blob, imageAssetKey(projectId, assetId))
  );
  return blob;
}

export async function saveProjectWithImageAssetBlob(project, assetId, blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new TypeError("저장할 이미지 에셋 Blob이 비어 있습니다.");
  }
  await transaction(
    [PROJECTS, IMAGE_ASSETS],
    "readwrite",
    (stores) => {
      stores[PROJECTS].put(project);
      stores[IMAGE_ASSETS].put(blob, imageAssetKey(project?.id, assetId));
      return {
        get result() {
          return project;
        }
      };
    }
  );
  return project;
}

export async function loadImageAssetBlob(projectId, assetId) {
  const value = await transaction(
    IMAGE_ASSETS,
    "readonly",
    (store) => store.get(imageAssetKey(projectId, assetId))
  );
  return value instanceof Blob ? value : null;
}

export async function deleteImageAssetBlob(projectId, assetId) {
  await transaction(
    IMAGE_ASSETS,
    "readwrite",
    (store) => store.delete(imageAssetKey(projectId, assetId))
  );
}

export async function pruneImageAssetBlobs(projectId, keepAssetIds = []) {
  const targetProjectId = String(projectId || "");
  const requestedKeep = new Set(
    Array.from(keepAssetIds || [], (assetId) => String(assetId || ""))
  );
  const deletedCount = await transaction(
    [PROJECTS, IMAGE_ASSETS],
    "readwrite",
    (stores) => {
      let count = 0;
      const projectRequest = stores[PROJECTS].get(targetProjectId);
      projectRequest.onsuccess = () => {
        const keep = new Set(requestedKeep);
        for (const asset of projectRequest.result?.imageAssets || []) {
          if (asset?.source?.kind !== "blob-key") {
            continue;
          }
          const blobKey = String(asset.source.value || asset.id || "");
          if (blobKey) {
            keep.add(blobKey);
          }
        }

        const request = stores[IMAGE_ASSETS].openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          const key = cursor.primaryKey ?? cursor.key;
          if (
            Array.isArray(key)
            && key.length >= 2
            && String(key[0]) === targetProjectId
            && !keep.has(String(key[1]))
          ) {
            stores[IMAGE_ASSETS].delete(key);
            count += 1;
          }
          cursor.continue();
        };
      };
      return {
        get result() {
          return count;
        }
      };
    }
  );
  return Number(deletedCount) || 0;
}
