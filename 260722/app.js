import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  createItem,
  formatRelativeTime,
  makeExportPayload,
  normalizeSnapshot,
  partitionItems,
} from "./logic.js";

const $ = (selector, root = document) => {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`필수 화면 요소를 찾지 못했습니다: ${selector}`);
  return element;
};

const dom = {
  captureForm: $("#captureForm"),
  thoughtInput: $("#thoughtInput"),
  characterCount: $("#characterCount"),
  thoughtField: $(".thought-field"),
  thoughtError: $("#thoughtError"),
  presetGroup: $("#presetGroup"),
  customTimeWrap: $("#customTimeWrap"),
  customTimeInput: $("#customTimeInput"),
  customTimeError: $("#customTimeError"),
  tonightPresetLabel: $("#tonightPresetLabel"),
  depositButton: $("#depositButton"),
  depositCard: $(".deposit-card"),
  corruptBanner: $("#corruptBanner"),
  corruptTitle: $("#corruptTitle"),
  corruptDescription: $("#corruptBanner p"),
  downloadRawButton: $("#downloadRawButton"),
  resetCorruptButton: $("#resetCorruptButton"),
  storageWarning: $("#storageWarning"),
  openStorageSettingsButton: $("#openStorageSettingsButton"),
  lockerBoard: $(".locker-board"),
  lockerTitle: $("#lockerTitle"),
  boardTools: $("#boardTools"),
  firstRunEmpty: $("#firstRunEmpty"),
  queueGrid: $(".queue-grid"),
  duePanel: $(".due-panel"),
  holdingPanel: $(".holding-panel"),
  dueList: $("#dueList"),
  holdingList: $("#holdingList"),
  doneList: $("#doneList"),
  doneDrawer: $("#doneDrawer"),
  searchEmpty: $("#searchEmpty"),
  searchInput: $("#searchInput"),
  clearSearchButton: $("#clearSearchButton"),
  trySampleButton: $("#trySampleButton"),
  dueCount: $("#dueCount"),
  holdingCount: $("#holdingCount"),
  doneCount: $("#doneCount"),
  dueBadge: $("#dueBadge"),
  holdingBadge: $("#holdingBadge"),
  doneSummaryCount: $("#doneSummaryCount"),
  openHelpButton: $("#openHelpButton"),
  helpDialog: $("#helpDialog"),
  openSettingsButton: $("#openSettingsButton"),
  settingsDialog: $("#settingsDialog"),
  exportButton: $("#exportButton"),
  importInput: $("#importInput"),
  openClearButton: $("#openClearButton"),
  importDialog: $("#importDialog"),
  importSummary: $("#importSummary"),
  mergeImportButton: $("#mergeImportButton"),
  replaceImportButton: $("#replaceImportButton"),
  clearDialog: $("#clearDialog"),
  clearDialogTitle: $("#clearDialog h2"),
  clearDialogDescription: $("#clearDialog p"),
  confirmClearButton: $("#confirmClearButton"),
  toast: $("#toast"),
  toastMessage: $("#toastMessage"),
  undoButton: $("#undoButton"),
  liveRegion: $("#liveRegion"),
  installButton: $("#installButton"),
  installSection: $("#installSection"),
  localBadge: $(".local-badge"),
  storageStatusTitle: $("#storageStatusTitle"),
  storageStatusDescription: $("#storageStatusDescription"),
};

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const state = {
  items: [],
  selectedPreset: "1h",
  query: "",
  corruptRaw: null,
  corruptMode: null,
  pendingImport: null,
  clearMode: "all",
  undoSnapshot: null,
  toastTimer: 0,
  installPrompt: null,
  dueIds: new Set(),
  hasRendered: false,
  storageAvailable: true,
  searchTimer: 0,
};

initialize();

function initialize() {
  bindEvents();
  setDefaultCustomTime();
  updateTonightPresetLabel();
  loadStoredItems();
  render();
  registerServiceWorker();
  window.setInterval(handleClockTick, 30_000);
}

