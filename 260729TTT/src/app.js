import {
  analyzeBreakEven,
  analyzeConfounding,
  calculatePriceScenario,
  generateConfoundingData,
  linearRegression,
  optimizeIntegerAllocation,
  scoreAllocation,
} from "./model.js";

const STORAGE_KEY = "260729TTT-tour-v1";
const SVG_NS = "http://www.w3.org/2000/svg";
const EXHIBITS = [
  "entrance",
  "scarcity",
  "garden",
  "shadow",
  "mirror",
  "parallel",
  "measurement",
  "cockpit",
  "workshop",
  "exit",
];

const EXHIBIT_LABELS = {
  entrance: "축제 전날",
  scarcity: "부족함의 창고",
  garden: "조합의 정원",
  shadow: "보이지 않는 가격표",
  mirror: "데이터의 거울",
  parallel: "평행세계 실험실",
  measurement: "AI 측정실",
  cockpit: "함께 운전하는 조종실",
  workshop: "제로토큰 공방",
  exit: "출구 검표소",
};

const REQUIRED_BEFORE_EXIT = EXHIBITS.filter((exhibit) => exhibit !== "exit");

const ACTIVITY_META = [
  {
    id: "understanding",
    name: "이해",
    longName: "이해 돕기",
    color: "#b8432d",
    marginalValues: [18, 14, 11, 8, 6, 4],
  },
  {
    id: "verification",
    name: "검증",
    longName: "검증하기",
    color: "#0f766e",
    marginalValues: [16, 15, 12, 9, 5, 3],
  },
  {
    id: "experience",
    name: "체험",
    longName: "체험 만들기",
    color: "#d39b19",
    marginalValues: [13, 10, 8, 6, 4, 2],
  },
];

const GOALS = {
  balance: {
    label: "균형",
    weights: { understanding: 1, verification: 1, experience: 1 },
    explanation: "이해·검증·체험을 같은 무게로 봅니다.",
  },
  understanding: {
    label: "이해 우선",
    weights: { understanding: 1.45, verification: 1.05, experience: 0.9 },
    explanation: "이해 효과에 더 큰 점수를 줍니다.",
  },
  verification: {
    label: "검증 우선",
    weights: { understanding: 0.95, verification: 1.5, experience: 0.9 },
    explanation: "틀린 설명을 줄이는 검증 효과에 더 큰 점수를 줍니다.",
  },
};

const AUDIT_ITEMS = [
  {
    id: "shadow",
    text: "“이 전시의 이산 한계가치는 지금 자원 한 칸이 더 생길 때의 가치예요.”",
    agentLabel: "understood",
    truth: "understood",
  },
  {
    id: "cause",
    text: "“상관계수가 높으니 TT 사용이 점수의 원인으로 증명됐어요.”",
    agentLabel: "understood",
    truth: "confused",
  },
  {
    id: "objective",
    text: "“목표의 중요도를 바꾸면 최적 배분도 달라질 수 있어요.”",
    agentLabel: "understood",
    truth: "understood",
  },
  {
    id: "zero",
    text: "“제로토큰이면 전기와 검증 비용도 0인지 아직 헷갈려요.”",
    agentLabel: "confused",
    truth: "confused",
  },
];

const QUIZ = [
  {
    id: "constraint",
    question: "대피소 전기 8칸은 이 문제에서 무엇인가요?",
    options: [
      ["objective", "목적함수"],
      ["constraint", "제약조건"],
      ["cause", "인과효과"],
    ],
    correct: "constraint",
    explanation: "넘을 수 없는 전기 8칸은 제약조건입니다. 무엇을 최대화할지가 목적함수입니다.",
  },
  {
    id: "shadow",
    question: "전기 한 칸을 더 받았을 때 안전점수가 7점 늘었습니다. 7점은 무엇에 가장 가까운가요?",
    options: [
      ["market", "전기의 실제 시장가격"],
      ["shadow", "그림자가격에 대응하는 현재 배분 근처의 이산 한계가치"],
      ["average", "지금까지 쓴 전기의 평균효과"],
    ],
    correct: "shadow",
    explanation: "이 정수 사례의 7점은 고전적 그림자가격의 생각에 대응하는 다음 한 칸의 이산 한계가치입니다.",
  },
  {
    id: "causal",
    question: "휴대폰을 많이 충전한 사람이 구조 연락도 많이 받았습니다. 바로 말할 수 있는 것은?",
    options: [
      ["cause", "충전이 구조 연락의 원인이다"],
      ["relation", "두 값이 함께 움직였고, 원인은 더 조사해야 한다"],
      ["nothing", "데이터에서는 아무것도 배울 수 없다"],
    ],
    correct: "relation",
    explanation: "상관은 좋은 출발점이지만 원인 판정문은 아닙니다. 배터리 상태나 위치 같은 숨은 요인을 살펴야 합니다.",
  },
  {
    id: "counterfactual",
    question: "같은 사람에게 조명을 준 결과와 주지 않은 결과를 동시에 볼 수 없는 이유로 필요한 것은?",
    options: [
      ["comparison", "비교 가능한 집단과 연구설계"],
      ["more-ai", "더 큰 AI 모델"],
      ["price", "시장가격표"],
    ],
    correct: "comparison",
    explanation: "볼 수 없는 다른 세계, 즉 반사실을 대신할 비교집단이 필요합니다.",
  },
  {
    id: "agent",
    question: "AI가 대피소 배분안을 내놓았습니다. 사람의 가장 중요한 역할은?",
    options: [
      ["fast", "AI보다 더 빨리 다시 계산하기"],
      ["approve", "목표·가정·불확실성·되돌리기를 확인하고 승인하거나 거절하기"],
      ["obey", "점수가 가장 높으니 그대로 따르기"],
    ],
    correct: "approve",
    explanation: "계산 속도보다 가치와 책임이 핵심입니다. 사람은 충분한 정보와 중단권을 가져야 합니다.",
  },
  {
    id: "zero-token",
    question: "매일 같은 안전 점검이 충분히 검증됐다면 제로토큰 공방의 제안은?",
    options: [
      ["agent-always", "매번 LLM에게 처음부터 판단시킨다"],
      ["tool", "반복 규칙은 도구로 굳히고 낯선 예외만 에이전트에게 보낸다"],
      ["free", "아무 비용도 들지 않는다고 가정한다"],
    ],
    correct: "tool",
    explanation: "제로토큰은 런타임 LLM 호출을 줄이는 설계입니다. 일반 계산·개발·검증비는 남습니다.",
  },
];

const defaultState = {
  goal: "balance",
  budget: 8,
  allocation: { understanding: 0, verification: 0, experience: 0 },
  optPrediction: null,
  optimizerRun: false,
  shadowPrediction: null,
  shadowRevealed: false,
  confounding: 1,
  trueEffect: 0,
  readinessLens: false,
  experiment: null,
  auditChoices: {},
  approvalGates: [],
  proposalStatus: "pending",
  proposalRevised: false,
  runs: 30,
  price: {
    monthlyPrice: 30000,
    weeklyListValue: 100000,
    utilizationPercent: 50,
    assumedCostRatioPercent: 25,
  },
  quizAnswers: {},
  quizMastered: false,
  reflection: "",
  completed: {},
  docentDepth: "short",
  docentMuted: false,
  reduceMotion: false,
};

