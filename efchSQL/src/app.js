import { createEngine, exhaustiveTopK } from "./engine.js";
import { parseQuery } from "./query-parser.js";
import { PreferenceModel } from "./feedback.js";
import {
  DEMO_ROWS,
  DEMO_TOPICS,
  INITIAL_WEIGHTS,
  buildDemoQuery,
  formatPreferenceClause,
} from "./demo-data.js";

const BLOCK_SIZE = 32;
const DEFAULT_LIMIT = 12;
const ACCENTS = ["#315a4e", "#4c568a", "#9a603f", "#8a4d6d", "#9b6f20", "#39747b", "#665979", "#82535a"];
const REFINER_UPPER_BOUND = 0.22;
const ALWAYS_VERIFY = new URLSearchParams(window.location.search).has("verify")
  || new URLSearchParams(window.location.search).has("test");

const engine = createEngine(DEMO_ROWS, {
  blockSize: BLOCK_SIZE,
  sourceName: "feed",
});

const profile = new PreferenceModel({
  weights: INITIAL_WEIGHTS,
  learningRate: 0.6,
  minWeight: -3,
  maxWeight: 3,
});

const demoRefiner = Object.freeze({
  upperBound: REFINER_UPPER_BOUND,
  score(row) {
    const socialProof = Math.min(1, Number(row.stats?.likes ?? 0) / 500) * 0.13;
    const freshness = Math.max(0, 1 - Number(row.ageHours ?? 144) / 144) * 0.09;
    return Number((socialProof + freshness).toFixed(8));
  },
});

const rowById = new Map(DEMO_ROWS.map((row) => [String(row.id), row]));

const state = {
  mode: "exact",
  activeTab: "personal",
  activeView: "foryou",
  profileVersion: 1,
  runCount: 0,
  running: false,
  resultRows: [],
  resultIds: [],
  metrics: null,
  exhaustiveMatch: null,
  lastError: null,
  feedback: new Map(),
  saved: new Set(),
  personalWeights: profile.toJSON(),
  toastTimer: null,
  sliderTimer: null,
  verifyNext: false,
};