function bindEvents() {
  dom.captureForm.addEventListener("submit", handleDeposit);
  dom.thoughtInput.addEventListener("input", handleThoughtInput);
  dom.presetGroup.addEventListener("change", handlePresetChange);
  dom.customTimeInput.addEventListener("input", clearCustomTimeError);
  dom.searchInput.addEventListener("input", () => {
    state.query = dom.searchInput.value;
    render();
    scheduleSearchAnnouncement();
  });
  dom.clearSearchButton.addEventListener("click", clearSearch);
  dom.trySampleButton.addEventListener("click", insertSample);
  dom.lockerBoard.addEventListener("click", handleTicketAction);

  dom.openHelpButton.addEventListener("click", () => dom.helpDialog.showModal());
  dom.openSettingsButton.addEventListener("click", () => dom.settingsDialog.showModal());
  dom.openStorageSettingsButton.addEventListener("click", () => dom.settingsDialog.showModal());
  dom.exportButton.addEventListener("click", exportItems);
  dom.importInput.addEventListener("change", handleImportFile);
  dom.openClearButton.addEventListener("click", () => openClearDialog("all"));
  dom.mergeImportButton.addEventListener("click", () => applyImport("merge"));
  dom.replaceImportButton.addEventListener("click", () => applyImport("replace"));
  dom.confirmClearButton.addEventListener("click", confirmClear);

  dom.downloadRawButton.addEventListener("click", downloadCorruptRaw);
  dom.resetCorruptButton.addEventListener("click", () =>
    openClearDialog(state.corruptMode === "fatal" ? "corrupt" : "repair"),
  );

  dom.undoButton.addEventListener("click", undoLastMutation);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeyboardShortcut);
  window.addEventListener("storage", handleStorageChange);
  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  dom.installButton.addEventListener("click", promptInstall);
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    dom.installButton.hidden = true;
    dom.installSection.hidden = true;
    showToast("앱 설치가 끝났어요.");
  });
}

function loadStoredItems() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    markStorageUnavailable();
    return;
  }
  if (raw === null) return;

  try {
    const decoded = JSON.parse(raw);
    if (
      !Array.isArray(decoded) &&
      (!decoded || typeof decoded !== "object" || !Array.isArray(decoded.items))
    ) {
      throw new TypeError("지원하지 않는 저장 형식");
    }

    const normalized = normalizeSnapshot(decoded);
    state.items = normalized.items;

    if (
      !Array.isArray(decoded) &&
      Number.isInteger(decoded.schemaVersion) &&
      decoded.schemaVersion > SCHEMA_VERSION
    ) {
      state.corruptRaw = raw;
      state.corruptMode = "future";
      return;
    }

    if (normalized.discarded > 0) {
      state.corruptRaw = raw;
      state.corruptMode = "partial";
    }
  } catch {
    state.corruptRaw = raw;
    state.corruptMode = "fatal";
  }
}

function persistItems() {
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    items: state.items,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    markStorageAvailable();
    return true;
  } catch {
    markStorageUnavailable();
    return false;
  }
}

function markStorageUnavailable() {
  state.storageAvailable = false;
  dom.localBadge.lastChild.textContent = " 이 탭에서만 유지";
  dom.localBadge.title = "브라우저가 로컬 저장을 차단했습니다";
  dom.storageWarning.hidden = false;
  dom.storageStatusTitle.textContent = "이 탭에서만 유지됩니다";
  dom.storageStatusDescription.textContent =
    "브라우저 저장이 차단되어 탭을 닫으면 내용이 사라질 수 있어요. 먼저 내보내기로 백업해 주세요.";
}

function markStorageAvailable() {
  state.storageAvailable = true;
  dom.localBadge.lastChild.textContent = " 이 브라우저에 저장";
  dom.localBadge.removeAttribute("title");
  dom.storageWarning.hidden = true;
  dom.storageStatusTitle.textContent = "이 브라우저에만 저장됩니다";
  dom.storageStatusDescription.textContent =
    "입력한 내용은 서버로 전송되지 않으며 브라우저 저장 공간에만 남아요.";
}

function handleThoughtInput() {
  const length = dom.thoughtInput.value.length;
  dom.characterCount.textContent = `${length} / 280`;
  if (dom.thoughtInput.value.trim()) {
    dom.thoughtInput.removeAttribute("aria-invalid");
    dom.thoughtError.hidden = true;
    dom.thoughtError.textContent = "";
  }
}

function handlePresetChange(event) {
  const input = event.target.closest('input[name="reviewPreset"]');
  if (!input) return;

  state.selectedPreset = input.value;
  for (const chip of dom.presetGroup.querySelectorAll(".time-chip")) {
    chip.classList.toggle("selected", chip.contains(input));
  }

  const isCustom = state.selectedPreset === "custom";
  dom.customTimeWrap.hidden = !isCustom;
  dom.customTimeInput.required = isCustom;
  if (!isCustom) {
    dom.customTimeInput.removeAttribute("aria-invalid");
    dom.customTimeError.hidden = true;
    dom.customTimeError.textContent = "";
  }
  if (isCustom) {
    setDefaultCustomTime();
    dom.customTimeInput.focus();
  }
}

