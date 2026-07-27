import { EDITOR_DATABASE_NAME } from "../../extension/lib/editor-core.js";

const DATABASE_NAME = EDITOR_DATABASE_NAME;
const DATABASE_VERSION = 1;
const PROJECTS = "projects";
const HANDLES = "media-handles";

let databasePromise = null;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PROJECTS)) {
          database.createObjectStore(PROJECTS, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(HANDLES)) {
          database.createObjectStore(HANDLES);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
  return databasePromise;
}

async function transaction(storeName, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("저장 작업이 중단되었습니다."));
  });
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