const elements = {
  body: document.body,
  editor: document.querySelector("#query-editor"),
  run: document.querySelector("#run-button"),
  reset: document.querySelector("#reset-button"),
  rerun: document.querySelector("#rerun-button"),
  verify: document.querySelector("#verify-button"),
  error: document.querySelector("#query-error"),
  feed: document.querySelector("#feed-list"),
  runSummary: document.querySelector("#run-summary"),
  resultHeading: document.querySelector("#result-heading"),
  sliderList: document.querySelector("#slider-list"),
  profileVersion: document.querySelector("#profile-version"),
  toast: document.querySelector("#feedback-toast"),
  exactBadge: document.querySelector("#exact-badge"),
  metricPrune: document.querySelector("#metric-prune"),
  pruneDonut: document.querySelector("#prune-donut"),
  metricRows: document.querySelector("#metric-rows"),
  metricRefiners: document.querySelector("#metric-refiners"),
  metricBlocks: document.querySelector("#metric-blocks"),
  metricLatency: document.querySelector("#metric-latency"),
  metricProfile: document.querySelector("#metric-profile"),
  metricRebuilds: document.querySelector("#metric-rebuilds"),
  metricExhaustive: document.querySelector("#metric-exhaustive"),
  rightRail: document.querySelector("#right-rail"),
  openTune: document.querySelector("#mobile-tune"),
  closeTune: document.querySelector("#close-tune"),
  scrim: document.querySelector("#scrim"),
};

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function numericMetric(metrics, names, fallback = 0) {
  for (const name of names) {
    const value = Number(metrics?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function formatWeight(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 0.005) return "0.0";
  return `${number > 0 ? "+" : ""}${number.toFixed(1)}`;
}

function weightsSignature(weights) {
  const normalized = new Map();
  for (const [symbol, rawValue] of Object.entries(weights ?? {})) {
    const key = String(symbol).trim().toLowerCase();
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value) || value === 0) continue;
    const combined = (normalized.get(key) ?? 0) + value;
    if (combined === 0) normalized.delete(key);
    else normalized.set(key, combined);
  }
  return JSON.stringify(
    [...normalized.entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function escapeForSingleQuote(value) {
  return String(value).replaceAll("'", "''");
}

function replacePreferClause(sql, weights) {
  const replacement = `PREFER ${formatPreferenceClause(weights)}\n`;
  if (/\bPREFER\b/i.test(sql)) {
    return sql.replace(/\bPREFER\b[\s\S]*?(?=\bLIMIT\b|\bMODE\b|;|$)/i, replacement);
  }
  const modeIndex = sql.search(/\b(?:LIMIT|MODE)\b/i);
  if (modeIndex >= 0) return `${sql.slice(0, modeIndex)}${replacement}${sql.slice(modeIndex)}`;
  return `${sql.trimEnd()}\n${replacement.trimEnd()}`;
}

function replaceModeClause(sql, mode) {
  const replacement = mode === "budget" ? "MODE BUDGET 192" : "MODE EXACT";
  const modePattern = /\bMODE\s+(?:EXACT|APPROX|BUDGET)(?:\s+(?:BUDGET\s+)?\d+)?/i;
  if (modePattern.test(sql)) return sql.replace(modePattern, replacement);
  return `${sql.trimEnd()}\n${replacement}`;
}

function queryForView(weights, view = state.activeView) {
  let query = buildDemoQuery(weights, state.mode, DEFAULT_LIMIT);
  if (view === "fresh") {
    query = query.replace("ageHours <= 96", "ageHours <= 24");
  } else if (view === "saved") {
    const ids = [...state.saved];
    const savedFilter =
      ids.length > 0
        ? `id IN (${ids.map((id) => `'${escapeForSingleQuote(id)}'`).join(", ")})`
        : "id = '__no_saved_posts__'";
    query = query.replace("language = 'en' AND ageHours <= 96", savedFilter);
  }
  return query;
}

function setError(error) {
  const message = error instanceof Error ? error.message : String(error);
  state.lastError = message;
  elements.error.querySelector("p").textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  state.lastError = null;
  elements.error.hidden = true;
  elements.error.querySelector("p").textContent = "";
}

function setRunning(running) {
  state.running = running;
  elements.feed.setAttribute("aria-busy", String(running));
  elements.run.disabled = running;
  elements.runSummary.classList.toggle("is-running", running);
  if (running) {
    elements.run.querySelector("span").textContent = "Running…";
    elements.runSummary.querySelector("span:last-child").textContent = "Ranking local blocks…";
  } else {
    elements.run.querySelector("span").textContent = "Run query";
  }
}

function setModeUI(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-option").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setTabUI(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".feed-tab").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function setViewUI(view) {
  state.activeView = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  elements.resultHeading.textContent =
    view === "fresh" ? "Fresh in the last day" : view === "saved" ? "Saved by you" : "Recommended now";
}

function renderSliders() {
  elements.sliderList.replaceChildren();
  const weights = profile.toJSON();

  for (const topic of DEMO_TOPICS) {
    const row = createElement("div", "slider-row");
    row.style.setProperty("--slider-color", topic.color);

    const label = createElement("label", "slider-label", topic.label);
    const id = `weight-${topic.symbol}`;
    label.htmlFor = id;

    const output = createElement("output", "slider-value");
    output.htmlFor = id;
    output.dataset.outputFor = topic.symbol;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = id;
    slider.min = "-3";
    slider.max = "3";
    slider.step = "0.1";
    slider.value = String(Math.max(-3, Math.min(3, weights[topic.symbol] ?? 0)));
    slider.dataset.symbol = topic.symbol;
    slider.setAttribute("aria-label", `${topic.label} preference`);

    row.append(label, output, slider);
    elements.sliderList.append(row);
  }
  updateSliderDisplays();
}

function updateSliderDisplays() {
  const weights = profile.toJSON();
  elements.sliderList.querySelectorAll("input[type='range']").forEach((slider) => {
    const weight = Number(weights[slider.dataset.symbol] ?? 0);
    if (document.activeElement !== slider) slider.value = String(Math.max(-3, Math.min(3, weight)));
    const output = elements.sliderList.querySelector(`[data-output-for="${slider.dataset.symbol}"]`);
    output.value = formatWeight(weight);
    output.textContent = formatWeight(weight);
    output.classList.toggle("is-positive", weight > 0.05);
    output.classList.toggle("is-negative", weight < -0.05);
  });
  elements.profileVersion.textContent = `v${state.profileVersion}`;
  elements.metricProfile.textContent = `v${state.profileVersion}`;
}

function syncProfileFromPlan(plan) {
  const current = profile.toJSON();
  const incoming = plan.prefer ?? {};
  if (weightsSignature(current) !== weightsSignature(incoming)) {
    profile.reset(incoming);
    state.profileVersion += 1;
    state.personalWeights = profile.toJSON();
    updateSliderDisplays();
  }
}

function normalizeRows(result) {
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.results)) {
    return result.results.map((entry) => ({
      ...entry.row,
      efchScore: entry.score,
    }));
  }
  return [];
}

function compareResults(left, right) {
  const leftRows = normalizeRows(left);
  const rightRows = normalizeRows(right);
  if (leftRows.length !== rightRows.length) return false;
  return leftRows.every((row, index) => {
    const other = rightRows[index];
    const leftScore = Number(row.efchScore ?? left.results?.[index]?.score);
    const rightScore = Number(other.efchScore ?? right.results?.[index]?.score);
    return String(row.id) === String(other.id) && Math.abs(leftScore - rightScore) <= 1e-8;
  });
}

function symbolWeight(symbol) {
  return Number(profile.getWeight(symbol) ?? 0);
}

function renderCard(row, rank) {
  const card = createElement("article", "feed-card");
  card.dataset.rowId = String(row.id);
  card.dataset.rank = String(rank + 1);
  card.style.setProperty("--card-accent", ACCENTS[row.accent % ACCENTS.length]);

  const avatar = createElement("div", "avatar", row.initials || "?");
  avatar.setAttribute("aria-hidden", "true");
  avatar.style.setProperty("--avatar-bg", ACCENTS[row.accent % ACCENTS.length]);

  const content = createElement("div", "card-content");
  const meta = createElement("div", "card-meta");
  const author = createElement("strong", "", row.author);
  const verified = createElement("span", "verified-mark", "✓");
  verified.title = "Fictional demo profile";
  verified.setAttribute("aria-label", "Fictional demo profile");
  const handle = createElement("span", "handle", `@${row.handle}`);
  const separator = createElement("span", "meta-separator", "·");
  separator.setAttribute("aria-hidden", "true");
  const time = createElement("time", "", row.createdLabel);
  time.setAttribute("aria-label", `${row.ageHours} hours old`);
  const score = Number(row.efchScore ?? row.score ?? 0);
  const scoreChip = createElement("span", "score-chip", `score ${score.toFixed(3)}`);
  scoreChip.title = "Current cheap score plus bounded local refinement";
  meta.append(author, verified, handle, separator, time, scoreChip);

  const body = createElement("p", "post-body", row.body);
  const symbols = createElement("div", "symbol-list");
  symbols.setAttribute("aria-label", "Active ranking symbols");
  for (const symbol of (row.symbols ?? []).filter((value) => !String(value).startsWith("item/")).slice(0, 3)) {
    const weight = symbolWeight(symbol);
    const chip = createElement(
      "span",
      `symbol-chip${weight > 0.05 ? " is-positive" : weight < -0.05 ? " is-negative" : ""}`,
      `#${symbol} ${formatWeight(weight)}`,
    );
    symbols.append(chip);
  }

  const footer = createElement("div", "card-footer");
  const stats = createElement("div", "post-stats");
  const statDefinitions = [
    ["↩", row.stats?.replies ?? 0, "replies"],
    ["⇄", row.stats?.echoes ?? 0, "echoes"],
    ["♡", row.stats?.likes ?? 0, "likes"],
  ];
  for (const [icon, value, label] of statDefinitions) {
    const stat = createElement("span", "stat");
    const statIcon = createElement("span", "stat-icon", icon);
    statIcon.setAttribute("aria-hidden", "true");
    stat.append(statIcon, document.createTextNode(formatNumber(value)));
    stat.setAttribute("aria-label", `${formatNumber(value)} ${label}`);
    stats.append(stat);
  }

  const actions = createElement("div", "feedback-actions");
  const currentFeedback = state.feedback.get(String(row.id));
  const like = createElement("button", "feedback-button");
  like.type = "button";
  like.dataset.action = "like";
  like.dataset.rowId = String(row.id);
  like.setAttribute("aria-label", `Like post by ${row.author}`);
  like.setAttribute("aria-pressed", String(currentFeedback === "like"));
  like.append(createElement("span", "", "♡"), createElement("span", "", "More like this"));

  const dislike = createElement("button", "feedback-button");
  dislike.type = "button";
  dislike.dataset.action = "dislike";
  dislike.dataset.rowId = String(row.id);
  dislike.setAttribute("aria-label", `Show less like this post by ${row.author}`);
  dislike.setAttribute("aria-pressed", String(currentFeedback === "dislike"));
  dislike.append(createElement("span", "", "−"), createElement("span", "", "Less"));
  actions.append(like, dislike);

  footer.append(stats, actions);
  content.append(meta, body, symbols, footer);
  card.append(avatar, content);
  return card;
}

function renderFeed(rows) {
  elements.feed.replaceChildren();
  if (rows.length === 0) {
    const empty = createElement("div", "empty-state");
    const title = createElement(
      "strong",
      "",
      state.activeView === "saved" ? "Nothing saved yet" : "No rows matched this query",
    );
    const copy = createElement(
      "span",
      "",
      state.activeView === "saved"
        ? "Choose “More like this” on a post, then return here."
        : "Widen the WHERE clause or reset the demo query.",
    );
    empty.append(title, copy);
    elements.feed.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => fragment.append(renderCard(row, index)));
  elements.feed.append(fragment);
}

function renderTelemetry(metrics, queryPlan, exhaustiveMatch) {
  const totalRows = numericMetric(metrics, ["totalRows"], DEMO_ROWS.length);
  const scoredRows = numericMetric(metrics, ["scoredRows", "scannedRows"]);
  const refinedRows = numericMetric(metrics, ["refinedRows", "refinerCalls"]);
  const blocksVisited = numericMetric(metrics, ["blocksVisited", "visitedBlocks"]);
  const blocksTotal = numericMetric(metrics, ["blocksTotal"], Math.ceil(totalRows / BLOCK_SIZE));
  const latency = numericMetric(metrics, ["latencyMs", "elapsedMs"]);
  const pruneRatio = totalRows > 0 ? Math.max(0, Math.min(1, 1 - scoredRows / totalRows)) : 0;
  const prunePercent = pruneRatio * 100;
  const exact = Boolean(metrics?.exact) && queryPlan.mode === "exact";

  elements.metricPrune.textContent = `${prunePercent.toFixed(prunePercent >= 99 ? 1 : 0)}%`;
  elements.pruneDonut.style.setProperty("--prune-angle", `${pruneRatio * 360}deg`);
  elements.metricRows.textContent = `${formatNumber(scoredRows)} / ${formatNumber(totalRows)}`;
  elements.metricRefiners.textContent = formatNumber(refinedRows);
  elements.metricBlocks.textContent = `${formatNumber(blocksVisited)} / ${formatNumber(blocksTotal)}`;
  elements.metricLatency.textContent = `${latency < 0.1 ? "<0.1" : latency.toFixed(latency < 10 ? 2 : 1)} ms`;
  elements.metricProfile.textContent = `v${state.profileVersion}`;
  elements.metricRebuilds.textContent = "0";
  elements.exactBadge.textContent = exact ? "Exact" : "Budget";
  elements.exactBadge.classList.toggle("is-budget", !exact);

  elements.metricExhaustive.classList.remove("is-match", "is-mismatch");
  if (queryPlan.mode === "exact" && exhaustiveMatch !== null) {
    elements.metricExhaustive.textContent = exhaustiveMatch
      ? "✓ Matches exhaustive top-K"
      : "✕ Exhaustive result differs";
    elements.metricExhaustive.classList.add(exhaustiveMatch ? "is-match" : "is-mismatch");
  } else if (queryPlan.mode === "exact") {
    elements.metricExhaustive.textContent = "Exact by safe bounds · oracle off";
  } else {
    elements.metricExhaustive.textContent = "Budgeted run · oracle skipped";
  }
  elements.verify.hidden = queryPlan.mode !== "exact";

  const resultCount = state.resultRows.length;
  const evaluationPercent = totalRows > 0 ? (scoredRows / totalRows) * 100 : 0;
  elements.runSummary.querySelector("span:last-child").textContent =
    `${resultCount} picks · ${evaluationPercent.toFixed(evaluationPercent < 10 ? 1 : 0)}% scored`;
}

function showToast(message) {
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function nextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 50);
    window.requestAnimationFrame(finish);
  });
}

