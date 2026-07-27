import {
  STORAGE_KEY,
  WORKSPACE_META_KEY,
  createInitialState,
  normalizeWorkspaceMeta
} from "./lib/core.js";
import {
  EDITOR_DATABASE_NAME,
  EDITOR_SEED_PREFIX,
  sourceSessionIdentity
} from "./lib/editor-core.js";

const BINDINGS_KEY = "chzzkKirinukiSourceBindingsV1";
let workspaceOperationQueue = Promise.resolve();

function queueWorkspaceOperation(operation) {
  const result = workspaceOperationQueue.then(operation, operation);
  workspaceOperationQueue = result.catch(() => {});
  return result;
}

const enableActionSidePanel = async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("사이드패널 동작을 설정하지 못했습니다.", error);
  }
};

async function readBindings() {
  const stored = await chrome.storage.session.get(BINDINGS_KEY);
  return stored[BINDINGS_KEY] && typeof stored[BINDINGS_KEY] === "object"
    ? stored[BINDINGS_KEY]
    : {};
}

async function writeBindings(bindings) {
  await chrome.storage.session.set({ [BINDINGS_KEY]: bindings });
}

async function readWorkspaceMeta() {
  const stored = await chrome.storage.local.get(WORKSPACE_META_KEY);
  return normalizeWorkspaceMeta(stored[WORKSPACE_META_KEY]);
}

function workspaceConflict(message, workspaceMeta) {
  const error = new Error(message);
  error.name = "WorkspaceConflictError";
  error.workspaceMeta = workspaceMeta;
  return error;
}

async function assertWorkspaceVersion(message) {
  const workspaceMeta = await readWorkspaceMeta();
  if (
    message.expectedResetEpoch !== workspaceMeta.resetEpoch ||
    message.expectedRevision !== workspaceMeta.revision
  ) {
    throw workspaceConflict(
      "다른 창에서 프로젝트가 변경되었습니다. 최신 상태를 반영한 뒤 다시 시도해 주세요.",
      workspaceMeta
    );
  }
  return workspaceMeta;
}

async function persistWorkspaceState(message) {
  if (!message.state || typeof message.state !== "object" || !message.writerId) {
    throw new Error("저장할 프로젝트 정보가 올바르지 않습니다.");
  }
  const currentMeta = await assertWorkspaceVersion(message);
  const workspaceMeta = {
    resetEpoch: currentMeta.resetEpoch,
    revision: currentMeta.revision + 1,
    writerId: message.writerId
  };
  await chrome.storage.local.set({
    [STORAGE_KEY]: message.state,
    [WORKSPACE_META_KEY]: workspaceMeta
  });
  return workspaceMeta;
}

async function bindProjectToSource(projectId, sourceTabId, captureState) {
  const bindings = await readBindings();
  bindings[projectId] = {
    projectId,
    sourceTabId,
    sourceIdentity: captureState?.source || null,
    sourceSessionId: sourceSessionIdentity(captureState?.source),
    boundAt: new Date().toISOString()
  };
  await writeBindings(bindings);
}

async function sourceBinding(projectId) {
  const bindings = await readBindings();
  return bindings[projectId] || null;
}

async function sourceTabExists(binding) {
  if (!binding?.sourceTabId) {
    return false;
  }
  try {
    const tab = await chrome.tabs.get(binding.sourceTabId);
    if (!tab?.url?.startsWith("https://chzzk.naver.com/")) {
      return false;
    }
    const response = await chrome.tabs.sendMessage(binding.sourceTabId, {
      type: "KIRINUKI_GET_CONTEXT"
    });
    if (!response?.ok) {
      return false;
    }
    const expectedSessionId = binding.sourceSessionId
      || sourceSessionIdentity(binding.sourceIdentity);
    const activeSessionId = sourceSessionIdentity(response.context);
    return Boolean(
      expectedSessionId &&
      activeSessionId &&
      expectedSessionId === activeSessionId
    );
  } catch {
    return false;
  }
}

async function openEditor(message) {
  const { projectId, sourceTabId, captureState } = message;
  if (!projectId || !Number.isInteger(sourceTabId) || !captureState) {
    throw new Error("편집기 전달 정보가 올바르지 않습니다.");
  }
  await assertWorkspaceVersion(message);
  if (!(await sourceTabExists({
    sourceTabId,
    sourceIdentity: captureState.source,
    sourceSessionId: sourceSessionIdentity(captureState.source)
  }))) {
    throw new Error("저장 구간과 연결할 치지직 탭의 방송 회차가 다릅니다.");
  }
  await Promise.all([
    bindProjectToSource(projectId, sourceTabId, captureState),
    chrome.storage.local.set({
      [`${EDITOR_SEED_PREFIX}${projectId}`]: {
        projectId,
        captureState,
        updatedAt: new Date().toISOString()
      }
    })
  ]);

  const editorUrl = chrome.runtime.getURL(`editor.html?project=${encodeURIComponent(projectId)}`);
  const editorRoot = chrome.runtime.getURL("editor.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url?.startsWith(editorRoot) && new URL(tab.url).searchParams.get("project") === projectId);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await chrome.runtime.sendMessage({
      type: "KIRINUKI_CAPTURE_SEED_UPDATED",
      projectId,
      captureState
    }).catch(() => {});
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: editorUrl, active: true });
  return created.id;
}

