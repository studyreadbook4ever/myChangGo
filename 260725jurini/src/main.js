import {
  createHelpQuery,
  serializeStructure,
  SCHEMA_VERSION,
} from "./schema.js";
import { createFeedbackService } from "./feedback.js";

const APP_VERSION = "1.0.0";
const RUNTIME_ENV = import.meta.env ?? {};
const FEEDBACK_ENDPOINT = RUNTIME_ENV.VITE_FEEDBACK_ENDPOINT ?? "";
const FEEDBACK_ISSUE_REPO =
  RUNTIME_ENV.VITE_FEEDBACK_ISSUE_REPO ?? "studyreadbook4ever/myChangGo";

const feedbackService = createFeedbackService({
  endpoint: FEEDBACK_ENDPOINT,
  issueRepo: FEEDBACK_ISSUE_REPO,
});

const state = {
  conditions: {
    zeroCost: false,
    fiveMinutes: false,
    expertise: false,
    local: false,
  },
  result: null,
  selectedVote: null,
  selectedReason: "",
  activeView: "prompt",
};

const elements = {
  form: document.querySelector("#chat-form"),
  targetInput: document.querySelector("#target-input"),
  targetTypeSelect: document.querySelector("#target-type-select"),
  contextInput: document.querySelector("#context-input"),
  chatLog: document.querySelector("#chat-log"),
  reset: document.querySelector("#reset-chat"),
  conditionButtons: [...document.querySelectorAll("[data-condition]")],
  exampleButtons: [...document.querySelectorAll("[data-example]")],
  emptyState: document.querySelector("#empty-state"),
  result: document.querySelector("#schema-result"),
  targetTypeBadge: document.querySelector("#target-type-badge"),
  targetSummary: document.querySelector("#target-summary"),
  contextSummary: document.querySelector("#context-summary"),
  promptOutput: document.querySelector("#prompt-output"),
  structureOutput: document.querySelector("#structure-output"),
  promptTab: document.querySelector("#prompt-tab"),
  structureTab: document.querySelector("#structure-tab"),
  promptPanel: document.querySelector("#prompt-panel"),
  structurePanel: document.querySelector("#structure-panel"),
  copy: document.querySelector("#copy-schema"),
  download: document.querySelector("#download-schema"),
  voteUp: document.querySelector("#vote-up"),
  voteDown: document.querySelector("#vote-down"),
  feedbackFollowup: document.querySelector("#feedback-followup"),
  feedbackQuestion: document.querySelector("#feedback-question"),
  reasonChips: document.querySelector("#reason-chips"),
  feedbackNote: document.querySelector("#feedback-note"),
  saveFeedback: document.querySelector("#save-feedback"),
  feedbackStatus: document.querySelector("#feedback-status"),
  githubFeedbackLink: document.querySelector("#github-feedback-link"),
  feedbackDisclosure: document.querySelector("#feedback-disclosure"),
  exportFeedback: document.querySelector("#export-feedback"),
  retryFeedback: document.querySelector("#retry-feedback"),
  deleteFeedback: document.querySelector("#delete-feedback"),
  pendingFeedback: document.querySelector("#pending-feedback"),
  toast: document.querySelector("#toast"),
};

const REASONS = {
  up: ["바로 쓸 수 있어요", "구조가 명확해요", "안전 규칙이 좋아요"],
  down: ["너무 일반적이에요", "대상 해석이 아쉬워요", "너무 길어요"],
};

function appendMessage(kind, text, detail = "") {
  const article = document.createElement("article");
  article.className = `message message-${kind}`;

  if (kind === "bot") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "도";
    article.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  body.append(paragraph);

  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    body.append(small);
  }

  article.append(body);
  elements.chatLog.append(article);
  elements.chatLog.scrollTo({
    top: elements.chatLog.scrollHeight,
    behavior: "smooth",
  });
}

function createResult(target) {
  const context = elements.contextInput.value;
  state.result = createHelpQuery({
    target,
    conditions: state.conditions,
    context,
    targetTypeOverride: elements.targetTypeSelect.value,
  });
  state.selectedVote = null;
  state.selectedReason = "";
  state.activeView = "prompt";

  appendMessage("user", target, context || "추가 조건 없음");
  if (state.result.targetType === "ambiguous") {
    appendMessage(
      "bot",
      "회사인지 업종인지 자동으로 단정하기 어려워요. 먼저 범위를 확인하도록 질문 스키마를 만들었습니다.",
      "대상 범위 선택기에서 직접 고친 뒤 다시 만들 수도 있어요.",
    );
  } else {
    appendMessage(
      "bot",
      `${state.result.targetTypeLabel} 대상으로 이해했어요. AI 답변 대신, 어느 LLM에나 붙여 넣을 수 있는 질문 스키마를 만들었습니다.`,
      "오른쪽에서 내용을 확인하고 복사할 수 있어요.",
    );
  }

  renderResult();
}