async function runQuery({ source = "manual" } = {}) {
  if (state.running) return null;
  // Capture a stable query snapshot before yielding to paint. A click or input
  // event cannot silently change the statement halfway through this run.
  const sql = elements.editor.value;
  clearError();
  setRunning(true);
  await nextPaint();

  try {
    const plan = parseQuery(sql);
    const result = engine.query(sql, { refiner: demoRefiner });
    const rows = normalizeRows(result);
    let exhaustiveMatch = null;

    if (plan.mode === "exact" && (ALWAYS_VERIFY || state.verifyNext)) {
      const oracle =
        typeof engine.exhaustive === "function"
          ? engine.exhaustive(sql, { refiner: demoRefiner })
          : exhaustiveTopK(DEMO_ROWS, sql, {
              refiner: demoRefiner,
              engineOptions: { blockSize: BLOCK_SIZE, sourceName: "feed" },
            });
      exhaustiveMatch = compareResults(result, oracle);
      if (!exhaustiveMatch) {
        throw new Error("Exact-mode safety check failed: pruned result differs from exhaustive top-K.");
      }
    }

    // Query-derived UI state commits only after parsing, execution, and any
    // requested oracle check all succeed.
    syncProfileFromPlan(plan);
    setModeUI(plan.mode === "exact" ? "exact" : "budget");
    state.verifyNext = false;

    state.resultRows = rows;
    state.resultIds = rows.map((row) => String(row.id));
    state.metrics = { ...result.metrics };
    state.exhaustiveMatch = exhaustiveMatch;
    state.runCount += 1;
    state.personalWeights = state.activeTab === "personal" ? profile.toJSON() : state.personalWeights;
    renderFeed(rows);
    renderTelemetry(result.metrics ?? {}, plan, exhaustiveMatch);
    elements.feed.dataset.lastRunSource = source;
    elements.feed.dataset.runCount = String(state.runCount);
    elements.body.dataset.runCount = String(state.runCount);
    elements.body.dispatchEvent(
      new CustomEvent("efch:run", {
        detail: { runCount: state.runCount, mode: state.mode, resultIds: [...state.resultIds] },
      }),
    );
    return result;
  } catch (error) {
    setError(error);
    elements.runSummary.querySelector("span:last-child").textContent = "Query needs attention";
    elements.body.dispatchEvent(
      new CustomEvent("efch:error", { detail: { message: state.lastError } }),
    );
    return null;
  } finally {
    setRunning(false);
  }
}