function clearCustomTimeError() {
  const value = dom.customTimeInput.value;
  if (!value || new Date(value).getTime() <= Date.now()) return;
  dom.customTimeInput.removeAttribute("aria-invalid");
  dom.customTimeError.hidden = true;
  dom.customTimeError.textContent = "";
}

function updateTonightPresetLabel(now = new Date()) {
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  dom.tonightPresetLabel.textContent = tonight.getTime() < now.getTime() ? "내일 저녁" : "오늘 저녁";
}

function setDefaultCustomTime() {
  const now = new Date();
  const minimum = new Date(now.getTime() + 60_000);
  const suggested = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  dom.customTimeInput.min = toLocalInputValue(minimum);

  if (!dom.customTimeInput.value || new Date(dom.customTimeInput.value).getTime() <= now.getTime()) {
    dom.customTimeInput.value = toLocalInputValue(suggested);
  }
}

function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function handleDeposit(event) {
  event.preventDefault();
  if (state.corruptRaw !== null) {
    announce("저장 데이터를 먼저 점검해 주세요.");
    dom.corruptBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const text = dom.thoughtInput.value.trim();
  if (!text) {
    showInputError("맡겨둘 생각을 한 줄 적어 주세요.");
    return;
  }

  if (
    state.selectedPreset === "custom" &&
    (!dom.customTimeInput.value ||
      new Date(dom.customTimeInput.value).getTime() <= Date.now())
  ) {
    dom.customTimeInput.setAttribute("aria-invalid", "true");
    dom.customTimeError.textContent = "지금보다 뒤의 날짜와 시간을 골라 주세요.";
    dom.customTimeError.hidden = false;
    dom.customTimeInput.focus();
    return;
  }

  try {
    const item = createItem(
      text,
      state.selectedPreset,
      Date.now(),
      dom.customTimeInput.value,
    );
    commitItems([...state.items, item], "생각을 저장했어요.");
    dom.captureForm.reset();
    dom.characterCount.textContent = "0 / 280";
    dom.thoughtError.hidden = true;
    selectPreset("1h");
    animateDeposit();
    dom.thoughtInput.focus();
  } catch {
    showToast("생각을 저장하지 못했어요. 내용과 시간을 다시 확인해 주세요.");
  }
}

function showInputError(message) {
  dom.thoughtInput.setAttribute("aria-invalid", "true");
  dom.thoughtError.textContent = message;
  dom.thoughtError.hidden = false;
  dom.thoughtField.classList.remove("shake");
  void dom.thoughtField.offsetWidth;
  dom.thoughtField.classList.add("shake");
  dom.thoughtInput.focus();
}

function selectPreset(preset) {
  const input = dom.presetGroup.querySelector(`input[name="reviewPreset"][value="${preset}"]`);
  if (!input) return;
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function animateDeposit() {
  dom.depositCard.classList.remove("receiving");
  void dom.depositCard.offsetWidth;
  dom.depositCard.classList.add("receiving");
  window.setTimeout(() => dom.depositCard.classList.remove("receiving"), 520);
}

function handleTicketAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const ticket = button.closest("[data-item-id]");
  const id = ticket?.dataset.itemId;
  if (!id) return;

  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;

  const now = Date.now();
  switch (button.dataset.action) {
    case "complete":
      updateItem(id, { status: "done", doneAt: now }, "완료한 생각으로 옮겼어요.");
      break;
    case "snooze": {
      const minutes = Number(button.dataset.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      updateItem(
        id,
        { status: "holding", doneAt: null, reviewAt: now + minutes * 60_000 },
        minutes >= 24 * 60 ? "내일 다시 보여드릴게요." : "고른 시간 뒤에 다시 보여드릴게요.",
      );
      break;
    }
    case "due-now":
      updateItem(id, { status: "holding", doneAt: null, reviewAt: now }, "지금 볼 생각으로 옮겼어요.");
      break;
    case "reopen":
      updateItem(
        id,
        { status: "holding", doneAt: null, reviewAt: now + 10 * 60_000 },
        "다시 열었어요. 10분 뒤에 보여드릴게요.",
      );
      break;
    case "delete":
      commitItems(
        state.items.filter((candidate) => candidate.id !== id),
        "생각을 삭제했어요.",
      );
      break;
    default:
      return;
  }

  button.closest("details")?.removeAttribute("open");
  window.requestAnimationFrame(focusAfterTicketAction);
}

function focusAfterTicketAction() {
  const nextAction = dom.lockerBoard.querySelector(".ticket .primary-action");
  const target = nextAction || dom.lockerTitle;
  target.focus({ preventScroll: true });
}

function updateItem(id, patch, message) {
  const nextItems = state.items.map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  commitItems(nextItems, message);
}

function commitItems(nextItems, message, { undoable = true } = {}) {
  if (state.corruptRaw !== null) return;

  const previousItems = state.items.map((item) => ({ ...item }));
  state.items = normalizeSnapshot(nextItems).items;
  const wasSaved = persistItems();
  render();
  showToast(
    wasSaved ? message : "브라우저가 저장을 막아 이 탭을 닫으면 내용이 사라져요.",
    undoable ? previousItems : null,
  );
}

function undoLastMutation() {
  if (!state.undoSnapshot) return;
  if (state.corruptRaw !== null) {
    state.undoSnapshot = null;
    showToast("저장 데이터 복구를 마친 뒤 다시 시도해 주세요.", null);
    return;
  }
  const restoreItems = state.undoSnapshot;
  state.undoSnapshot = null;
  state.items = restoreItems.map((item) => ({ ...item }));
  const wasSaved = persistItems();
  render();
  showToast(
    wasSaved
      ? "방금 전 상태로 되돌렸어요."
      : "이 탭에서만 되돌렸어요. 브라우저 저장은 갱신하지 못했어요.",
    null,
  );
}

function render() {
  const now = Date.now();
  const all = partitionItems(state.items, now);
  const visible = partitionItems(state.items, now, state.query);
  const totalCount = all.due.length + all.holding.length + all.done.length;
  const visibleCount = visible.due.length + visible.holding.length + visible.done.length;
  const isSearching = state.query.trim().length > 0;
  const isFirstRun = totalCount === 0 && !isSearching;

  dom.dueCount.textContent = String(all.due.length);
  dom.holdingCount.textContent = String(all.holding.length);
  dom.doneCount.textContent = String(all.done.length);
  dom.dueBadge.textContent = `${visible.due.length}개`;
  dom.holdingBadge.textContent = `${visible.holding.length}개`;
  dom.doneSummaryCount.textContent = String(visible.done.length);

  renderTicketList(dom.dueList, visible.due, "due", now);
  renderTicketList(dom.holdingList, visible.holding, "holding", now);
  renderTicketList(dom.doneList, visible.done, "done", now);

  const hasNoSearchResult = isSearching && visibleCount === 0;
  const hasDue = visible.due.length > 0;
  const hasHolding = visible.holding.length > 0;
  const hasDone = visible.done.length > 0;

  dom.firstRunEmpty.hidden = !isFirstRun;
  dom.boardTools.hidden = totalCount === 0;
  dom.searchEmpty.hidden = !hasNoSearchResult;
  dom.queueGrid.hidden = isFirstRun || hasNoSearchResult || (!hasDue && !hasHolding);
  dom.doneDrawer.hidden = isFirstRun || hasNoSearchResult || !hasDone;
  dom.duePanel.hidden = !hasDue;
  dom.holdingPanel.hidden = !hasHolding;
  dom.queueGrid.classList.toggle("single-column", hasDue !== hasHolding);

  if ((isSearching && hasDone) || (!hasDue && !hasHolding && hasDone)) {
    dom.doneDrawer.open = true;
  }

  dom.corruptBanner.hidden = state.corruptRaw === null;
  dom.depositButton.disabled = state.corruptRaw !== null;
  dom.thoughtInput.disabled = state.corruptRaw !== null;
  renderRecoveryNotice();

  state.dueIds = new Set(all.due.map((item) => item.id));
  state.hasRendered = true;
}

function renderRecoveryNotice() {
  if (state.corruptRaw === null) return;

  if (state.corruptMode === "partial") {
    dom.corruptTitle.textContent = "일부 생각을 안전하게 읽지 못했어요.";
    dom.corruptDescription.textContent =
      `읽힌 ${state.items.length}개는 화면에 남겨뒀어요. 원본을 내려받거나 읽힌 항목만 남겨 복구할 수 있어요.`;
    dom.resetCorruptButton.textContent = "읽힌 항목으로 복구";
    return;
  }

  if (state.corruptMode === "future") {
    dom.corruptTitle.textContent = "더 새로운 버전에서 만든 보관함이에요.";
    dom.corruptDescription.textContent =
      "이 버전으로 덮어쓰면 새 형식의 정보가 사라질 수 있어요. 먼저 원본을 내려받아 주세요.";
    dom.resetCorruptButton.textContent = "현재 형식으로 복구";
    return;
  }

  dom.corruptTitle.textContent = "저장한 생각을 안전하게 읽지 못했어요.";
  dom.corruptDescription.textContent =
    "원본을 내려받은 뒤 보관소를 비우면 다시 사용할 수 있어요.";
  dom.resetCorruptButton.textContent = "비우고 계속";
}

function renderTicketList(container, items, section, now) {
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    fragment.append(createTicket(item, section, now, index));
  });
  container.replaceChildren(fragment);
}

