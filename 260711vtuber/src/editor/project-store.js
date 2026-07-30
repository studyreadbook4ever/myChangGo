import { EDITOR_DATABASE_NAME } from "../../extension/lib/editor-core.js";

const DATABASE_NAME = EDITOR_DATABASE_NAME;
const DATABASE_VERSION = 3;
const PROJECTS = "projects";
const HANDLES = "media-handles";
const IMAGE_ASSETS = "image-assets";
const LOCAL_DRAFTS = "local-drafts";
const LOCAL_DRAFT_PROJECT_INDEX = "projectId";
const LOCAL_DRAFT_SCHEMA = "chzzk-kirinuki-local-draft/v1";
const MAX_LOCAL_DRAFTS = 5;
const LOCAL_DRAFT_REASONS = new Set(["manual", "auto", "pre-restore"]);

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
    const localDraftStore = database.objectStoreNames.contains(LOCAL_DRAFTS)
      ? request.transaction.objectStore(LOCAL_DRAFTS)
      : database.createObjectStore(LOCAL_DRAFTS, { keyPath: "id" });
    if (!localDraftStore.indexNames.contains(LOCAL_DRAFT_PROJECT_INDEX)) {
      localDraftStore.createIndex(
        LOCAL_DRAFT_PROJECT_INDEX,
        LOCAL_DRAFT_PROJECT_INDEX,
        { unique: false }
      );
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

function cloneStoredValue(value) {
  return structuredClone(value);
}

function requiredProjectId(project) {
  const projectId = String(project?.id || "").trim();
  if (!projectId) {
    throw new TypeError("임시저장할 프로젝트 ID가 없습니다.");
  }
  return projectId;
}

function localDraftTimestamp(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const createdAtMs = date.getTime();
  if (!Number.isFinite(createdAtMs)) {
    throw new TypeError("임시저장 시각이 올바르지 않습니다.");
  }
  return {
    createdAt: date.toISOString(),
    createdAtMs
  };
}

function localDraftId(value) {
  const id = String(value || `local-draft-${crypto.randomUUID()}`).trim();
  if (!id) {
    throw new TypeError("임시저장 ID가 없습니다.");
  }
  return id;
}

function localDraftReason(value) {
  const reason = String(value || "manual").trim();
  if (!LOCAL_DRAFT_REASONS.has(reason)) {
    throw new TypeError(`지원하지 않는 임시저장 사유입니다: ${reason}`);
  }
  return reason;
}

function createLocalDraftRecord(project, {
  reason = "manual",
  restoredFromDraftId = null,
  now = Date.now(),
  id = null
} = {}) {
  const projectId = requiredProjectId(project);
  const timestamp = localDraftTimestamp(now);
  return {
    schema: LOCAL_DRAFT_SCHEMA,
    id: localDraftId(id),
    projectId,
    ...timestamp,
    reason: localDraftReason(reason),
    restoredFromDraftId: restoredFromDraftId
      ? String(restoredFromDraftId)
      : null,
    project: cloneStoredValue(project)
  };
}

function isLocalDraftRecord(value, projectId = null) {
  if (
    !value
    || value.schema !== LOCAL_DRAFT_SCHEMA
    || !String(value.id || "")
    || !String(value.projectId || "")
    || !Number.isFinite(Number(value.createdAtMs))
    || !value.project
    || String(value.project.id || "") !== String(value.projectId)
  ) {
    return false;
  }
  return projectId == null || String(value.projectId) === String(projectId);
}

function compareLocalDraftsNewestFirst(first, second) {
  return (
    Number(second.createdAtMs) - Number(first.createdAtMs)
    || String(second.id).localeCompare(String(first.id))
  );
}

function trimLocalDrafts(store, projectId, removedIds) {
  const request = store.index(LOCAL_DRAFT_PROJECT_INDEX).getAll(projectId);
  request.onsuccess = () => {
    const drafts = (request.result || [])
      .filter((draft) => isLocalDraftRecord(draft, projectId))
      .sort(compareLocalDraftsNewestFirst);
    for (const draft of drafts.slice(MAX_LOCAL_DRAFTS)) {
      store.delete(draft.id);
      removedIds.push(draft.id);
    }
  };
}

export async function listLocalDrafts(projectId, { limit = MAX_LOCAL_DRAFTS } = {}) {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) {
    return [];
  }
  const requestedLimit = Number(limit);
  const normalizedLimit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(MAX_LOCAL_DRAFTS, Math.floor(requestedLimit)))
    : MAX_LOCAL_DRAFTS;
  if (normalizedLimit === 0) {
    return [];
  }
  const drafts = await transaction(
    LOCAL_DRAFTS,
    "readonly",
    (store) => store.index(LOCAL_DRAFT_PROJECT_INDEX).getAll(normalizedProjectId)
  );
  return (drafts || [])
    .filter((draft) => isLocalDraftRecord(draft, normalizedProjectId))
    .sort(compareLocalDraftsNewestFirst)
    .slice(0, normalizedLimit)
    .map(cloneStoredValue);
}