function updateQueryFromProfile({ rerun = false, source = "profile" } = {}) {
  elements.editor.value = replacePreferClause(elements.editor.value, profile.toJSON());
  state.personalWeights = profile.toJSON();
  updateSliderDisplays();
  if (rerun) return runQuery({ source });
  return null;
}

async function setWeight(symbol, value, { rerun = true } = {}) {
  if (state.activeTab === "baseline") {
    profile.reset(state.personalWeights);
    setTabUI("personal");
  }
  profile.setWeight(symbol, Number(value));
  state.profileVersion += 1;
  updateQueryFromProfile();
  if (rerun) return runQuery({ source: "slider" });
  return null;
}

async function applyRowFeedback(rowId, signal) {
  const row = rowById.get(String(rowId));
  if (!row) throw new Error(`Unknown demo row ${rowId}`);

  const before = {
    weights: profile.toJSON(),
    profileVersion: state.profileVersion,
    feedback: new Map(state.feedback),
    saved: new Set(state.saved),
    activeTab: state.activeTab,
    personalWeights: { ...state.personalWeights },
    editorValue: elements.editor.value,
  };

  if (state.activeTab === "baseline") {
    profile.reset(state.personalWeights);
    setTabUI("personal");
  }
  profile.feedback(row, signal, { learningRate: 0.6 });
  state.profileVersion += 1;
  state.feedback.set(String(row.id), signal);
  if (signal === "like") state.saved.add(String(row.id));
  else state.saved.delete(String(row.id));

  state.personalWeights = profile.toJSON();
  if (state.activeView === "saved") {
    elements.editor.value = queryForView(profile.toJSON(), "saved");
    updateSliderDisplays();
  } else {
    updateQueryFromProfile();
  }
  const result = await runQuery({ source: `feedback:${signal}` });
  if (!result) {
    profile.reset(before.weights);
    state.profileVersion = before.profileVersion;
    state.feedback = before.feedback;
    state.saved = before.saved;
    state.personalWeights = before.personalWeights;
    setTabUI(before.activeTab);
    elements.editor.value = before.editorValue;
    updateSliderDisplays();
    renderFeed(state.resultRows);
    return null;
  }

  showToast(
    signal === "like"
      ? `Preference updated from ${row.author}’s symbols. Reranked without rebuilding the index.`
      : `Those symbols were down-weighted. Reranked without rebuilding the index.`,
  );
  return result;
}