async function closeEditorTabs() {
  const editorRoot = chrome.runtime.getURL("editor.html");
  const tabs = await chrome.tabs.query({});
  const editorTabIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && tab.url?.startsWith(editorRoot))
    .map((tab) => tab.id);
  if (editorTabIds.length > 0) {
    await chrome.tabs.remove(editorTabIds);
  }
}

async function deleteEditorDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(EDITOR_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("편집기 저장소를 삭제하지 못했습니다."));
    request.onblocked = () => reject(new Error("열려 있는 편집기가 저장소 정리를 막고 있습니다."));
  });
}

async function resetWorkspace(message) {
  if (!message.writerId) {
    throw new Error("초기화 요청 정보가 올바르지 않습니다.");
  }
  const currentMeta = await readWorkspaceMeta();
  const workspaceMeta = {
    resetEpoch: crypto.randomUUID(),
    revision: currentMeta.revision + 1,
    writerId: message.writerId
  };
  const state = createInitialState();

  await chrome.storage.local.set({
    [STORAGE_KEY]: state,
    [WORKSPACE_META_KEY]: workspaceMeta
  });
  const cleanupErrors = [];
  try {
    await writeBindings({});
  } catch (error) {
    cleanupErrors.push(`치지직 탭 연결: ${error.message}`);
  }
  try {
    const stored = await chrome.storage.local.get(null);
    const seedKeys = Object.keys(stored).filter((key) => key.startsWith(EDITOR_SEED_PREFIX));
    if (seedKeys.length > 0) {
      await chrome.storage.local.remove(seedKeys);
    }
  } catch (error) {
    cleanupErrors.push(`편집기 전달 데이터: ${error.message}`);
  }
  try {
    await closeEditorTabs();
  } catch (error) {
    cleanupErrors.push(`열린 편집기 탭: ${error.message}`);
  }
  try {
    await deleteEditorDatabase();
  } catch (error) {
    cleanupErrors.push(`편집 프로젝트 저장소: ${error.message}`);
  }

  return { state, workspaceMeta, cleanupErrors };
}

async function runSourceAction(message) {
  const binding = await sourceBinding(message.projectId);
  if (!(await sourceTabExists(binding))) {
    throw new Error("연결했던 치지직 탭이 닫혔습니다. 치지직에서 프로젝트를 다시 열어 주세요.");
  }
  if (message.action === "seek-and-focus" && Number.isFinite(message.sourceSeconds)) {
    const response = await chrome.tabs.sendMessage(binding.sourceTabId, {
      type: "KIRINUKI_PLAYER_COMMAND",
      action: "seek",
      positionSeconds: message.sourceSeconds
    });
    if (!response?.ok) {
      throw new Error(response?.error || "치지직 플레이어 위치를 옮기지 못했습니다.");
    }
  }
  const tab = await chrome.tabs.update(binding.sourceTabId, { active: true });
  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

chrome.runtime.onInstalled.addListener(enableActionSidePanel);
chrome.runtime.onStartup.addListener(enableActionSidePanel);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "KIRINUKI_OPEN_EDITOR") {
    void queueWorkspaceOperation(() => openEditor(message))
      .then((editorTabId) => sendResponse({ ok: true, editorTabId }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message,
        workspaceMeta: error.workspaceMeta
      }));
    return true;
  }

  if (message.type === "KIRINUKI_PERSIST_STATE") {
    void queueWorkspaceOperation(() => persistWorkspaceState(message))
      .then((workspaceMeta) => sendResponse({ ok: true, workspaceMeta }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message,
        workspaceMeta: error.workspaceMeta
      }));
    return true;
  }

  if (message.type === "KIRINUKI_EDITOR_READY") {
    void sourceBinding(message.projectId)
      .then(async (binding) => sendResponse({
        ok: true,
        connected: await sourceTabExists(binding)
      }))
      .catch((error) => sendResponse({ ok: false, connected: false, error: error.message }));
    return true;
  }

  if (message.type === "KIRINUKI_EDITOR_SOURCE_ACTION") {
    void runSourceAction(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "KIRINUKI_RESET_BINDINGS") {
    void queueWorkspaceOperation(() => resetWorkspace(message))
      .then(({ state, workspaceMeta, cleanupErrors }) => sendResponse({
        ok: true,
        state,
        workspaceMeta,
        cleanupErrors
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void queueWorkspaceOperation(async () => {
    const bindings = await readBindings();
    const affected = Object.values(bindings).filter((binding) => binding.sourceTabId === tabId);
    if (affected.length === 0) {
      return;
    }
    for (const binding of affected) {
      delete bindings[binding.projectId];
    }
    await writeBindings(bindings);
    await Promise.all(affected.map((binding) => chrome.runtime.sendMessage({
      type: "KIRINUKI_SOURCE_BINDING_STATUS",
      projectId: binding.projectId,
      connected: false
    }).catch(() => {})));
  }).catch((error) => console.error("치지직 탭 연결 정리 실패", error));
});

void enableActionSidePanel();
