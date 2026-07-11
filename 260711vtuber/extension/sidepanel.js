import {
  STORAGE_KEY,
  buildCodexJobManifest,
  compileCreatorPolicyMarkdown,
  createInitialState,
  createSegment,
  formatTimestamp,
  generateCodexStartHere,
  generateEditPrompt,
  normalizeState,
  parseTimestamp,
  resolveCreatorPolicies,
  sanitizeFileName,
  validateSegmentInput
} from "./lib/core.js";

const elements = {
  connectionBadge: document.querySelector("#connection-badge"),
  refreshSource: document.querySelector("#refresh-source"),
  sourceEmpty: document.querySelector("#source-empty"),
  sourceDetails: document.querySelector("#source-details"),
  sourceType: document.querySelector("#source-type"),
  playerPosition: document.querySelector("#player-position"),
  playerStatus: document.querySelector("#player-status"),
  streamerName: document.querySelector("#streamer-name"),
  broadcastTitle: document.querySelector("#broadcast-title"),
  sourceLink: document.querySelector("#source-link"),
  projectName: document.querySelector("#project-name"),
  globalInstruction: document.querySelector("#global-instruction"),
  captureCard: document.querySelector("#capture-card"),
  editingBadge: document.querySelector("#editing-badge"),
  startTime: document.querySelector("#start-time"),
  endTime: document.querySelector("#end-time"),
  captureStart: document.querySelector("#capture-start"),
  captureEnd: document.querySelector("#capture-end"),
  segmentDescription: document.querySelector("#segment-description"),
  descriptionCount: document.querySelector("#description-count"),
  saveSegment: document.querySelector("#save-segment"),
  cancelEdit: document.querySelector("#cancel-edit"),
  segmentCount: document.querySelector("#segment-count"),
  segmentsEmpty: document.querySelector("#segments-empty"),
  segmentsList: document.querySelector("#segments-list"),
  segmentTemplate: document.querySelector("#segment-template"),
  generatePrompt: document.querySelector("#generate-prompt"),
  createCodexJob: document.querySelector("#create-codex-job"),
  policyMatchBadge: document.querySelector("#policy-match-badge"),
  promptResult: document.querySelector("#prompt-result"),
  promptPreview: document.querySelector("#prompt-preview"),
  promptCharacterCount: document.querySelector("#prompt-character-count"),
  copyPrompt: document.querySelector("#copy-prompt"),
  downloadPrompt: document.querySelector("#download-prompt"),
  closePreview: document.querySelector("#close-preview"),
  resetProject: document.querySelector("#reset-project"),
  statusBar: document.querySelector("#status-bar")
};

let state = createInitialState();
let currentContext = null;
let sourceConflict = false;
let editingGuideMarkdown = "";
let creatorPolicyMarkdown = "";
let codexJobAgentsMarkdown = "";
let creatorPolicyIndex = { policies: [] };
let lastPrompt = "";
let saveTimer = null;
let statusTimer = null;
let refreshTimer = null;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function setStatus(message, type = "info", timeout = 4200) {
  clearTimeout(statusTimer);
  elements.statusBar.textContent = message;
  elements.statusBar.className = `status-bar ${type}`;
  elements.statusBar.hidden = false;
  if (timeout > 0) {
    statusTimer = setTimeout(() => {
      elements.statusBar.hidden = true;
    }, timeout);
  }
}

async function persistState() {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistState().catch((error) => setStatus(`저장 실패: ${error.message}`, "error"));
  }, 220);
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = normalizeState(stored[STORAGE_KEY]);
}

async function loadMarkdown(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`${path}를 불러오지 못했습니다 (${response.status}).`);
  }
  return response.text();
}