function resetDemo() {
  if (state.sliderTimer) window.clearTimeout(state.sliderTimer);
  profile.reset(INITIAL_WEIGHTS);
  state.mode = "exact";
  state.activeTab = "personal";
  state.activeView = "foryou";
  state.profileVersion = 1;
  state.feedback.clear();
  state.saved.clear();
  state.personalWeights = profile.toJSON();
  setModeUI("exact");
  setTabUI("personal");
  setViewUI("foryou");
  elements.editor.value = buildDemoQuery(profile.toJSON(), "exact", DEFAULT_LIMIT);
  renderSliders();
  showToast("Demo profile reset. The existing block index is still in place.");
  return runQuery({ source: "reset" });
}

function openTunePanel() {
  if (!mobileDrawerQuery.matches) return;
  elements.rightRail.classList.add("is-open");
  elements.rightRail.inert = false;
  elements.rightRail.setAttribute("aria-hidden", "false");
  for (const region of drawerBackgroundRegions) region.inert = true;
  elements.scrim.hidden = false;
  elements.openTune.setAttribute("aria-expanded", "true");
  elements.closeTune.focus();
}

function closeTunePanel({ restoreFocus = true } = {}) {
  elements.rightRail.classList.remove("is-open");
  elements.scrim.hidden = true;
  elements.openTune.setAttribute("aria-expanded", "false");
  for (const region of drawerBackgroundRegions) region.inert = false;
  if (mobileDrawerQuery.matches) {
    elements.rightRail.inert = true;
    elements.rightRail.setAttribute("aria-hidden", "true");
  } else {
    elements.rightRail.inert = false;
    elements.rightRail.removeAttribute("aria-hidden");
  }
  if (restoreFocus) elements.openTune.focus();
}