export async function loadLocalDraft(projectId, draftId) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedDraftId = String(draftId || "").trim();
  if (!normalizedProjectId || !normalizedDraftId) {
    return null;
  }
  const draft = await transaction(
    LOCAL_DRAFTS,
    "readonly",
    (store) => store.get(normalizedDraftId)
  );
  return isLocalDraftRecord(draft, normalizedProjectId)
    ? cloneStoredValue(draft)
    : null;
}

export async function saveLocalDraft(project, {
  reason = "manual",
  restoredFromDraftId = null,
  now = Date.now(),
  id = null
} = {}) {
  const storedProject = cloneStoredValue(project);
  const draft = createLocalDraftRecord(storedProject, {
    reason,
    restoredFromDraftId,
    now,
    id
  });
  const removedIds = [];
  await transaction(
    [PROJECTS, LOCAL_DRAFTS],
    "readwrite",
    (stores) => {
      stores[PROJECTS].put(storedProject);
      stores[LOCAL_DRAFTS].put(draft);
      trimLocalDrafts(stores[LOCAL_DRAFTS], draft.projectId, removedIds);
      return {
        get result() {
          return {
            draft,
            removedIds
          };
        }
      };
    }
  );
  return cloneStoredValue(draft);
}

export async function restoreLocalDraft(currentProject, draftRecord, {
  now = Date.now(),
  id = null
} = {}) {
  const projectId = requiredProjectId(currentProject);
  if (!isLocalDraftRecord(draftRecord, projectId)) {
    throw new TypeError("이 프로젝트에서 불러올 수 있는 임시저장본이 아닙니다.");
  }
  const restoredProject = cloneStoredValue(draftRecord.project);
  if (requiredProjectId(restoredProject) !== projectId) {
    throw new TypeError("임시저장본의 프로젝트 ID가 현재 프로젝트와 다릅니다.");
  }
  const storedCurrentProject = cloneStoredValue(currentProject);
  const preRestoreDraft = createLocalDraftRecord(storedCurrentProject, {
    reason: "pre-restore",
    restoredFromDraftId: draftRecord.id,
    now,
    id
  });
  const removedIds = [];
  await transaction(
    [PROJECTS, LOCAL_DRAFTS],
    "readwrite",
    (stores) => {
      stores[PROJECTS].put(restoredProject);
      stores[LOCAL_DRAFTS].put(preRestoreDraft);
      trimLocalDrafts(stores[LOCAL_DRAFTS], projectId, removedIds);
      return {
        get result() {
          return {
            project: restoredProject,
            preRestoreDraft,
            removedIds
          };
        }
      };
    }
  );
  return {
    project: cloneStoredValue(restoredProject),
    preRestoreDraft: cloneStoredValue(preRestoreDraft)
  };
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
    [PROJECTS, LOCAL_DRAFTS, IMAGE_ASSETS],
    "readwrite",
    (stores) => {
      let count = 0;
      let pendingReferenceReads = 2;
      const keep = new Set(requestedKeep);
      const collectReferencedAssets = (candidateProject) => {
        for (const asset of candidateProject?.imageAssets || []) {
          if (asset?.source?.kind !== "blob-key") {
            continue;
          }
          const blobKey = String(asset.source.value || asset.id || "");
          if (blobKey) {
            keep.add(blobKey);
          }
        }
      };
      const scanImageAssetsAfterReferences = () => {
        pendingReferenceReads -= 1;
        if (pendingReferenceReads > 0) {
          return;
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

      const projectRequest = stores[PROJECTS].get(targetProjectId);
      projectRequest.onsuccess = () => {
        collectReferencedAssets(projectRequest.result);
        scanImageAssetsAfterReferences();
      };
      const draftsRequest = stores[LOCAL_DRAFTS]
        .index(LOCAL_DRAFT_PROJECT_INDEX)
        .getAll(targetProjectId);
      draftsRequest.onsuccess = () => {
        for (const draft of draftsRequest.result || []) {
          if (isLocalDraftRecord(draft, targetProjectId)) {
            collectReferencedAssets(draft.project);
          }
        }
        scanImageAssetsAfterReferences();
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