function safeStoredState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored || typeof stored !== "object") return {};
    return stored;
  } catch {
    return {};
  }
}

const stored = safeStoredState();
const state = {
  ...defaultState,
  ...stored,
  allocation: { ...defaultState.allocation, ...(stored.allocation ?? {}) },
  auditChoices: { ...(stored.auditChoices ?? {}) },
  price: { ...defaultState.price, ...(stored.price ?? {}) },
  quizAnswers: { ...(stored.quizAnswers ?? {}) },
  completed: { ...(stored.completed ?? {}) },
  approvalGates: Array.isArray(stored.approvalGates) ? stored.approvalGates : [],
};

let currentExhibit = "entrance";

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The museum remains usable when storage is unavailable.
  }
}

function markComplete(exhibit) {
  if (!EXHIBITS.includes(exhibit) || state.completed[exhibit]) return;
  state.completed[exhibit] = true;
  syncCertificateState();
  saveState();
  updateProgress();
}

function missingExhibits() {
  return REQUIRED_BEFORE_EXIT.filter((exhibit) => !state.completed[exhibit]);
}

function certificateIsReady() {
  return state.quizMastered && missingExhibits().length === 0;
}

function syncCertificateState({ scroll = false } = {}) {
  const certificate = document.querySelector("#certificate");
  if (!certificate) return false;
  const ready = certificateIsReady();
  certificate.hidden = !ready;
  if (ready) {
    state.completed.exit = true;
    const result = document.querySelector("#quiz-result");
    if (result) {
      result.className = "quiz-result is-success";
      result.textContent = "6 / 6 + 전시 9곳 체험. 새 상황에 개념을 옮겼습니다. 한 바퀴 이해 완료!";
    }
    if (scroll) {
      certificate.scrollIntoView({
        behavior: state.reduceMotion ? "auto" : "smooth",
        block: "center",
      });
    }
  } else {
    delete state.completed.exit;
  }
  return ready;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits }).format(value);
}