const mobileDrawerQuery = window.matchMedia("(max-width: 930px)");
const drawerBackgroundRegions = [
  document.querySelector(".left-rail"),
  document.querySelector(".feed-column"),
].filter(Boolean);

function syncDrawerAccessibility() {
  if (mobileDrawerQuery.matches) {
    elements.rightRail.setAttribute("role", "dialog");
    elements.rightRail.setAttribute("aria-modal", "true");
    if (!elements.rightRail.classList.contains("is-open")) {
      elements.rightRail.inert = true;
      elements.rightRail.setAttribute("aria-hidden", "true");
    }
    return;
  }

  elements.rightRail.classList.remove("is-open");
  elements.rightRail.inert = false;
  elements.rightRail.removeAttribute("role");
  elements.rightRail.removeAttribute("aria-modal");
  elements.rightRail.removeAttribute("aria-hidden");
  elements.scrim.hidden = true;
  elements.openTune.setAttribute("aria-expanded", "false");
  for (const region of drawerBackgroundRegions) region.inert = false;
}

function trapDrawerFocus(event) {
  if (
    event.key !== "Tab"
    || !mobileDrawerQuery.matches
    || !elements.rightRail.classList.contains("is-open")
  ) {
    return;
  }
  const focusable = [...elements.rightRail.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    elements.rightRail.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindEvents() {
  elements.run.addEventListener("click", () => runQuery({ source: "run-button" }));
  elements.reset.addEventListener("click", resetDemo);
  elements.rerun.addEventListener("click", () => runQuery({ source: "rerun" }));
  elements.verify.addEventListener("click", () => {
    state.verifyNext = true;
    runQuery({ source: "exhaustive-verifier" });
  });

  elements.editor.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runQuery({ source: "keyboard" });
    }
  });

  document.querySelectorAll(".mode-option").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      elements.editor.value = replaceModeClause(elements.editor.value, mode);
      runQuery({ source: `mode:${mode}` });
    });
  });

  elements.sliderList.addEventListener("input", (event) => {
    const slider = event.target.closest("input[data-symbol]");
    if (!slider) return;
    setWeight(slider.dataset.symbol, slider.value, { rerun: false });
    if (state.sliderTimer) window.clearTimeout(state.sliderTimer);
    state.sliderTimer = window.setTimeout(() => {
      state.sliderTimer = null;
      runQuery({ source: "slider" });
    }, 120);
  });

  elements.sliderList.addEventListener("change", (event) => {
    const slider = event.target.closest("input[data-symbol]");
    if (!slider) return;
    if (state.sliderTimer) window.clearTimeout(state.sliderTimer);
    state.sliderTimer = null;
    runQuery({ source: "slider" });
  });

  elements.feed.addEventListener("click", (event) => {
    const button = event.target.closest(".feedback-button");
    if (!button) return;
    button.disabled = true;
    applyRowFeedback(button.dataset.rowId, button.dataset.action)
      .then((result) => {
        if (!result && button.isConnected) button.disabled = false;
      })
      .catch((error) => {
        if (button.isConnected) button.disabled = false;
        setError(error);
      });
  });

  document.querySelectorAll(".feed-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (tab === state.activeTab) return;
      if (tab === "baseline") {
        state.personalWeights = profile.toJSON();
        profile.reset({});
      } else {
        profile.reset(state.personalWeights);
      }
      state.profileVersion += 1;
      setTabUI(tab);
      elements.editor.value = queryForView(profile.toJSON());
      updateSliderDisplays();
      runQuery({ source: `tab:${tab}` });
    });
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      setViewUI(button.dataset.view);
      elements.editor.value = queryForView(profile.toJSON(), button.dataset.view);
      runQuery({ source: `view:${button.dataset.view}` });
    });
  });

  elements.openTune.addEventListener("click", openTunePanel);
  elements.closeTune.addEventListener("click", () => closeTunePanel());
  elements.scrim.addEventListener("click", () => closeTunePanel());
  mobileDrawerQuery.addEventListener("change", syncDrawerAccessibility);
  window.addEventListener("resize", syncDrawerAccessibility);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.rightRail.classList.contains("is-open")) {
      closeTunePanel();
      return;
    }
    trapDrawerFocus(event);
  });
  syncDrawerAccessibility();
}