function renderResult() {
  const result = state.result;
  if (!result) return;

  elements.emptyState.hidden = true;
  elements.result.hidden = false;
  elements.targetTypeBadge.textContent = result.targetTypeLabel;
  elements.targetSummary.textContent = result.target;
  elements.contextSummary.textContent = result.userContext.join(" · ");
  elements.promptOutput.textContent = result.prompt;
  elements.structureOutput.textContent = serializeStructure(result.structure);
  setActiveView("prompt");
  resetFeedbackUi();

  elements.result.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
}

function setActiveView(view) {
  state.activeView = view;
  const promptActive = view === "prompt";
  elements.promptTab.setAttribute("aria-selected", String(promptActive));
  elements.structureTab.setAttribute("aria-selected", String(!promptActive));
  elements.promptTab.tabIndex = promptActive ? 0 : -1;
  elements.structureTab.tabIndex = promptActive ? -1 : 0;
  elements.promptPanel.hidden = !promptActive;
  elements.structurePanel.hidden = promptActive;
  elements.copy.querySelector("span").textContent = promptActive
    ? "프롬프트 복사"
    : "JSON 스키마 복사";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2200);
}

async function copyActiveSchema() {
  if (!state.result) return;
  const content =
    state.activeView === "prompt"
      ? state.result.prompt
      : serializeStructure(state.result.structure);

  try {
    await navigator.clipboard.writeText(content);
    showToast("클립보드에 복사했어요.");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("클립보드에 복사했어요.");
  }
}

function downloadSchema() {
  if (!state.result) return;
  const payload = JSON.stringify(
    {
      prompt: state.result.prompt,
      ...state.result.structure,
    },
    null,
    2,
  );
  downloadJson(payload, `${state.result.schemaId}.json`);
  showToast("스키마 파일을 저장했어요.");
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetFeedbackUi() {
  state.selectedVote = null;
  state.selectedReason = "";
  elements.voteUp.setAttribute("aria-pressed", "false");
  elements.voteDown.setAttribute("aria-pressed", "false");
  elements.feedbackFollowup.hidden = true;
  elements.feedbackNote.value = "";
  elements.feedbackStatus.textContent = "";
  elements.githubFeedbackLink.hidden = true;
  renderFeedbackDisclosure();
  renderReasons([]);
}

function renderFeedbackDisclosure() {
  elements.feedbackDisclosure.textContent = feedbackService.isEndpointConfigured
    ? "평가를 누르면 대상 원문·평가·한마디를 별도 수집기로 전송합니다. ‘내 상황 한 줄’과 전체 프롬프트는 보내지 않아요."
    : "GitHub 링크를 열면 평가·대상 유형·응답 ID가 GitHub로 전송됩니다. 대상 원문과 로컬에 저장한 한마디는 자동으로 넣지 않으며, 제출한 내용은 공개됩니다.";
  elements.feedbackDisclosure.hidden = false;
}

function localStorageMessage() {
  return feedbackService.getStorageStatus().persistent
    ? "이 기기에 저장했어요."
    : "브라우저 저장소를 쓸 수 없어 이 탭에만 임시 저장했어요.";
}

function selectVote(vote) {
  if (!state.result) return;
  state.selectedVote = vote;
  state.selectedReason = "";
  elements.voteUp.setAttribute("aria-pressed", String(vote === "up"));
  elements.voteDown.setAttribute("aria-pressed", String(vote === "down"));
  elements.feedbackFollowup.hidden = false;
  elements.feedbackQuestion.textContent =
    vote === "up"
      ? "어떤 점이 가장 좋았나요?"
      : "어떤 점을 먼저 고치면 좋을까요?";
  renderReasons(REASONS[vote]);

  const record = persistFeedback();
  elements.feedbackStatus.textContent = feedbackService.isEndpointConfigured
    ? `${localStorageMessage()} 수집기로 전송을 시도하고 있어요.`
    : `${localStorageMessage()} 운영자에게 보내려면 아래 GitHub 등록을 완료해주세요.`;
  updateGithubFallback(record);
  updatePendingCount();
  void tryFlushFeedback();
}

function renderReasons(reasons) {
  elements.reasonChips.replaceChildren(
    ...reasons.map((reason) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = reason;
      button.setAttribute("aria-pressed", String(state.selectedReason === reason));
      button.addEventListener("click", () => {
        state.selectedReason = state.selectedReason === reason ? "" : reason;
        renderReasons(reasons);
      });
      return button;
    }),
  );
}

function persistFeedback() {
  return feedbackService.saveVote({
    responseId: state.result.schemaId,
    vote: state.selectedVote,
    target: state.result.target,
    targetType: state.result.targetType,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    reason: state.selectedReason,
    note: elements.feedbackNote.value.trim(),
  });
}