function createTicket(item, section, now, index) {
  const listItem = document.createElement("li");
  listItem.className = "ticket";
  listItem.dataset.state = section;
  listItem.dataset.itemId = item.id;
  listItem.dataset.reviewAt = String(item.reviewAt);
  if (item.doneAt !== null) listItem.dataset.doneAt = String(item.doneAt);
  listItem.style.animationDelay = `${Math.min(index * 35, 175)}ms`;

  const main = document.createElement("div");
  main.className = "ticket-main";

  const top = document.createElement("div");
  top.className = "ticket-top";

  const stamp = document.createElement("span");
  stamp.className = "status-stamp";
  const statusPrefix = document.createElement("span");
  statusPrefix.className = "sr-only";
  statusPrefix.textContent = "상태: ";
  stamp.append(
    statusPrefix,
    section === "due" ? "지금 볼 생각" : section === "done" ? "완료" : "나중에 볼 생각",
  );

  top.append(stamp);

  const text = document.createElement("p");
  text.className = "ticket-text";
  text.id = `thought-${section}-${index}`;
  text.textContent = item.text;
  listItem.setAttribute("aria-labelledby", text.id);

  const meta = document.createElement("div");
  meta.className = "ticket-meta";

  const time = document.createElement("time");
  time.className = "ticket-time";
  const relative = document.createElement("strong");
  relative.className = "ticket-relative";
  const detail = document.createElement("span");
  detail.className = "ticket-date";

  if (section === "done") {
    time.dateTime = new Date(item.doneAt).toISOString();
    relative.textContent = formatCompletedTime(item.doneAt, now);
    detail.textContent = `${dateFormatter.format(item.doneAt)} 완료`;
  } else {
    time.dateTime = new Date(item.reviewAt).toISOString();
    relative.textContent =
      section === "due"
        ? `볼 시간이 ${formatRelativeTime(item.reviewAt, now)}`
        : `${formatRelativeTime(item.reviewAt, now)} 다시 보기`;
    detail.textContent = dateFormatter.format(item.reviewAt);
  }
  time.append(relative, detail);

  const created = document.createElement("time");
  created.className = "ticket-date";
  created.dateTime = new Date(item.createdAt).toISOString();
  created.textContent = `${dateFormatter.format(item.createdAt)} 저장`;
  meta.append(time, created);

  main.append(top, text, meta);

  const actions = document.createElement("div");
  actions.className = "ticket-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", `${shortContext(item.text)} 작업`);
  actions.append(...createTicketActions(section, item));
  if (state.corruptRaw !== null) {
    for (const button of actions.querySelectorAll("button[data-action]")) {
      button.disabled = true;
      button.title = "저장 데이터 복구를 마친 뒤 사용할 수 있어요";
    }
  }

  listItem.append(main, actions);
  return listItem;
}