function getSnapshot() {
  return {
    ready: elements.body.dataset.appReady === "true",
    mode: state.mode,
    activeTab: state.activeTab,
    activeView: state.activeView,
    profileVersion: state.profileVersion,
    weights: profile.toJSON(),
    runCount: state.runCount,
    running: state.running,
    resultIds: [...state.resultIds],
    resultScores: state.resultRows.map((row) => Number(row.efchScore ?? 0)),
    metrics: state.metrics ? { ...state.metrics } : null,
    exhaustiveMatch: state.exhaustiveMatch,
    lastError: state.lastError,
    indexRebuilds: 0,
  };
}

let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});

window.__efchApp = Object.freeze({
  ready,
  getSnapshot,
  run: runQuery,
  reset: resetDemo,
  setMode(mode) {
    const normalized = mode === "exact" ? "exact" : "budget";
    elements.editor.value = replaceModeClause(elements.editor.value, normalized);
    return runQuery({ source: `api-mode:${normalized}` });
  },
  setWeight,
  feedback: applyRowFeedback,
});

async function boot() {
  elements.editor.value = buildDemoQuery(profile.toJSON(), state.mode, DEFAULT_LIMIT);
  renderSliders();
  bindEvents();
  const result = await runQuery({ source: "initial" });
  if (!result) throw new Error(state.lastError || "Initial efchSQL query failed");
  elements.body.dataset.appReady = "true";
  resolveReady(getSnapshot());
}

boot().catch((error) => {
  setRunning(false);
  setError(error);
  elements.feed.setAttribute("aria-busy", "false");
  elements.body.dataset.appReady = "false";
  resolveReady(getSnapshot());
});