async function loadKnowledge() {
  const [editingGuide, basePolicy, codexAgents, policyIndexText] = await Promise.all([
    loadMarkdown("knowledge/base-editing-guidelines.md"),
    loadMarkdown("knowledge/default-creator-policy.md"),
    loadMarkdown("knowledge/codex-job-agents.md"),
    loadMarkdown("knowledge/creator-policy-index.json")
  ]);
  const parsedIndex = JSON.parse(policyIndexText);
  if (!Array.isArray(parsedIndex?.policies)) {
    throw new Error("방송인 정책 인덱스 형식이 올바르지 않습니다.");
  }

  editingGuideMarkdown = editingGuide;
  creatorPolicyMarkdown = basePolicy;
  codexJobAgentsMarkdown = codexAgents;
  creatorPolicyIndex = parsedIndex;
}

function currentPolicyBundle(streamerName = elements.streamerName.value.trim() || state.source.streamerName) {
  const resolvedPolicies = resolveCreatorPolicies({ streamerName }, creatorPolicyIndex);
  const compiledPolicyMarkdown = compileCreatorPolicyMarkdown({
    basePolicyMarkdown: creatorPolicyMarkdown,
    resolvedPolicies
  });
  return { resolvedPolicies, compiledPolicyMarkdown };
}

function renderPolicyMatch() {
  if (!elements.policyMatchBadge) {
    return;
  }
  const { resolvedPolicies } = currentPolicyBundle();
  if (resolvedPolicies.length === 0) {
    elements.policyMatchBadge.textContent = "기본 MD 적용";
    elements.policyMatchBadge.title = "등록된 방송인 정책과 정확히 일치하지 않았습니다.";
    return;
  }

  const policy = resolvedPolicies[0];
  elements.policyMatchBadge.textContent = `${policy.group} · 링크 매칭`;
  const cacheStatus = policy.cache?.extensionPath ? " · 선택 캐시 있음" : "";
  elements.policyMatchBadge.title = `${policy.matchedBy.value} → ${policy.sourceUrl}${cacheStatus}`;
}

function syncStateToForm() {
  elements.projectName.value = state.projectName;
  elements.globalInstruction.value = state.globalInstruction;
  elements.streamerName.value = state.source.streamerName;
  elements.broadcastTitle.value = state.source.broadcastTitle;
  renderDraft();
  renderPolicyMatch();
}

function syncDraftFromForm() {
  state.draft.startText = elements.startTime.value;
  state.draft.endText = elements.endTime.value;
  state.draft.description = elements.segmentDescription.value;
}

function renderDraft() {
  elements.startTime.value = state.draft.startText;
  elements.endTime.value = state.draft.endText;
  elements.segmentDescription.value = state.draft.description;
  elements.descriptionCount.textContent = String(state.draft.description.length);
  const editing = Boolean(state.draft.editingId);
  elements.editingBadge.hidden = !editing;
  elements.cancelEdit.hidden = !editing;
  elements.saveSegment.textContent = editing ? "구간 수정 저장" : "구간 저장";
}

function clearDraft() {
  state.draft = {
    startText: "",
    endText: "",
    description: "",
    startCapture: null,
    endCapture: null,
    editingId: null
  };
  renderDraft();
}