function createTicketActions(section, item) {
  if (section === "done") {
    return [
      actionButton("다시 열기", "reopen", item, "primary-action"),
      actionButton("삭제", "delete", item, "delete-action"),
    ];
  }

  const primary = actionButton("완료", "complete", item, "primary-action");

  if (section === "holding") {
    return [
      primary,
      actionButton("지금 보기", "due-now", item),
      actionButton("삭제", "delete", item, "delete-action"),
    ];
  }

  return [
    primary,
    createSnoozeMenu(item),
    actionButton("삭제", "delete", item, "delete-action"),
  ];
}

function actionButton(label, action, item, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ticket-button ${className}`.trim();
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute("aria-label", `${label}: ${shortContext(item.text)}`);
  return button;
}

function createSnoozeMenu(item) {
  const details = document.createElement("details");
  details.className = "ticket-menu";

  const summary = document.createElement("summary");
  summary.textContent = "나중에 보기";
  summary.setAttribute("aria-label", `나중에 볼 시간 선택: ${shortContext(item.text)}`);

  const popover = document.createElement("div");
  popover.className = "ticket-menu-popover";
  popover.append(
    snoozeButton("10분 뒤", 10, item),
    snoozeButton("1시간 뒤", 60, item),
    snoozeButton("내일 이맘때", 24 * 60, item),
  );

  details.append(summary, popover);
  return details;
}

function snoozeButton(label, minutes, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "snooze";
  button.dataset.minutes = String(minutes);
  button.textContent = label;
  button.setAttribute("aria-label", `${label} 다시 보기: ${shortContext(item.text)}`);
  return button;
}

function shortContext(text) {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function formatCompletedTime(doneAt, now) {
  const label = formatRelativeTime(doneAt, now);
  if (label === "방금 지남" || label === "지금") return "방금 완료";
  return `${label.replace(" 지남", " 전")} 완료`;
}

function insertSample() {
  if (state.corruptRaw !== null) {
    dom.corruptBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  dom.thoughtInput.value = "집에 가면 화분 흙이 마르지 않았는지 보기";
  handleThoughtInput();
  dom.thoughtInput.focus();
  dom.thoughtInput.setSelectionRange(dom.thoughtInput.value.length, dom.thoughtInput.value.length);
  dom.captureForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearSearch() {
  dom.searchInput.value = "";
  state.query = "";
  render();
  dom.searchInput.focus();
  scheduleSearchAnnouncement();
}

function scheduleSearchAnnouncement() {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    const result = partitionItems(state.items, Date.now(), state.query);
    const count = result.due.length + result.holding.length + result.done.length;
    announce(state.query.trim() ? `검색 결과 ${count}개` : "검색을 지웠습니다.");
  }, 250);
}

function handleClockTick() {
  const now = Date.now();
  updateTonightPresetLabel(new Date(now));
  const nextDue = new Set(partitionItems(state.items, now).due.map((item) => item.id));
  const dueMembershipChanged =
    nextDue.size !== state.dueIds.size || [...nextDue].some((id) => !state.dueIds.has(id));
  const hasNewDue = [...nextDue].some((id) => !state.dueIds.has(id));

  if (dueMembershipChanged) {
    render();
  } else {
    refreshRelativeTimes(now);
  }

  if (state.hasRendered && hasNewDue) {
    showToast("지금 볼 시간이 된 생각이 있어요.");
  }
}

function refreshRelativeTimes(now) {
  for (const ticket of document.querySelectorAll(".ticket[data-state]")) {
    const relative = ticket.querySelector(".ticket-relative");
    if (!relative) continue;

    if (ticket.dataset.state === "done") {
      relative.textContent = formatCompletedTime(Number(ticket.dataset.doneAt), now);
    } else {
      const reviewAt = Number(ticket.dataset.reviewAt);
      relative.textContent =
        ticket.dataset.state === "due"
          ? `볼 시간이 ${formatRelativeTime(reviewAt, now)}`
          : `${formatRelativeTime(reviewAt, now)} 다시 보기`;
    }
  }
}

function exportItems() {
  const payload = makeExportPayload(state.items, Date.now());
  const date = new Date();
  const filename = `jamkkan-matgimso-${formatLocalFileDate(date)}.json`;
  downloadBlob(JSON.stringify(payload, null, 2), filename, "application/json");
  showToast(`${state.items.length}개의 생각을 내보냈어요.`);
}

async function handleImportFile(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;

  try {
    const raw = await file.text();
    const decoded = JSON.parse(raw);
    if (
      !Array.isArray(decoded) &&
      (!decoded || typeof decoded !== "object" || !Array.isArray(decoded.items))
    ) {
      throw new TypeError("지원하지 않는 파일 형식");
    }

    const normalized = normalizeSnapshot(decoded);
    if (
      !Array.isArray(decoded) &&
      Number.isInteger(decoded.schemaVersion) &&
      decoded.schemaVersion > SCHEMA_VERSION
    ) {
      dom.settingsDialog.close();
      showToast("더 새로운 버전의 파일이라 안전하게 가져오지 않았어요.");
      return;
    }

    if (normalized.items.length === 0) {
      dom.settingsDialog.close();
      showToast("가져올 수 있는 생각이 하나도 없어요.");
      return;
    }

    state.pendingImport = normalized.items;
    dom.importSummary.textContent =
      state.corruptRaw !== null
        ? `${normalized.items.length}개의 생각을 확인했어요. 읽지 못한 현재 데이터를 이 파일로 교체할 수 있어요.`
        : normalized.discarded
          ? `${normalized.items.length}개는 읽었고, 손상되거나 중복된 ${normalized.discarded}개는 제외했어요.`
          : `${normalized.items.length}개의 생각을 확인했어요.`;
    dom.mergeImportButton.disabled =
      normalized.items.length === 0 || state.corruptRaw !== null;
    dom.replaceImportButton.disabled = false;
    dom.settingsDialog.close();
    dom.importDialog.showModal();
  } catch {
    if (dom.settingsDialog.open) dom.settingsDialog.close();
    showToast("읽을 수 있는 잠깐 맡김소 JSON 파일이 아니에요.");
  }
}

function applyImport(mode) {
  if (!state.pendingImport) return;
  if (state.corruptRaw !== null && mode === "merge") return;
  const wasRecovering = state.corruptRaw !== null;
  const imported = state.pendingImport;
  const nextItems =
    mode === "merge"
      ? normalizeSnapshot([...state.items, ...imported]).items
      : imported.map((item) => ({ ...item }));
  state.pendingImport = null;
  dom.importDialog.close();
  state.corruptRaw = null;
  state.corruptMode = null;
  commitItems(
    nextItems,
    mode === "merge"
      ? "가져온 생각을 현재 목록에 합쳤어요."
      : "파일 속 보관함으로 교체했어요.",
    { undoable: !wasRecovering },
  );
}

function openClearDialog(mode) {
  state.clearMode = mode;
  if (dom.settingsDialog.open) dom.settingsDialog.close();

  if (mode === "repair") {
    dom.clearDialogTitle.textContent = `읽힌 생각 ${state.items.length}개만 남길까요?`;
    dom.clearDialogDescription.textContent =
      "읽지 못한 항목과 새 형식의 정보는 제거됩니다. 계속하기 전에 원본을 내려받는 것을 권해요.";
    dom.confirmClearButton.textContent = "현재 형식으로 복구";
  } else if (mode === "corrupt") {
    dom.clearDialogTitle.textContent = "읽지 못한 저장 데이터를 지울까요?";
    dom.clearDialogDescription.textContent =
      "지우기 전에 원본을 내려받는 것을 권해요. 삭제 뒤에는 되돌릴 수 없습니다.";
    dom.confirmClearButton.textContent = "데이터 지우기";
  } else {
    dom.clearDialogTitle.textContent = "저장한 생각을 모두 지울까요?";
    dom.clearDialogDescription.textContent =
      "삭제 뒤에는 되돌릴 수 없어요. 필요하다면 먼저 내보내기로 백업해 주세요.";
    dom.confirmClearButton.textContent = "모두 지우기";
  }
  dom.clearDialog.showModal();
}

function confirmClear() {
  dom.clearDialog.close();
  if (state.clearMode === "repair") {
    const wasSaved = persistItems();
    if (wasSaved) {
      state.corruptRaw = null;
      state.corruptMode = null;
      render();
      showToast(`읽힌 생각 ${state.items.length}개로 목록을 복구했어요.`, null);
    } else {
      render();
      showToast("복구 내용을 저장하지 못했어요. 원본 데이터는 그대로 두었습니다.", null);
    }
    return;
  }

  if (state.clearMode === "corrupt") {
    try {
      localStorage.removeItem(STORAGE_KEY);
      markStorageAvailable();
      state.corruptRaw = null;
      state.corruptMode = null;
      state.items = [];
      state.query = "";
      dom.searchInput.value = "";
      render();
      showToast("읽지 못한 데이터를 지우고 새 보관소를 열었어요.", null);
      dom.thoughtInput.focus();
    } catch {
      markStorageUnavailable();
      render();
      showToast("브라우저가 삭제를 막아 원본 데이터를 그대로 두었어요.", null);
    }
    return;
  }

  const previousItems = state.items;
  state.items = [];
  const wasSaved = persistItems();
  if (!wasSaved) {
    state.items = previousItems;
    render();
    showToast("브라우저가 삭제를 막아 보관소를 그대로 두었어요.", null);
    return;
  }

  state.corruptRaw = null;
  state.corruptMode = null;
  state.query = "";
  dom.searchInput.value = "";
  render();
  showToast("보관소를 모두 비웠어요.", null);
}

function downloadCorruptRaw() {
  if (state.corruptRaw === null) return;
  downloadBlob(
    state.corruptRaw,
    `jamkkan-matgimso-recovery-${formatLocalFileDate(new Date())}.txt`,
    "text/plain",
  );
  showToast("읽지 못한 원본 데이터를 내려받았어요.");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatLocalFileDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function showToast(message, undoSnapshot) {
  window.clearTimeout(state.toastTimer);
  if (undoSnapshot !== undefined) {
    state.undoSnapshot = undoSnapshot;
  }
  dom.toastMessage.textContent = message;
  dom.undoButton.hidden = !state.undoSnapshot;
  dom.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
    state.undoSnapshot = null;
  }, 10_000);
}

function announce(message) {
  dom.liveRegion.textContent = "";
  window.setTimeout(() => {
    dom.liveRegion.textContent = message;
  }, 20);
}

function handleDocumentClick(event) {
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) {
    closeButton.closest("dialog")?.close();
  }

  const openMenu = document.querySelector(".ticket-menu[open]");
  if (openMenu && !openMenu.contains(event.target)) {
    openMenu.removeAttribute("open");
  }
}

function handleKeyboardShortcut(event) {
  if (event.isComposing) return;

  const active = document.activeElement;
  const openDialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  const isEditable =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active?.isContentEditable;

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    if (openDialog) return;
    if (dom.captureForm.contains(active) || dom.thoughtInput.value.trim()) {
      event.preventDefault();
      dom.captureForm.requestSubmit();
    }
    return;
  }

  if (event.key === "Escape") {
    if (openDialog) {
      event.preventDefault();
      openDialog.close();
    } else if (active === dom.thoughtInput) {
      dom.thoughtInput.blur();
      announce("입력한 내용은 그대로 두었습니다.");
    }
    return;
  }

  if (openDialog) return;
  if (isEditable || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key.toLocaleLowerCase() === "n") {
    event.preventDefault();
    dom.thoughtInput.focus();
    dom.thoughtInput.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (event.key === "/") {
    event.preventDefault();
    dom.searchInput.focus();
    dom.searchInput.select();
  }
}

function handleStorageChange(event) {
  if (event.key !== STORAGE_KEY) return;

  try {
    if (localStorage.getItem(STORAGE_KEY) !== event.newValue) return;
  } catch {
    markStorageUnavailable();
  }

  window.clearTimeout(state.toastTimer);
  state.undoSnapshot = null;
  dom.toast.hidden = true;

  if (event.newValue === null) {
    state.items = [];
    state.corruptRaw = null;
    state.corruptMode = null;
    render();
    showToast("다른 탭에서 보관소가 비워졌어요.", null);
    return;
  }

  try {
    const decoded = JSON.parse(event.newValue);
    if (
      !Array.isArray(decoded) &&
      (!decoded || typeof decoded !== "object" || !Array.isArray(decoded.items))
    ) {
      throw new TypeError("지원하지 않는 저장 형식");
    }

    const normalized = normalizeSnapshot(decoded);
    state.items = normalized.items;

    if (
      !Array.isArray(decoded) &&
      Number.isInteger(decoded.schemaVersion) &&
      decoded.schemaVersion > SCHEMA_VERSION
    ) {
      state.corruptRaw = event.newValue;
      state.corruptMode = "future";
      render();
      return;
    }

    if (normalized.discarded > 0) {
      state.corruptRaw = event.newValue;
      state.corruptMode = "partial";
      render();
      return;
    }

    state.corruptRaw = null;
    state.corruptMode = null;
    render();
    showToast("다른 탭의 변경 내용을 가져왔어요.", null);
  } catch {
    state.corruptRaw = event.newValue;
    state.corruptMode = "fatal";
    render();
  }
}

function handleBeforeInstallPrompt(event) {
  event.preventDefault();
  state.installPrompt = event;
  dom.installSection.hidden = false;
  dom.installButton.hidden = false;
}

async function promptInstall() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  dom.installButton.hidden = true;
  dom.installSection.hidden = true;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!["https:", "http:"].includes(window.location.protocol)) return;

  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch {
      // The core app remains fully usable when service workers are unavailable.
    }
  });
}