async function saveFeedbackDetails() {
  if (!state.selectedVote || !state.result) return;
  const record = persistFeedback();
  updateGithubFallback(record);
  const flushResult = await tryFlushFeedback();

  elements.feedbackStatus.textContent =
    flushResult?.sent > 0
      ? "고마워요. 피드백을 수집함에 전송했어요."
      : feedbackService.isEndpointConfigured
        ? `고마워요. ${localStorageMessage()} 네트워크 연결 시 다시 전송할게요.`
        : `고마워요. ${localStorageMessage()} GitHub 등록을 완료하면 운영자에게 전달돼요.`;
  showToast("피드백을 저장했어요.");
}

function updateGithubFallback(record) {
  if (feedbackService.isEndpointConfigured) {
    elements.githubFeedbackLink.hidden = true;
    return;
  }

  elements.githubFeedbackLink.href = feedbackService.buildIssueUrl(record);
  elements.githubFeedbackLink.hidden = false;
  renderFeedbackDisclosure();
}

async function tryFlushFeedback() {
  const result = await feedbackService.flush();
  updatePendingCount();
  return result;
}

function updatePendingCount() {
  const count = feedbackService.pendingCount();
  elements.pendingFeedback.textContent = feedbackService.isEndpointConfigured
    ? `전송 대기 ${count}건`
    : `이 기기 보관 ${count}건`;
  elements.retryFeedback.hidden = !feedbackService.isEndpointConfigured;
}

function exportFeedback() {
  const payload = JSON.stringify(feedbackService.exportAll(), null, 2);
  downloadJson(payload, `help-query-feedback-${Date.now()}.json`);
  showToast("내 피드백을 JSON으로 저장했어요.");
}

async function retryFeedback() {
  const result = await tryFlushFeedback();
  const message =
    result.sent > 0
      ? `${result.sent}건을 전송했어요.`
      : result.pending > 0
        ? "아직 전송하지 못했어요. 이 기기에 계속 보관합니다."
        : "전송할 피드백이 없어요.";
  showToast(message);
}

function deleteFeedback() {
  if (feedbackService.readAll().length === 0) {
    showToast("삭제할 피드백이 없어요.");
    return;
  }

  if (!window.confirm("이 브라우저에 저장된 피드백을 모두 삭제할까요?")) return;
  feedbackService.clearAll();
  updatePendingCount();
  elements.feedbackStatus.textContent = "이 브라우저에 저장된 피드백을 삭제했어요.";
  showToast("내 피드백을 삭제했어요.");
}

function resetChat() {
  state.result = null;
  state.selectedVote = null;
  state.selectedReason = "";
  state.conditions = {
    zeroCost: false,
    fiveMinutes: false,
    expertise: false,
    local: false,
  };
  elements.targetInput.value = "";
  elements.targetTypeSelect.value = "auto";
  elements.contextInput.value = "";
  elements.conditionButtons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
  });
  elements.emptyState.hidden = false;
  elements.result.hidden = true;

  elements.chatLog.querySelectorAll(".message:not(:first-child)").forEach((node) => {
    node.remove();
  });
  elements.targetInput.focus();
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const target = elements.targetInput.value.trim();
  if (!target) return;
  createResult(target);
});

elements.exampleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    elements.targetInput.value = button.dataset.example;
    elements.targetInput.focus();
  });
});

elements.conditionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.condition;
    state.conditions[key] = !state.conditions[key];
    button.setAttribute("aria-pressed", String(state.conditions[key]));
  });
});

elements.promptTab.addEventListener("click", () => setActiveView("prompt"));
elements.structureTab.addEventListener("click", () => setActiveView("structure"));
[elements.promptTab, elements.structureTab].forEach((tab) => {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const nextView = state.activeView === "prompt" ? "structure" : "prompt";
    setActiveView(nextView);
    (nextView === "prompt" ? elements.promptTab : elements.structureTab).focus();
  });
});
elements.copy.addEventListener("click", copyActiveSchema);
elements.download.addEventListener("click", downloadSchema);
elements.voteUp.addEventListener("click", () => selectVote("up"));
elements.voteDown.addEventListener("click", () => selectVote("down"));
elements.saveFeedback.addEventListener("click", saveFeedbackDetails);
elements.exportFeedback.addEventListener("click", exportFeedback);
elements.retryFeedback.addEventListener("click", retryFeedback);
elements.deleteFeedback.addEventListener("click", deleteFeedback);
elements.githubFeedbackLink.addEventListener("click", () => {
  elements.feedbackStatus.textContent =
    "GitHub 탭에서 ‘Submit new issue’를 눌러야 운영자에게 전달돼요.";
});
elements.reset.addEventListener("click", resetChat);

window.addEventListener("online", () => {
  if (feedbackService.isEndpointConfigured) void tryFlushFeedback();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void tryFlushFeedback();
});

updatePendingCount();
void tryFlushFeedback();