function sourceIdentity(source) {
  if (source.contentId) {
    return `${source.contentType}:${source.contentId}`;
  }
  if (source.channelId) {
    return `${source.contentType}:${source.channelId}`;
  }
  try {
    const url = new URL(source.canonicalUrl || source.url);
    return `${source.contentType}:${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

function contextAsSource(context) {
  return {
    platform: "CHZZK",
    url: context.url || "",
    canonicalUrl: context.canonicalUrl || context.url || "",
    channelId: context.channelId || "",
    contentId: context.contentId || "",
    contentType: context.contentType || "unknown",
    streamerName: context.streamerName || state.source.streamerName || "",
    broadcastTitle: context.broadcastTitle || context.pageTitle || state.source.broadcastTitle || "",
    broadcastStartedAt: context.broadcastStartedAt || "",
    clipActive: typeof context.clipActive === "boolean" ? context.clipActive : null,
    timeMachineActive: typeof context.timeMachineActive === "boolean" ? context.timeMachineActive : null,
    category: context.category || "",
    observedAt: context.capturedAt || new Date().toISOString()
  };
}

function applyContextToProject(context) {
  const nextSource = contextAsSource(context);
  const previousIdentity = sourceIdentity(state.source);
  const nextIdentity = sourceIdentity(nextSource);
  sourceConflict = Boolean(
    state.segments.length > 0 &&
    previousIdentity &&
    nextIdentity &&
    previousIdentity !== nextIdentity
  );

  if (!sourceConflict) {
    const preserveStreamer = state.source.streamerName;
    const preserveTitle = state.source.broadcastTitle;
    const sourceChanged = previousIdentity && nextIdentity && previousIdentity !== nextIdentity;
    state.source = {
      ...nextSource,
      streamerName: sourceChanged ? nextSource.streamerName : (preserveStreamer || nextSource.streamerName),
      broadcastTitle: sourceChanged ? nextSource.broadcastTitle : (preserveTitle || nextSource.broadcastTitle)
    };
    elements.streamerName.value = state.source.streamerName;
    elements.broadcastTitle.value = state.source.broadcastTitle;
    renderPolicyMatch();
    schedulePersist();
  }
}

function setConnectionBadge(text, variant) {
  elements.connectionBadge.textContent = text;
  elements.connectionBadge.className = `badge ${variant}`;
}

function renderSource() {
  const connected = Boolean(currentContext);
  elements.sourceEmpty.hidden = connected;
  elements.sourceDetails.hidden = !connected;

  if (!connected) {
    setConnectionBadge("미연결", "badge-muted");
    return;
  }

  const type = String(currentContext.contentType || "unknown").toUpperCase();
  elements.sourceType.textContent = type;
  elements.sourceType.className = `badge ${type === "LIVE" ? "badge-live" : "badge-vod"}`;

  const player = currentContext.player ?? {};
  elements.playerPosition.textContent = Number.isFinite(player.positionSeconds)
    ? formatTimestamp(player.positionSeconds)
    : "--:--:--";
  if (!player.found) {
    elements.playerStatus.textContent = "영상 플레이어 미검출";
  } else {
    const playback = player.paused ? "일시정지" : "재생 중";
    const liveEdge = Number.isFinite(player.liveEdgeOffsetSeconds)
      ? ` · 라이브 지연 ${player.liveEdgeOffsetSeconds.toFixed(1)}초`
      : "";
    const clipState = typeof currentContext.clipActive === "boolean"
      ? ` · 클립 ${currentContext.clipActive ? "허용" : "미허용"}`
      : "";
    elements.playerStatus.textContent = `${playback}${liveEdge}${clipState}`;
  }

  if (sourceConflict) {
    setConnectionBadge("다른 방송", "badge-policy");
    elements.playerStatus.textContent = "저장 구간과 다른 원본 · 초기화 후 기록 가능";
  } else {
    setConnectionBadge("연결됨", "badge-connected");
  }

  elements.sourceLink.href = currentContext.canonicalUrl || currentContext.url;
  elements.sourceLink.title = currentContext.canonicalUrl || currentContext.url;
}

async function getActiveChzzkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://chzzk.naver.com/")) {
    throw new Error("현재 활성 탭이 치지직 페이지가 아닙니다.");
  }
  return tab;
}

async function requestPageContext() {
  const tab = await getActiveChzzkTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "KIRINUKI_GET_CONTEXT" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
    await wait(40);
    response = await chrome.tabs.sendMessage(tab.id, { type: "KIRINUKI_GET_CONTEXT" });
  }

  if (!response?.ok) {
    throw new Error(response?.error || "치지직 페이지 정보를 읽지 못했습니다.");
  }
  return response.context;
}

async function refreshSource({ silent = false } = {}) {
  try {
    currentContext = await requestPageContext();
    applyContextToProject(currentContext);
    renderSource();
    if (!silent) {
      setStatus("현재 치지직 탭과 플레이어 정보를 읽었습니다.", "success");
    }
  } catch (error) {
    currentContext = null;
    sourceConflict = false;
    renderSource();
    if (!silent) {
      setStatus(error.message, "error");
    }
  }
}

async function captureCurrentPosition(kind) {
  const button = kind === "start" ? elements.captureStart : elements.captureEnd;
  button.disabled = true;
  try {
    const context = await requestPageContext();
    currentContext = context;
    applyContextToProject(context);
    renderSource();
    if (sourceConflict) {
      throw new Error("기존 구간과 다른 방송입니다. 프로젝트를 초기화한 뒤 기록해 주세요.");
    }

    const position = context.player?.positionSeconds;
    if (!Number.isFinite(position) || position < 0) {
      throw new Error("현재 플레이어 시각을 읽을 수 없습니다. 재생을 시작하거나 시각을 직접 입력해 주세요.");
    }

    const rounded = Math.round(position);
    const capture = {
      method: context.player.positionSource,
      confidence: context.player.confidence,
      rawSeconds: position,
      rawMediaSeconds: context.player.rawMediaPositionSeconds,
      observedAt: context.capturedAt,
      liveEdgeOffsetSeconds: context.player.liveEdgeOffsetSeconds,
      broadcastStartedAt: context.broadcastStartedAt,
      pageUrl: context.canonicalUrl || context.url
    };

    if (kind === "start") {
      state.draft.startText = formatTimestamp(rounded);
      state.draft.startCapture = capture;
    } else {
      state.draft.endText = formatTimestamp(rounded);
      state.draft.endCapture = capture;
    }
    renderDraft();
    await persistState();
    setStatus(`${kind === "start" ? "시작" : "끝"} 스탬프를 ${formatTimestamp(rounded)}로 기록했습니다.`, "success");
    if (kind === "end") {
      elements.segmentDescription.focus();
    }
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function captureOriginLabel(segment) {
  const start = segment.startCapture ? "현재 시각" : "직접 입력";
  const end = segment.endCapture ? "현재 시각" : "직접 입력";
  return `시작 ${start} · 끝 ${end}`;
}

function renderSegments() {
  elements.segmentCount.textContent = String(state.segments.length);
  elements.segmentsEmpty.hidden = state.segments.length > 0;
  elements.segmentsList.replaceChildren();

  state.segments.forEach((segment, index) => {
    const fragment = elements.segmentTemplate.content.cloneNode(true);
    const item = fragment.querySelector(".segment-item");
    item.dataset.id = segment.id;
    item.classList.toggle("is-editing", state.draft.editingId === segment.id);
    fragment.querySelector(".segment-number").textContent = String(index + 1);
    fragment.querySelector(".segment-time").textContent = `${formatTimestamp(segment.startSeconds)} → ${formatTimestamp(segment.endSeconds)}`;
    fragment.querySelector(".segment-duration").textContent = `${Math.round(segment.endSeconds - segment.startSeconds)}초`;
    fragment.querySelector(".segment-description").textContent = segment.description;
    fragment.querySelector(".segment-origin").textContent = captureOriginLabel(segment);

    const up = fragment.querySelector("[data-action='up']");
    const down = fragment.querySelector("[data-action='down']");
    up.disabled = index === 0;
    down.disabled = index === state.segments.length - 1;
    elements.segmentsList.append(fragment);
  });
}

async function saveSegment() {
  syncDraftFromForm();
  const validation = validateSegmentInput(state.draft);
  if (!validation.ok) {
    setStatus(validation.message, "error");
    return;
  }

  try {
    const editingIndex = state.draft.editingId
      ? state.segments.findIndex((segment) => segment.id === state.draft.editingId)
      : -1;
    const existing = editingIndex >= 0 ? state.segments[editingIndex] : null;
    const segment = createSegment({
      id: existing?.id,
      startText: state.draft.startText,
      endText: state.draft.endText,
      description: state.draft.description,
      startCapture: state.draft.startCapture,
      endCapture: state.draft.endCapture,
      createdAt: existing?.createdAt
    });
    segment.updatedAt = new Date().toISOString();

    if (editingIndex >= 0) {
      state.segments.splice(editingIndex, 1, segment);
    } else {
      state.segments.push(segment);
    }
    clearDraft();
    renderSegments();
    await persistState();
    setStatus(editingIndex >= 0 ? "구간을 수정했습니다." : "관심 구간을 저장했습니다.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function startEditingSegment(id) {
  const segment = state.segments.find((candidate) => candidate.id === id);
  if (!segment) {
    return;
  }
  state.draft = {
    startText: formatTimestamp(segment.startSeconds),
    endText: formatTimestamp(segment.endSeconds),
    description: segment.description,
    startCapture: segment.startCapture,
    endCapture: segment.endCapture,
    editingId: segment.id
  };
  renderDraft();
  renderSegments();
  schedulePersist();
  elements.captureCard.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.segmentDescription.focus({ preventScroll: true });
}

async function deleteSegment(id) {
  const index = state.segments.findIndex((segment) => segment.id === id);
  if (index < 0) {
    return;
  }
  if (!confirm(`구간 ${index + 1}을 삭제할까요?`)) {
    return;
  }
  state.segments.splice(index, 1);
  if (state.draft.editingId === id) {
    clearDraft();
  }
  renderSegments();
  await persistState();
  setStatus("구간을 삭제했습니다.", "success");
}

async function moveSegment(id, direction) {
  const index = state.segments.findIndex((segment) => segment.id === id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.segments.length) {
    return;
  }
  [state.segments[index], state.segments[nextIndex]] = [state.segments[nextIndex], state.segments[index]];
  renderSegments();
  await persistState();
}

function createPromptBundle(generatedAt = new Date().toISOString()) {
  state.projectName = elements.projectName.value.trim();
  state.globalInstruction = elements.globalInstruction.value.trim();
  state.source.streamerName = elements.streamerName.value.trim();
  state.source.broadcastTitle = elements.broadcastTitle.value.trim();

  if (!editingGuideMarkdown || !creatorPolicyMarkdown || !codexJobAgentsMarkdown) {
    throw new Error("내장 MD 지침을 불러오지 못했습니다. Extension을 다시 로드해 주세요.");
  }

  const policyBundle = currentPolicyBundle(state.source.streamerName);
  const prompt = generateEditPrompt({
    projectName: state.projectName,
    source: state.source,
    globalInstruction: state.globalInstruction,
    segments: state.segments,
    editingGuideMarkdown,
    creatorPolicyMarkdown: policyBundle.compiledPolicyMarkdown,
    resolvedCreatorPolicies: policyBundle.resolvedPolicies,
    generatedAt
  });
  return { prompt, ...policyBundle };
}

function createPrompt(generatedAt = new Date().toISOString()) {
  return createPromptBundle(generatedAt).prompt;
}

function showPrompt(prompt) {
  lastPrompt = prompt;
  elements.promptPreview.value = lastPrompt;
  elements.promptCharacterCount.textContent = lastPrompt.length.toLocaleString("ko-KR");
  elements.promptResult.hidden = false;
}

async function generatePrompt() {
  try {
    showPrompt(createPrompt());
    await persistState();
    setStatus("Codex용 uniform 프롬프트를 생성했습니다.", "success");
    elements.promptPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function writeTextFile(directoryHandle, fileName, contents) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function writePolicyCacheFiles(jobDirectory, resolvedPolicies) {
  const cachePolicies = resolvedPolicies.filter((policy) => policy.cache?.extensionPath);
  if (cachePolicies.length === 0) {
    return 0;
  }

  const cacheDirectory = await jobDirectory.getDirectoryHandle("policy-cache", { create: true });
  await Promise.all(cachePolicies.map(async (policy) => {
    const cacheContents = await loadMarkdown(policy.cache.extensionPath);
    const cacheFileName = policy.cache.jobPath?.split("/").filter(Boolean).at(-1) || `${policy.id}.md`;
    await writeTextFile(cacheDirectory, cacheFileName, cacheContents);
  }));
  return cachePolicies.length;
}

function codexJobFolderName(generatedAt) {
  const baseName = state.projectName || [state.source.streamerName, state.source.broadcastTitle].filter(Boolean).join("-");
  const compactTimestamp = generatedAt.replace(/\D/g, "").slice(0, 17);
  return `${sanitizeFileName(baseName, "chzzk-kirinuki-job")}-${compactTimestamp}`;
}

async function createCodexJobFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus("이 브라우저는 작업폴더 저장을 지원하지 않습니다. MD 다운로드를 사용해 주세요.", "error", 0);
    return;
  }

  const generatedAt = new Date().toISOString();
  let prompt;
  let manifest;
  let startHere;
  let compiledPolicyMarkdown;
  let resolvedPolicies = [];
  try {
    const promptBundle = createPromptBundle(generatedAt);
    prompt = promptBundle.prompt;
    compiledPolicyMarkdown = promptBundle.compiledPolicyMarkdown;
    resolvedPolicies = promptBundle.resolvedPolicies;
    manifest = buildCodexJobManifest({
      projectName: state.projectName,
      source: state.source,
      globalInstruction: state.globalInstruction,
      segments: state.segments,
      resolvedCreatorPolicies: promptBundle.resolvedPolicies,
      generatedAt
    });
    startHere = generateCodexStartHere({
      projectName: state.projectName,
      source: state.source,
      generatedAt
    });
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  let parentDirectory;
  try {
    parentDirectory = await window.showDirectoryPicker({
      id: "chzzk-kirinuki-codex-jobs",
      mode: "readwrite"
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus(`폴더를 열지 못했습니다: ${error.message}`, "error");
    }
    return;
  }

  elements.createCodexJob.disabled = true;
  try {
    const folderName = codexJobFolderName(generatedAt);
    const jobDirectory = await parentDirectory.getDirectoryHandle(folderName, { create: true });
    await Promise.all([
      writeTextFile(jobDirectory, "edit-brief.md", prompt),
      writeTextFile(jobDirectory, "creator-policy.md", compiledPolicyMarkdown),
      writeTextFile(jobDirectory, "creator-policy-index.json", `${JSON.stringify(creatorPolicyIndex, null, 2)}\n`),
      writeTextFile(jobDirectory, "AGENTS.md", codexJobAgentsMarkdown),
      writeTextFile(jobDirectory, "START_HERE.md", startHere),
      writeTextFile(jobDirectory, "job-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`)
    ]);
    const cacheCount = await writePolicyCacheFiles(jobDirectory, resolvedPolicies);
    showPrompt(prompt);
    await persistState();
    const cacheMessage = cacheCount > 0 ? ` 선택 정책 캐시 ${cacheCount}개도 별도 저장했습니다.` : "";
    setStatus(`${folderName} 작업폴더를 만들었습니다.${cacheMessage} 풀영상 하나를 넣고 START_HERE.md를 따라가세요.`, "success", 8_000);
  } catch (error) {
    setStatus(`작업폴더를 만들지 못했습니다: ${error.message}`, "error", 0);
  } finally {
    elements.createCodexJob.disabled = false;
  }
}