function formatWon(value) {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value)}원`;
}

function activitiesForGoal() {
  const weights = GOALS[state.goal]?.weights ?? GOALS.balance.weights;
  return ACTIVITY_META.map((activity) => ({
    ...activity,
    weight: weights[activity.id],
  }));
}

function currentOptimum() {
  return optimizeIntegerAllocation({
    budget: state.budget,
    activities: activitiesForGoal(),
  });
}

function allocationUsed() {
  return Object.values(state.allocation).reduce((sum, value) => sum + value, 0);
}

function trimAllocationToBudget() {
  const activities = activitiesForGoal();
  while (allocationUsed() > state.budget) {
    const removable = activities
      .filter((activity) => state.allocation[activity.id] > 0)
      .map((activity) => {
        const unit = state.allocation[activity.id] - 1;
        return {
          id: activity.id,
          value: activity.marginalValues[unit] * activity.weight,
        };
      })
      .sort((left, right) => left.value - right.value);
    if (removable.length === 0) break;
    state.allocation[removable[0].id] -= 1;
  }
}

function updateProgress() {
  const completed = EXHIBITS.filter((exhibit) => state.completed[exhibit]).length;
  document.querySelector("#progress-label").textContent = `${completed} / ${EXHIBITS.length} 관`;
  document.querySelector("#progress-bar").style.width = `${(completed / EXHIBITS.length) * 100}%`;
}

function setGoal(goal, resetProposal = true) {
  if (!GOALS[goal]) return;
  state.goal = goal;
  document.querySelector("#goal-explanation").textContent =
    `${GOALS[goal].label}을 골랐습니다. ${GOALS[goal].explanation} 이제 “가장 좋은 배분”도 이 점수판을 따릅니다.`;
  document.querySelector("#goal-change-note").innerHTML =
    `<strong>${GOALS[goal].label}</strong> 점수판을 쓰는 중입니다. 입구에서 성공의 뜻을 바꾸면 최적안도 함께 바뀝니다.`;
  if (resetProposal) {
    state.proposalStatus = "pending";
    state.approvalGates = [];
    state.proposalRevised = false;
  }
  renderAllocation();
  renderOptimizer();
  renderProposal();
  saveState();
  updateDocent();
}

function renderAllocation() {
  trimAllocationToBudget();
  const activities = activitiesForGoal();
  const used = allocationUsed();
  const score = scoreAllocation(activities, state.allocation);
  document.querySelector("#budget").value = String(state.budget);
  document.querySelector("#budget-output").textContent = `${state.budget}칸`;
  document.querySelector("#budget-status").textContent = `${used} / ${state.budget}칸 사용`;
  const usedBar = document.querySelector("#manual-used-bar");
  usedBar.style.width = `${Math.min(100, (used / state.budget) * 100)}%`;
  usedBar.classList.toggle("is-over", used > state.budget);

  activities.forEach((activity) => {
    const card = document.querySelector(`[data-activity="${activity.id}"]`);
    const amount = state.allocation[activity.id];
    card.querySelector('[data-role="amount"]').textContent = String(amount);
    const nextBase = activity.marginalValues[amount];
    card.querySelector('[data-role="next-value"]').textContent =
      nextBase === undefined ? "용량 끝" : `${formatNumber(nextBase * activity.weight)}점`;
    card.querySelector('[data-action="minus"]').disabled = amount === 0;
    card.querySelector('[data-action="plus"]').disabled =
      used >= state.budget || amount >= activity.marginalValues.length;
  });

  document.querySelector("#manual-score").textContent = `${formatNumber(score.totalValue)}점`;
  const feedback = document.querySelector("#manual-feedback");
  if (used < state.budget) {
    feedback.textContent = `${state.budget - used}칸이 남았습니다. 지금 높은 점수보다 “다음 한 칸 효과”를 보세요.`;
  } else {
    const optimum = currentOptimum();
    const gap = optimum.totalValue - score.totalValue;
    feedback.textContent =
      gap <= 1e-9
        ? "이 배분은 현재 목표에서 최적입니다!"
        : `같은 ${state.budget}칸으로 ${formatNumber(gap)}점을 더 얻는 조합이 숨어 있습니다.`;
    markComplete("scarcity");
  }
  saveState();
}

function enumerateCandidates(activities, budget) {
  const candidates = [];
  for (let first = 0; first <= Math.min(budget, activities[0].marginalValues.length); first += 1) {
    for (let second = 0; second <= Math.min(budget - first, activities[1].marginalValues.length); second += 1) {
      const third = budget - first - second;
      if (third < 0 || third > activities[2].marginalValues.length) continue;
      const allocations = {
        [activities[0].id]: first,
        [activities[1].id]: second,
        [activities[2].id]: third,
      };
      const scored = scoreAllocation(activities, allocations);
      candidates.push({ allocations, totalValue: scored.totalValue });
    }
  }
  return candidates.sort((left, right) => right.totalValue - left.totalValue).slice(0, 6);
}

function allocationLabel(allocations) {
  return ACTIVITY_META.map((activity) => `${activity.name} ${allocations[activity.id]}`).join(" · ");
}

function allocationBars(allocations) {
  const max = Math.max(1, ...Object.values(allocations));
  return ACTIVITY_META.map(
    (activity) => `
      <div>
        <span>${activity.name}</span>
        <i style="--bar-width:${(allocations[activity.id] / max) * 100}%;--bar-color:${activity.color}"></i>
        <b>${allocations[activity.id]}</b>
      </div>`,
  ).join("");
}

function renderOptimizer() {
  const container = document.querySelector("#optimizer-result");
  const garden = document.querySelector("#candidate-garden");
  if (!state.optimizerRun) {
    container.innerHTML = `
      <div class="closed-curtain" aria-hidden="true">
        <span></span><b>결과는 계산 뒤 열립니다</b><span></span>
      </div>`;
    garden.innerHTML = '<p class="empty-state">계산 버튼을 누르면 조합들이 꽃처럼 펼쳐집니다.</p>';
    return;
  }

  const activities = activitiesForGoal();
  const optimum = currentOptimum();
  const manual = scoreAllocation(activities, state.allocation);
  const isManualBest =
    allocationUsed() === state.budget && Math.abs(manual.totalValue - optimum.totalValue) < 1e-9;
  const predictionCorrect =
    state.optPrediction === null ||
    state.optPrediction === "unsure" ||
    (state.optPrediction === "mine" && isManualBest) ||
    (state.optPrediction === "other" && !isManualBest);

  container.innerHTML = `
    <div class="optimum-display">
      <div class="optimum-display__score">
        <span>${GOALS[state.goal].label}의 최적 점수</span>
        <strong>${formatNumber(optimum.totalValue)}점</strong>
      </div>
      <div class="allocation-visual">${allocationBars(optimum.allocations)}</div>
      <p>${allocationLabel(optimum.allocations)}</p>
      <p class="micro-copy">${
        predictionCorrect
          ? "예상과 결과를 잘 연결했습니다."
          : "예상과 달라도 괜찮습니다. 다음 한 칸 효과를 순서대로 고르면 이 조합이 나옵니다."
      }</p>
    </div>`;

  const candidates = enumerateCandidates(activities, state.budget);
  garden.innerHTML = candidates
    .map(
      (candidate, index) => `
        <article class="candidate-card ${index === 0 ? "is-best" : ""}">
          <small>${index === 0 ? "현재 목표의 최적" : `${index + 1}번째 조합`}</small>
          <strong>${formatNumber(candidate.totalValue)}점</strong>
          <p>${allocationLabel(candidate.allocations)}</p>
        </article>`,
    )
    .join("");
}

function revealOptimizer() {
  state.optimizerRun = true;
  markComplete("garden");
  renderOptimizer();
  renderProposal();
  saveState();
  updateDocent();
}

function nextAllocatedActivity() {
  const current = currentOptimum();
  const next = optimizeIntegerAllocation({
    budget: state.budget + 1,
    activities: activitiesForGoal(),
  });
  return ACTIVITY_META.find(
    (activity) => next.allocations[activity.id] > current.allocations[activity.id],
  );
}

function renderShadow() {
  const value = document.querySelector("#shadow-value");
  const result = document.querySelector("#shadow-result");
  if (!state.shadowRevealed) {
    value.textContent = "?";
    result.textContent = "아직 가격표가 어둠 속에 있습니다.";
    return;
  }
  const optimum = currentOptimum();
  const destination = nextAllocatedActivity();
  const predicted = state.shadowPrediction
    ? ACTIVITY_META.find((activity) => activity.id === state.shadowPrediction)
    : null;
  value.textContent = formatNumber(optimum.extraUnitValue);
  const predictionSentence =
    !predicted
      ? "먼저 예상하지 않았지만"
      : predicted.id === destination?.id
        ? `예상한 ${predicted.name}가 맞았고`
        : `예상은 ${predicted.name}였지만 실제로는 ${destination?.name}에 배분되어`;
  result.innerHTML = `
    ${predictionSentence}, 작업칸을 ${state.budget}개에서 ${state.budget + 1}개로 늘리면
    목표점수가 <strong>+${formatNumber(optimum.extraUnitValue)}점</strong> 좋아집니다.
    직전 한 칸의 가치는 ${formatNumber(optimum.previousUnitValue ?? 0)}점이었습니다.`;
}

function makeSvg(name, attributes = {}, text = "") {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text) element.textContent = text;
  return element;
}

function scale(value, min, max, start, end) {
  if (Math.abs(max - min) < 1e-9) return (start + end) / 2;
  return start + ((value - min) / (max - min)) * (end - start);
}

function renderScatterplot(svg, points, regression, labels) {
  const width = 480;
  const height = 300;
  const margin = { top: 18, right: 20, bottom: 42, left: 52 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xPadding = Math.max(0.8, (Math.max(...xs) - Math.min(...xs)) * 0.12);
  const yPadding = Math.max(1.5, (Math.max(...ys) - Math.min(...ys)) * 0.12);
  const xMin = Math.min(...xs) - xPadding;
  const xMax = Math.max(...xs) + xPadding;
  const yMin = Math.min(...ys) - yPadding;
  const yMax = Math.max(...ys) + yPadding;
  const xAt = (value) => scale(value, xMin, xMax, margin.left, width - margin.right);
  const yAt = (value) => scale(value, yMin, yMax, height - margin.bottom, margin.top);
  const labelledBy = (svg.getAttribute("aria-labelledby") ?? "").split(/\s+/);
  svg.replaceChildren();
  if (labelledBy[0]) {
    svg.append(makeSvg("title", { id: labelledBy[0] }, `${labels.x}와 ${labels.y}의 산점도`));
  }
  if (labelledBy[1]) {
    svg.append(makeSvg("desc", { id: labelledBy[1] }, `점 아홉 개와 평균 관계선입니다. 색은 원래 준비도 집단을 나타냅니다.`));
  }

  for (let step = 0; step <= 4; step += 1) {
    const x = margin.left + ((width - margin.left - margin.right) / 4) * step;
    const y = margin.top + ((height - margin.top - margin.bottom) / 4) * step;
    svg.append(makeSvg("line", { x1: x, y1: margin.top, x2: x, y2: height - margin.bottom, class: "gridline" }));
    svg.append(makeSvg("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: "gridline" }));
  }
  svg.append(makeSvg("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: "axis" }));
  svg.append(makeSvg("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, class: "axis" }));

  if (regression.slope !== null) {
    const leftY = regression.intercept + regression.slope * xMin;
    const rightY = regression.intercept + regression.slope * xMax;
    svg.append(makeSvg("line", {
      x1: xAt(xMin),
      y1: yAt(leftY),
      x2: xAt(xMax),
      y2: yAt(rightY),
      class: "trend",
    }));
  }

  points.forEach((point) => {
    const readinessClass =
      point.readiness < -1 ? "point--low" : point.readiness > 1 ? "point--high" : "point--medium";
    const circle = makeSvg("circle", {
      cx: xAt(point.x),
      cy: yAt(point.y),
      r: 8,
      class: `point ${readinessClass}`,
      tabindex: "0",
      role: "img",
      "aria-label": `${point.label}: ${labels.x} ${formatNumber(point.x)}, ${labels.y} ${formatNumber(point.y)}, 준비도 ${point.readinessLabel}`,
    });
    circle.append(makeSvg("title", {}, `${point.label} · 준비도 ${point.readinessLabel}`));
    svg.append(circle);
  });

  svg.append(makeSvg("text", { x: (margin.left + width - margin.right) / 2, y: height - 9, "text-anchor": "middle" }, labels.x));
  const yLabel = makeSvg("text", {
    x: 15,
    y: (margin.top + height - margin.bottom) / 2,
    transform: `rotate(-90 15 ${(margin.top + height - margin.bottom) / 2})`,
    "text-anchor": "middle",
  }, labels.y);
  svg.append(yLabel);
}

function renderConfounding() {
  const rows = generateConfoundingData({
    confounding: state.confounding,
    trueEffect: state.trueEffect,
  });
  const analysis = analyzeConfounding(rows);
  document.querySelector("#confounding").value = String(state.confounding * 100);
  document.querySelector("#confounding-output").textContent = `${Math.round(state.confounding * 100)}%`;
  document.querySelector(`input[name="true-effect"][value="${state.trueEffect}"]`).checked = true;

  renderScatterplot(
    document.querySelector("#raw-chart"),
    rows.map((row, index) => ({
      x: row.aiHours,
      y: row.score,
      readiness: row.readiness,
      readinessLabel: row.readinessLabel,
      label: `학생 ${index + 1}`,
    })),
    analysis.raw,
    { x: "TT 사용시간", y: "학습점수" },
  );
  const adjustedRegression = linearRegression(
    analysis.adjusted.xResiduals,
    analysis.adjusted.yResiduals,
  );
  renderScatterplot(
    document.querySelector("#adjusted-chart"),
    rows.map((row, index) => ({
      x: analysis.adjusted.xResiduals[index],
      y: analysis.adjusted.yResiduals[index],
      readiness: row.readiness,
      readinessLabel: row.readinessLabel,
      label: `학생 ${index + 1}`,
    })),
    adjustedRegression,
    { x: "준비도를 뺀 사용 차이", y: "준비도를 뺀 점수 차이" },
  );

  const rawCorrelation = analysis.raw.correlation ?? 0;
  const adjustedCorrelation = analysis.adjusted.correlation ?? 0;
  document.querySelector("#raw-badge").textContent = `상관 ${rawCorrelation >= 0 ? "+" : ""}${rawCorrelation.toFixed(2)}`;
  document.querySelector("#adjusted-badge").textContent = `통제 후 ${adjustedCorrelation >= 0 ? "+" : ""}${adjustedCorrelation.toFixed(2)}`;
  document.querySelector("#raw-summary").textContent =
    `그냥 비교하면 TT 1시간이 늘 때 점수가 평균 ${formatNumber(analysis.raw.slope ?? 0, 2)}점 높아 보입니다.`;
  document.querySelector("#adjusted-summary").textContent =
    `준비도 차이를 덜어내면 시간당 관계는 ${formatNumber(analysis.adjusted.slope ?? 0, 2)}점입니다.`;

  document.querySelector("#confounding-table").innerHTML = rows
    .map(
      (row, index) => `
        <tr>
          <td>학생 ${index + 1}</td>
          <td>${row.readinessLabel}</td>
          <td>${formatNumber(row.aiHours, 1)}시간</td>
          <td>${formatNumber(row.score, 1)}점</td>
        </tr>`,
    )
    .join("");

  const adjustedCard = document.querySelector(".chart-card--adjusted");
  adjustedCard.classList.toggle("is-locked", !state.readinessLens);
  adjustedCard.querySelectorAll("circle.point").forEach((point) => {
    point.setAttribute("tabindex", state.readinessLens ? "0" : "-1");
    if (state.readinessLens) point.removeAttribute("aria-hidden");
    else point.setAttribute("aria-hidden", "true");
  });
  const lensButton = document.querySelector("#toggle-readiness");
  lensButton.setAttribute("aria-pressed", String(state.readinessLens));
  lensButton.textContent = state.readinessLens ? "준비도 렌즈 끄기" : "준비도 렌즈 켜기";
  const answer = document.querySelector("#causal-answer");
  if (!state.readinessLens) {
    answer.innerHTML = "<strong>아직 말할 수 있는 것:</strong> 두 값이 함께 움직였다는 사실뿐입니다.";
  } else {
    answer.innerHTML = `
      <strong>이 장난감 세계에서는:</strong>
      준비도 렌즈 뒤 시간당 관계는 ${formatNumber(analysis.adjusted.slope ?? 0, 2)}점입니다.
      실제 효과를 ${state.trueEffect}점으로 심어 둔 결과와 같습니다. 현실에서는 숨은 요인을 모두 안다고 보장할 수 없습니다.`;
  }
}

function selectExperiment(kind) {
  if (!["self", "random"].includes(kind)) return;
  state.experiment = kind;
  document.querySelectorAll("[data-experiment]").forEach((button) => {
    const selected = button.dataset.experiment === kind;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const result = document.querySelector("#experiment-result");
  if (kind === "self") {
    result.innerHTML = `
      신청자 평균이 <strong>+6점</strong> 높았습니다. 하지만 원래 적극적인 학생이 신청했을 수 있어
      “힌트의 효과”와 “선택 차이”가 섞였습니다.`;
  } else {
    result.innerHTML = `
      제비뽑기 집단 차이는 <strong>약 +2점</strong>이었습니다. 두 집단을 출발점에서 비슷하게 만들어
      힌트의 평균 효과를 묻기 더 좋은 설계입니다. 우연한 흔들림과 가정은 여전히 남습니다.`;
    markComplete("parallel");
  }
  saveState();
  updateDocent();
}

function labelText(label) {
  return label === "understood" ? "이해함" : "아직 혼란";
}

function renderAudit() {
  const list = document.querySelector("#audit-list");
  list.innerHTML = AUDIT_ITEMS.map((item) => {
    const selected = state.auditChoices[item.id] ?? null;
    return `
      <article class="audit-item">
        <div>
          <p>${item.text}</p>
          <small>AI의 첫 라벨: ${labelText(item.agentLabel)}</small>
        </div>
        <div class="audit-choice" role="group" aria-label="이 문장의 사람 감사 라벨">
          <button type="button" data-audit-id="${item.id}" data-audit-label="understood" aria-pressed="${selected === "understood"}">이해함</button>
          <button type="button" data-audit-id="${item.id}" data-audit-label="confused" aria-pressed="${selected === "confused"}">아직 혼란</button>
        </div>
      </article>`;
  }).join("");

  const initialUnderstood = AUDIT_ITEMS.filter((item) => item.agentLabel === "understood").length;
  const effectiveLabels = AUDIT_ITEMS.map(
    (item) => state.auditChoices[item.id] ?? item.agentLabel,
  );
  const understood = effectiveLabels.filter((label) => label === "understood").length;
  const auditedCount = Object.keys(state.auditChoices).length;
  const correctCount = AUDIT_ITEMS.filter(
    (item) => state.auditChoices[item.id] === item.truth,
  ).length;
  document.querySelector("#ai-understanding-rate").textContent =
    `${Math.round((initialUnderstood / AUDIT_ITEMS.length) * 100)}%`;
  document.querySelector("#audited-understanding-rate").textContent =
    `${Math.round((understood / AUDIT_ITEMS.length) * 100)}%`;
  const summary = document.querySelector("#audit-summary");
  if (auditedCount < AUDIT_ITEMS.length) {
    summary.textContent = `${auditedCount} / ${AUDIT_ITEMS.length}개를 사람이 확인했습니다.`;
  } else if (correctCount === AUDIT_ITEMS.length) {
    summary.textContent = "검증표본 4개를 바르게 감사했습니다. 이 표본의 75%가 사람 확인 뒤 50%로 수정됐습니다.";
    markComplete("measurement");
  } else {
    summary.textContent = `${correctCount} / ${AUDIT_ITEMS.length}개가 문맥과 맞습니다. 자신 있게 틀린 문장을 다시 보세요.`;
  }
}

function setAuditChoice(id, label) {
  if (!AUDIT_ITEMS.some((item) => item.id === id) || !["understood", "confused"].includes(label)) return;
  state.auditChoices[id] = label;
  renderAudit();
  saveState();
  updateDocent();
}

function renderProposal() {
  const optimum = currentOptimum();
  const title = document.querySelector("#proposal-title");
  const body = document.querySelector("#proposal-body");
  title.textContent = `${GOALS[state.goal].label} 목표에 맞춘 ${state.budget}칸 배분`;
  body.textContent = state.proposalRevised
    ? `설명용 효과표 안에서 목표점수 ${formatNumber(optimum.totalValue)}점인 후보입니다. 실제 효과의 크기와 내일의 조건은 아직 모르므로, 현실의 최적안이라고 부를 수 없습니다.`
    : `설명용 효과표를 모두 비교해 목표점수 ${formatNumber(optimum.totalValue)}점인 후보를 찾았습니다. “현실의 정답”이 아니라 모의실행 후보입니다.`;
  document.querySelector("#proposal-allocation").innerHTML = ACTIVITY_META.map(
    (activity) => `<span>${activity.longName} ${optimum.allocations[activity.id]}칸</span>`,
  ).join("");
  document.querySelector("#proposal-evidence").textContent =
    `${GOALS[state.goal].label} 가중치, 설명용 한계효과표, 가능한 조합 전수 계산`;
  document.querySelector("#proposal-uncertainty").textContent = state.proposalRevised
    ? "가상 효과표이며 오차범위도 현장 변화도 측정하지 않음 · 1시간 시험 뒤 재추정 필요"
    : "실제 학생·현장 자료가 아닌 가상 모형";

  const status = document.querySelector("#proposal-status");
  status.className = "status-chip";
  if (state.proposalStatus === "approved") {
    status.textContent = "사람 승인 · 모의실행";
    status.classList.add("is-approved");
  } else if (state.proposalStatus === "rejected") {
    status.textContent = "사람이 반려함";
    status.classList.add("is-rejected");
  } else {
    status.textContent = state.proposalRevised ? "수정됨 · 승인 대기" : "사람 승인 대기";
  }

  document.querySelectorAll(".approval-gates input").forEach((checkbox) => {
    checkbox.checked = state.approvalGates.includes(checkbox.value);
  });
  document.querySelector("#approve-proposal").disabled =
    state.approvalGates.length !== 4 || state.proposalStatus === "rejected";

  const log = document.querySelector("#decision-log");
  if (state.proposalStatus === "approved") {
    log.innerHTML = `
      <strong>모의실행 기록:</strong> 사람이 네 질문을 확인한 뒤 1시간 시험 운영을 승인했습니다.
      실제 배포는 하지 않았고, 중단 가능한 실험 결과를 다음 추정에 돌려보냅니다.`;
  } else if (state.proposalStatus === "rejected") {
    log.innerHTML = `
      <strong>반려 기록:</strong> 질문과 목표를 다시 정하도록 루프를 되돌렸습니다.
      거절은 오류가 아니라 Agent in the Loop의 정상 경로입니다.`;
  } else if (state.proposalRevised) {
    log.innerHTML = `
      <strong>수정 기록:</strong> “최적 배분”을 “가상 효과표와 현재 목표 안의 최적 후보”로 낮춰 썼습니다.
      설명의 자신감도 검토 대상입니다.`;
  } else {
    log.textContent = "아직 실행되지 않았습니다. 승인하지 않는 것도 사람의 중요한 권한입니다.";
  }

  document.querySelectorAll(".agent-loop li").forEach((item, index) => {
    item.classList.toggle("is-complete", index < 3 || (state.proposalStatus === "approved" && index < 5));
    item.classList.toggle(
      "is-current",
      state.proposalStatus === "approved" ? index === 5 : index === 3,
    );
  });
}

function updateBreakEven() {
  const analysis = analyzeBreakEven({
    runs: state.runs,
    agentCostPerRun: 14,
    zeroBuildCost: 120,
    zeroRuntimeCostPerRun: 2,
  });
  document.querySelector("#runs").value = String(state.runs);
  document.querySelector("#runs-output").textContent = `${state.runs}회`;
  document.querySelector("#agent-total").textContent = formatNumber(analysis.agentTotal);
  document.querySelector("#tool-total").textContent = formatNumber(analysis.zeroTokenTotal);
  const max = Math.max(analysis.agentTotal, analysis.zeroTokenTotal, 1);
  document.querySelector("#agent-cost-bar").style.width = `${(analysis.agentTotal / max) * 100}%`;
  document.querySelector("#tool-cost-bar").style.width = `${(analysis.zeroTokenTotal / max) * 100}%`;
  const result = document.querySelector("#break-even-result");
  if (analysis.breakEvenRuns === null) {
    result.textContent = "이 가정에서는 도구 경로가 손익분기에 도달하지 않습니다.";
  } else if (analysis.winner === "tie") {
    result.textContent = `${analysis.breakEvenRuns}회에서 두 경로의 비용이 같습니다.`;
  } else if (analysis.winner === "zero-token") {
    result.textContent =
      `${analysis.breakEvenRuns}회부터 도구 경로가 같거나 더 저렴합니다. 지금은 ${formatNumber(analysis.savings)}단위를 아낍니다.`;
  } else {
    result.textContent =
      `아직은 매번 에이전트 경로가 ${formatNumber(-analysis.savings)}단위 저렴합니다. 반복이 늘면 고정 구축비를 나눠 가집니다.`;
  }
}

function updatePriceScenario() {
  const analysis = calculatePriceScenario(state.price);
  document.querySelector("#monthly-price").value = String(state.price.monthlyPrice);
  document.querySelector("#weekly-value").value = String(state.price.weeklyListValue);
  document.querySelector("#utilization").value = String(state.price.utilizationPercent);
  document.querySelector("#cost-ratio").value = String(state.price.assumedCostRatioPercent);
  document.querySelector("#utilization-output").textContent = `${state.price.utilizationPercent}%`;
  document.querySelector("#cost-ratio-output").textContent = `${state.price.assumedCostRatioPercent}%`;
  document.querySelector("#price-result").innerHTML = `
    한 달에 실제로 쓴 정가 환산 가치는 약 <strong>${formatWon(analysis.usedListValue)}</strong>,
    가정한 제공비용은 약 <strong>${formatWon(analysis.assumedServingCost)}</strong>입니다.
    구독료와의 차이는 원가의 증거가 아니라, 입력한 가정이 만든 시나리오입니다.`;
}

function renderQuiz() {
  const container = document.querySelector("#quiz-questions");
  container.innerHTML = QUIZ.map((question, index) => `
    <fieldset class="quiz-question" data-question="${question.id}">
      <legend><span>${String(index + 1).padStart(2, "0")}</span> ${question.question}</legend>
      <div class="quiz-options">
        ${question.options
          .map(
            ([value, label]) => `
              <label>
                <input type="radio" name="quiz-${question.id}" value="${value}" ${
                  state.quizAnswers[question.id] === value ? "checked" : ""
                } />
                <span>${label}</span>
              </label>`,
          )
          .join("")}
      </div>
      <p class="quiz-explanation" hidden></p>
    </fieldset>`,
  ).join("");
  syncCertificateState();
  document.querySelector("#reflection").value = state.reflection;
}

function checkQuiz(event) {
  event.preventDefault();
  let correct = 0;
  QUIZ.forEach((question) => {
    const checked = document.querySelector(`input[name="quiz-${question.id}"]:checked`);
    const answer = checked?.value ?? null;
    state.quizAnswers[question.id] = answer;
    const fieldset = document.querySelector(`[data-question="${question.id}"]`);
    const explanation = fieldset.querySelector(".quiz-explanation");
    const isCorrect = answer === question.correct;
    correct += isCorrect ? 1 : 0;
    fieldset.classList.toggle("is-correct", isCorrect);
    fieldset.classList.toggle("is-wrong", !isCorrect);
    explanation.hidden = false;
    explanation.textContent = isCorrect
      ? `맞았습니다. ${question.explanation}`
      : `다시 생각해 보기: ${question.explanation}`;
  });

  const result = document.querySelector("#quiz-result");
  state.quizMastered = correct === QUIZ.length;
  result.className = `quiz-result ${state.quizMastered ? "is-success" : "is-review"}`;
  if (state.quizMastered) {
    const missing = missingExhibits();
    if (missing.length === 0) {
      syncCertificateState({ scroll: true });
    } else {
      result.className = "quiz-result is-review";
      result.textContent =
        `6 / 6 이해 완료! 한 바퀴 도장은 아직 ${missing.map((id) => EXHIBIT_LABELS[id]).join(" · ")} 체험 뒤 열립니다.`;
      syncCertificateState();
    }
  } else {
    result.textContent = `${correct} / ${QUIZ.length}. 주황 테두리 문제의 다른 설명을 읽고 다시 검표하세요. 점수는 깎이지 않습니다.`;
    syncCertificateState();
  }
  saveState();
  updateDocent();
}

function docentMessages() {
  const optimum = currentOptimum();
  const used = allocationUsed();
  const analysis = analyzeConfounding(
    generateConfoundingData({ confounding: state.confounding, trueEffect: state.trueEffect }),
  );
  const auditCount = Object.keys(state.auditChoices).length;
  return {
    entrance: {
      short: `계산보다 먼저 “성공”의 뜻을 골랐어. 지금 점수판은 ${GOALS[state.goal].label}이야.`,
      analogy: "목적지는 내비게이션이 정하지 않아. 사람이 목적지를 고르면 계산은 길을 찾는 역할을 해.",
      deep: `목적함수는 가치판단을 숫자로 옮긴 장치야. ${GOALS[state.goal].label}을 바꾸면 같은 데이터에서도 최적해가 달라질 수 있어.`,
    },
    scarcity: {
      short: `${used}/${state.budget}칸을 썼어. 총점보다 각 카드의 “다음 칸 효과”를 비교해 봐.`,
      analogy: "피자 첫 조각은 배고픔을 크게 줄이지만 여섯 번째 조각은 덜해. 추가 한 칸의 효과도 그래.",
      deep: "결정변수는 세 활동의 칸 수, 제약은 합계 예산, 목적함수는 가중 한계효과의 합이야.",
    },
    garden: {
      short: state.optimizerRun
        ? `현재 목표의 최적안은 ${allocationLabel(optimum.allocations)}, ${formatNumber(optimum.totalValue)}점이야.`
        : "네 예상부터 남기고 모든 조합을 계산해 보자. 틀린 예상도 좋은 관찰 기록이야.",
      analogy: "정원 길을 전부 걸어 보고, 네가 정한 풍경 점수가 가장 높은 길을 표시하는 셈이야.",
      deep: "체감효과를 시간 조각별 활동으로 펼치면 작은 선형계획 문제로 볼 수 있어. 여기서는 가능한 정수 조합을 전부 검산해.",
    },
    shadow: {
      short: state.shadowRevealed
        ? `지금 다음 작업칸의 이산 한계가치는 +${formatNumber(optimum.extraUnitValue)}점이야.`
        : "한 칸을 늘리기 전에 어디로 갈지 예측해 봐. 이산 한계가치는 “다음 한 칸”의 가치야.",
      analogy: "매진된 공연의 보조의자 한 자리처럼, 지금 딱 하나 더 생겼을 때 얻는 가치라고 보면 돼.",
      deep: "고전 LP의 그림자가격을 닮은 이산값 V(B+1)-V(B)를 보여줘. 시장가격도, 모든 예산에 고정된 값도 아니야.",
    },
    mirror: {
      short: state.readinessLens
        ? `그냥 본 기울기 ${formatNumber(analysis.raw.slope ?? 0, 2)}가 준비도 통제 뒤 ${formatNumber(analysis.adjusted.slope ?? 0, 2)}로 바뀌었어.`
        : "둘이 같이 움직이는 것은 출발점이지 원인 판정문은 아니야. 준비도 렌즈를 켜 봐.",
      analogy: "우산과 교통사고가 함께 늘어도 우산이 사고를 만든 건 아니야. 비가 둘을 함께 움직일 수 있어.",
      deep: "통제 회귀는 관찰한 준비도와 선형으로 연결된 부분을 잔차로 덜어냈어. 관찰 못 한 교란은 여전히 남을 수 있어.",
    },
    parallel: {
      short: state.experiment === "random"
        ? "제비뽑기는 출발점을 비슷하게 만들어 볼 수 없는 평행세계를 집단 평균으로 대신해."
        : "같은 사람의 두 미래를 동시에 볼 수 없어서 비교 가능한 집단이 필요해.",
      analogy: "한 씨앗을 동시에 햇빛 아래와 그늘에 심을 수 없으니, 비슷한 씨앗 두 무리를 비교하는 것과 같아.",
      deep: "인과효과는 잠재결과의 차이야. 무작위 배정은 평균적으로 처치와 다른 원인의 연결을 끊는 설계야.",
    },
    measurement: {
      short: `사람이 ${auditCount}/${AUDIT_ITEMS.length}개 라벨을 확인했어. AI의 자신감도 측정오차를 없애지는 않아.`,
      analogy: "자동 온도계도 가끔 틀리니 몇 곳은 손 온도계로 대조하듯, AI 라벨도 사람 표본으로 감사해.",
      deep: "AI 생성 공변량의 오분류는 추정치를 편향시킬 수 있어. 라벨 정확도와 표본추출 규칙을 함께 기록해야 해.",
    },
    cockpit: {
      short: state.proposalStatus === "approved"
        ? "네가 네 질문을 확인하고 되돌릴 수 있는 모의실행만 승인했어. 이제 결과를 다시 데이터로 보낼 차례야."
        : "나는 후보를 계산했어. 무엇을 성공이라 부르고 어디서 멈출지는 네가 정해.",
      analogy: "자동차가 경로를 계산해도 목적지와 위험한 길을 피할지는 운전자가 정하는 것과 같아.",
      deep: "검증기가 모든 경제 주장에 완전한 정답표를 갖지 못하므로, 비가역성이 큰 결정에 사람 게이트를 집중해야 해.",
    },
    workshop: {
      short: `반복 ${state.runs}회. 안정된 반복은 도구로, 낯선 예외는 에이전트로 보내자.`,
      analogy: "매번 머리로 긴 나눗셈을 하기보다 검증된 계산기를 만드는 것과 같아.",
      deep: "고정 구축비 F와 회당 비용 차이 p-q가 있을 때 손익분기는 대략 F/(p-q)야. 유지보수와 검토비도 빼먹으면 안 돼.",
    },
    exit: {
      short: state.quizMastered
        ? "축하해. 축제 밖 대피소 문제에도 같은 생각법을 옮겼어."
        : "새 상황에서 목표·제약·인과·승인을 다시 구분하면 진짜 네 지식이 돼.",
      analogy: "박물관 지도를 외운 게 아니라 다른 도시에서도 북쪽을 찾을 수 있는지 보는 마지막 문이야.",
      deep: "전이는 개념 숙달의 더 강한 증거야. 추정→최적화→인간 승인→새 데이터의 루프를 상황과 분리해 기억해.",
    },
  };
}

function updateDocent() {
  const messages = docentMessages();
  const message = messages[currentExhibit] ?? messages.entrance;
  document.querySelector("#docent-message").textContent =
    message[state.docentDepth] ?? message.short;
}

function setDocentDepth(depth) {
  if (!["short", "analogy", "deep"].includes(depth)) return;
  state.docentDepth = depth;
  document.querySelectorAll("[data-depth]").forEach((button) => {
    const active = button.dataset.depth === depth;
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? "작은 화면에서는 누르면 다음 설명 방식으로 바뀝니다." : "";
  });
  saveState();
  updateDocent();
}

function setActiveExhibit(id) {
  currentExhibit = id;
  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.dataset.route === id;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  updateDocent();
}

function resetTour() {
  const confirmed = window.confirm("관람 선택과 도장을 모두 초기화할까요? 프로젝트 파일은 바뀌지 않습니다.");
  if (!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}

function bindEvents() {
  document.querySelectorAll('input[name="goal"]').forEach((radio) => {
    radio.addEventListener("change", () => setGoal(radio.value));
  });
  document.querySelector(".primary-cta[href='#scarcity']").addEventListener("click", () => markComplete("entrance"));
  document.querySelector("#budget").addEventListener("input", (event) => {
    state.budget = Number.parseInt(event.currentTarget.value, 10);
    state.shadowRevealed = false;
    state.proposalStatus = "pending";
    state.proposalRevised = false;
    state.approvalGates = [];
    renderAllocation();
    renderOptimizer();
    renderShadow();
    renderProposal();
    saveState();
    updateDocent();
  });
  document.querySelector("#allocation-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const card = button.closest("[data-activity]");
    const id = card.dataset.activity;
    if (button.dataset.action === "plus" && allocationUsed() < state.budget) {
      state.allocation[id] += 1;
    }
    if (button.dataset.action === "minus" && state.allocation[id] > 0) {
      state.allocation[id] -= 1;
    }
    renderAllocation();
    renderOptimizer();
    saveState();
    updateDocent();
  });
  document.querySelectorAll("[data-opt-prediction]").forEach((button) => {
    button.addEventListener("click", () => {
      state.optPrediction = button.dataset.optPrediction;
      document.querySelectorAll("[data-opt-prediction]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      saveState();
    });
  });
  document.querySelector("#run-optimizer").addEventListener("click", revealOptimizer);
  document.querySelectorAll("[data-shadow-prediction]").forEach((button) => {
    button.addEventListener("click", () => {
      state.shadowPrediction = button.dataset.shadowPrediction;
      document.querySelectorAll("[data-shadow-prediction]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      saveState();
    });
  });
  document.querySelector("#reveal-shadow").addEventListener("click", () => {
    state.shadowRevealed = true;
    markComplete("shadow");
    renderShadow();
    saveState();
    updateDocent();
  });
  document.querySelector("#confounding").addEventListener("input", (event) => {
    state.confounding = Number.parseInt(event.currentTarget.value, 10) / 100;
    renderConfounding();
    saveState();
    updateDocent();
  });
  document.querySelectorAll('input[name="true-effect"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.trueEffect = Number(radio.value);
      renderConfounding();
      saveState();
      updateDocent();
    });
  });
  document.querySelector("#toggle-readiness").addEventListener("click", () => {
    state.readinessLens = !state.readinessLens;
    if (state.readinessLens) markComplete("mirror");
    renderConfounding();
    saveState();
    updateDocent();
  });
  document.querySelectorAll("[data-experiment]").forEach((button) => {
    button.addEventListener("click", () => selectExperiment(button.dataset.experiment));
  });
  document.querySelector("#audit-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-audit-id]");
    if (!button) return;
    setAuditChoice(button.dataset.auditId, button.dataset.auditLabel);
  });
  document.querySelectorAll(".approval-gates input").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      state.approvalGates = [...document.querySelectorAll(".approval-gates input:checked")].map(
        (item) => item.value,
      );
      renderProposal();
      saveState();
    });
  });
  document.querySelector("#reject-proposal").addEventListener("click", () => {
    state.proposalStatus = "rejected";
    state.proposalRevised = false;
    state.approvalGates = [];
    renderProposal();
    saveState();
    updateDocent();
    document.querySelector("#entrance").scrollIntoView({
      behavior: state.reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    document.querySelector('input[name="goal"]:checked')?.focus({ preventScroll: true });
  });
  document.querySelector("#revise-proposal").addEventListener("click", () => {
    state.proposalStatus = "pending";
    state.proposalRevised = true;
    state.approvalGates = [];
    renderProposal();
    saveState();
    updateDocent();
  });
  document.querySelector("#approve-proposal").addEventListener("click", () => {
    if (state.approvalGates.length !== 4) return;
    state.proposalStatus = "approved";
    markComplete("cockpit");
    renderProposal();
    saveState();
    updateDocent();
  });
  document.querySelector("#runs").addEventListener("input", (event) => {
    state.runs = Number.parseInt(event.currentTarget.value, 10);
    markComplete("workshop");
    updateBreakEven();
    saveState();
    updateDocent();
  });
  [
    ["#monthly-price", "monthlyPrice", Number],
    ["#weekly-value", "weeklyListValue", Number],
    ["#utilization", "utilizationPercent", Number],
    ["#cost-ratio", "assumedCostRatioPercent", Number],
  ].forEach(([selector, property, parser]) => {
    document.querySelector(selector).addEventListener("input", (event) => {
      const value = parser(event.currentTarget.value);
      if (!Number.isFinite(value) || value < 0) return;
      state.price[property] = value;
      markComplete("workshop");
      updatePriceScenario();
      saveState();
    });
  });
  document.querySelector("#mastery-quiz").addEventListener("submit", checkQuiz);
  document.querySelector("#quiz-questions").addEventListener("change", (event) => {
    const input = event.target.closest('input[type="radio"]');
    if (!input) return;
    const fieldset = input.closest("[data-question]");
    state.quizAnswers[fieldset.dataset.question] = input.value;
    state.quizMastered = false;
    syncCertificateState();
    document.querySelector("#quiz-result").className = "quiz-result";
    document.querySelector("#quiz-result").textContent = "답을 바꿨습니다. 다시 출구 검표를 받아 확인하세요.";
    saveState();
    updateProgress();
  });
  document.querySelector("#reflection").addEventListener("input", (event) => {
    state.reflection = event.currentTarget.value;
    saveState();
  });
  document.querySelector("#print-certificate").addEventListener("click", () => window.print());
  document.querySelectorAll("#reset-tour, #reset-tour-exit").forEach((button) => {
    button.addEventListener("click", resetTour);
  });
  document.querySelector("#docent-mute").addEventListener("click", () => {
    state.docentMuted = !state.docentMuted;
    const docent = document.querySelector("#docent");
    docent.classList.toggle("is-muted", state.docentMuted);
    const button = document.querySelector("#docent-mute");
    button.setAttribute("aria-pressed", String(state.docentMuted));
    button.setAttribute("aria-label", state.docentMuted ? "도슨트 조언 켜기" : "도슨트 조언 끄기");
    button.textContent = state.docentMuted ? "TT" : "×";
    saveState();
  });
  document.querySelectorAll("[data-depth]").forEach((button) => {
    button.addEventListener("click", () => {
      const compact = window.matchMedia("(max-width: 980px)").matches;
      if (compact && button.getAttribute("aria-pressed") === "true") {
        const order = ["short", "analogy", "deep"];
        setDocentDepth(order[(order.indexOf(state.docentDepth) + 1) % order.length]);
      } else {
        setDocentDepth(button.dataset.depth);
      }
    });
  });
  document.querySelector("#motion-toggle").addEventListener("click", () => {
    state.reduceMotion = !state.reduceMotion;
    document.body.classList.toggle("reduce-motion", state.reduceMotion);
    const button = document.querySelector("#motion-toggle");
    button.setAttribute("aria-pressed", String(state.reduceMotion));
    button.textContent = state.reduceMotion ? "움직임 켜기" : "움직임 줄이기";
    saveState();
  });
}

function observeExhibits() {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target?.id) setActiveExhibit(visible.target.id);
    },
    { rootMargin: "-18% 0px -55% 0px", threshold: [0.08, 0.25, 0.5] },
  );
  document.querySelectorAll("[data-exhibit]").forEach((section) => observer.observe(section));
}

function normalizeStoredState() {
  if (!GOALS[state.goal]) state.goal = "balance";
  if (!Number.isSafeInteger(state.budget) || state.budget < 4 || state.budget > 12) state.budget = 8;
  if (!Number.isFinite(state.confounding) || state.confounding < 0 || state.confounding > 1) state.confounding = 1;
  if (![0, 1].includes(state.trueEffect)) state.trueEffect = 0;
  if (!Number.isSafeInteger(state.runs) || state.runs < 1 || state.runs > 40) state.runs = 30;

  const booleanKeys = [
    "optimizerRun",
    "shadowRevealed",
    "readinessLens",
    "proposalRevised",
    "quizMastered",
    "docentMuted",
    "reduceMotion",
  ];
  booleanKeys.forEach((key) => {
    state[key] = typeof state[key] === "boolean" ? state[key] : defaultState[key];
  });

  if (!["mine", "other", "unsure"].includes(state.optPrediction)) state.optPrediction = null;
  if (!ACTIVITY_META.some((activity) => activity.id === state.shadowPrediction)) {
    state.shadowPrediction = null;
  }
  if (!["self", "random"].includes(state.experiment)) state.experiment = null;
  if (!["pending", "rejected", "approved"].includes(state.proposalStatus)) {
    state.proposalStatus = "pending";
  }
  if (!["short", "analogy", "deep"].includes(state.docentDepth)) {
    state.docentDepth = "short";
  }

  const validGates = ["why", "evidence", "uncertainty", "reversible"];
  state.approvalGates = [
    ...new Set(state.approvalGates.filter((gate) => validGates.includes(gate))),
  ];
  if (state.proposalStatus === "rejected") state.approvalGates = [];
  if (state.proposalStatus === "approved" && state.approvalGates.length !== validGates.length) {
    state.proposalStatus = "pending";
  }

  ACTIVITY_META.forEach((activity) => {
    const amount = state.allocation[activity.id];
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > activity.marginalValues.length) {
      state.allocation[activity.id] = 0;
    }
  });

  const cleanAuditChoices = {};
  AUDIT_ITEMS.forEach((item) => {
    const choice = state.auditChoices[item.id];
    if (["understood", "confused"].includes(choice)) cleanAuditChoices[item.id] = choice;
  });
  state.auditChoices = cleanAuditChoices;

  const cleanQuizAnswers = {};
  QUIZ.forEach((question) => {
    const answer = state.quizAnswers[question.id];
    if (question.options.some(([value]) => value === answer)) {
      cleanQuizAnswers[question.id] = answer;
    }
  });
  state.quizAnswers = cleanQuizAnswers;
  state.quizMastered =
    state.quizMastered &&
    QUIZ.every((question) => state.quizAnswers[question.id] === question.correct);

  const cleanCompleted = {};
  EXHIBITS.forEach((exhibit) => {
    if (state.completed[exhibit] === true) cleanCompleted[exhibit] = true;
  });
  state.completed = cleanCompleted;
  if (!certificateIsReady()) delete state.completed.exit;

  const normalizePrice = (value, minimum, maximum, fallback) =>
    Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
  state.price = {
    monthlyPrice: normalizePrice(state.price.monthlyPrice, 0, 1_000_000_000, defaultState.price.monthlyPrice),
    weeklyListValue: normalizePrice(state.price.weeklyListValue, 0, 1_000_000_000, defaultState.price.weeklyListValue),
    utilizationPercent: normalizePrice(state.price.utilizationPercent, 0, 100, defaultState.price.utilizationPercent),
    assumedCostRatioPercent: normalizePrice(
      state.price.assumedCostRatioPercent,
      0,
      100,
      defaultState.price.assumedCostRatioPercent,
    ),
  };
  state.reflection =
    typeof state.reflection === "string" ? state.reflection.slice(0, 180) : "";
}

function hydrate() {
  normalizeStoredState();
  document.querySelector(`input[name="goal"][value="${state.goal}"]`).checked = true;
  document.querySelectorAll("[data-opt-prediction]").forEach((button) => {
    const selected = button.dataset.optPrediction === state.optPrediction;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-shadow-prediction]").forEach((button) => {
    const selected = button.dataset.shadowPrediction === state.shadowPrediction;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-experiment]").forEach((button) => {
    button.setAttribute("aria-pressed", "false");
  });
  if (state.experiment) selectExperiment(state.experiment);
  document.body.classList.toggle("reduce-motion", state.reduceMotion);
  const motionButton = document.querySelector("#motion-toggle");
  motionButton.setAttribute("aria-pressed", String(state.reduceMotion));
  motionButton.textContent = state.reduceMotion ? "움직임 켜기" : "움직임 줄이기";
  const docent = document.querySelector("#docent");
  docent.classList.toggle("is-muted", state.docentMuted);
  const muteButton = document.querySelector("#docent-mute");
  muteButton.setAttribute("aria-pressed", String(state.docentMuted));
  muteButton.setAttribute("aria-label", state.docentMuted ? "도슨트 조언 켜기" : "도슨트 조언 끄기");
  muteButton.textContent = state.docentMuted ? "TT" : "×";

  setGoal(state.goal, false);
  renderAllocation();
  renderOptimizer();
  renderShadow();
  renderConfounding();
  renderAudit();
  renderProposal();
  updateBreakEven();
  updatePriceScenario();
  renderQuiz();
  updateProgress();
  setDocentDepth(state.docentDepth);
  observeExhibits();
}

bindEvents();
hydrate();