async function copyPrompt() {
  if (!lastPrompt) {
    return;
  }
  try {
    await navigator.clipboard.writeText(lastPrompt);
    setStatus("프롬프트를 클립보드에 복사했습니다.", "success");
  } catch (error) {
    setStatus(`복사하지 못했습니다: ${error.message}`, "error");
  }
}

function downloadPrompt() {
  if (!lastPrompt) {
    return;
  }
  const baseName = state.projectName || [state.source.streamerName, state.source.broadcastTitle].filter(Boolean).join("-");
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const fileName = `${sanitizeFileName(baseName)}-${date}.md`;
  const url = URL.createObjectURL(new Blob([lastPrompt], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  setStatus(`${fileName} 파일을 만들었습니다.`, "success");
}

async function resetProject() {
  if (!confirm("저장된 모든 구간과 프로젝트 설정을 초기화할까요?")) {
    return;
  }
  state = createInitialState();
  lastPrompt = "";
  elements.promptResult.hidden = true;
  elements.promptPreview.value = "";
  syncStateToForm();
  renderSegments();
  if (currentContext) {
    applyContextToProject(currentContext);
  }
  renderSource();
  await persistState();
  setStatus("프로젝트를 초기화했습니다.", "success");
}

function bindInputPersistence() {
  elements.projectName.addEventListener("input", () => {
    state.projectName = elements.projectName.value;
    schedulePersist();
  });
  elements.globalInstruction.addEventListener("input", () => {
    state.globalInstruction = elements.globalInstruction.value;
    schedulePersist();
  });
  elements.streamerName.addEventListener("input", () => {
    state.source.streamerName = elements.streamerName.value;
    renderPolicyMatch();
    schedulePersist();
  });
  elements.broadcastTitle.addEventListener("input", () => {
    state.source.broadcastTitle = elements.broadcastTitle.value;
    schedulePersist();
  });
  elements.startTime.addEventListener("input", () => {
    state.draft.startText = elements.startTime.value;
    if (state.draft.startCapture && parseTimestamp(elements.startTime.value) !== Math.round(state.draft.startCapture.rawSeconds)) {
      state.draft.startCapture = null;
    }
    schedulePersist();
  });
  elements.endTime.addEventListener("input", () => {
    state.draft.endText = elements.endTime.value;
    if (state.draft.endCapture && parseTimestamp(elements.endTime.value) !== Math.round(state.draft.endCapture.rawSeconds)) {
      state.draft.endCapture = null;
    }
    schedulePersist();
  });
  elements.segmentDescription.addEventListener("input", () => {
    state.draft.description = elements.segmentDescription.value;
    elements.descriptionCount.textContent = String(elements.segmentDescription.value.length);
    schedulePersist();
  });
}

function bindActions() {
  elements.refreshSource.addEventListener("click", () => void refreshSource());
  elements.captureStart.addEventListener("click", () => void captureCurrentPosition("start"));
  elements.captureEnd.addEventListener("click", () => void captureCurrentPosition("end"));
  elements.saveSegment.addEventListener("click", () => void saveSegment());
  elements.cancelEdit.addEventListener("click", () => {
    clearDraft();
    renderSegments();
    schedulePersist();
  });
  elements.segmentsList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const item = event.target.closest(".segment-item");
    if (!button || !item) {
      return;
    }
    const { id } = item.dataset;
    const action = button.dataset.action;
    if (action === "edit") {
      startEditingSegment(id);
    } else if (action === "delete") {
      void deleteSegment(id);
    } else if (action === "up") {
      void moveSegment(id, -1);
    } else if (action === "down") {
      void moveSegment(id, 1);
    }
  });
  elements.generatePrompt.addEventListener("click", () => void generatePrompt());
  elements.createCodexJob.addEventListener("click", () => void createCodexJobFolder());
  elements.copyPrompt.addEventListener("click", () => void copyPrompt());
  elements.downloadPrompt.addEventListener("click", downloadPrompt);
  elements.closePreview.addEventListener("click", () => {
    elements.promptResult.hidden = true;
  });
  elements.resetProject.addEventListener("click", () => void resetProject());
}

async function initialize() {
  bindInputPersistence();
  bindActions();
  try {
    await Promise.all([loadState(), loadKnowledge()]);
    syncStateToForm();
    renderSegments();
    renderSource();
    await refreshSource({ silent: true });
  } catch (error) {
    setStatus(`Extension 초기화 실패: ${error.message}`, "error", 0);
  }

  refreshTimer = setInterval(() => {
    if (!document.hidden) {
      void refreshSource({ silent: true });
    }
  }, 4_000);
}

window.addEventListener("beforeunload", () => {
  clearInterval(refreshTimer);
  clearTimeout(saveTimer);
  void persistState();
});

void initialize();
