import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = 4279;
const baseUrl = `http://127.0.0.1:${port}/`;
const chromiumCandidates = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);
const chromiumPath = chromiumCandidates.find((candidate) => existsSync(candidate));

if (!chromiumPath) {
  throw new Error("Chromium not found. Set CHROMIUM_PATH to run the real-browser smoke test.");
}

const profile = mkdtempSync(join(tmpdir(), "ttt-chromium-"));
let server;
let browser;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHttp(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await wait(50);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function chromiumDebugPort(process) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Chromium DevTools endpoint timed out")), 10_000);
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number.parseInt(match[1], 10));
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready (${code})`));
    });
  });
}

async function waitForTarget(debugPort, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) =>
        response.json(),
      );
      const page = targets.find((target) => target.type === "page" && target.url.startsWith(baseUrl));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Target is still starting.
    }
    await wait(50);
  }
  throw new Error("Browser target did not become ready");
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    opened,
    events,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function main() {
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp(baseUrl);

  browser = spawn(
    chromiumPath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,1000",
      baseUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const debugPort = await chromiumDebugPort(browser);
  const targetUrl = await waitForTarget(debugPort);
  const cdp = connectCdp(targetUrl);
  await cdp.opened;
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
    }
    return result.result.value;
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await evaluate("document.readyState")) === "complete") break;
    await wait(50);
  }
  await wait(150);

  const initial = await evaluate(`(() => ({
    title: document.title,
    h1: document.querySelector("h1")?.textContent.trim(),
    quizCount: document.querySelectorAll(".quiz-question").length,
    walkthroughCount: document.querySelectorAll("[data-walkthrough]").length,
    openWalkthroughCount: document.querySelectorAll("[data-walkthrough][open]").length,
    lessonCardCount: document.querySelectorAll(".lesson-grid article").length,
    teachBackCount: document.querySelectorAll(".teach-back").length,
    glossaryTermCount: document.querySelectorAll(".glossary-grid p").length,
    introHeadingLevel: document.querySelector(".concept-walkthrough--intro .walkthrough-title")?.tagName,
    introHeadingParent: document.querySelector(".concept-walkthrough--intro .walkthrough-title")?.parentElement.tagName,
    summaryFocus: (() => {
      const summary = document.querySelector(".concept-walkthrough > summary");
      summary.focus({ preventScroll: true });
      return {
        visible: summary.matches(":focus-visible"),
        outlineOffset: getComputedStyle(summary).outlineOffset
      };
    })(),
    darkSummaryFocus: (() => {
      const summary = document.querySelector("#shadow .concept-walkthrough > summary");
      summary.focus({ preventScroll: true });
      return {
        visible: summary.matches(":focus-visible"),
        outlineColor: getComputedStyle(summary).outlineColor
      };
    })(),
    duplicateIds: [...document.querySelectorAll("[id]")]
      .map((node) => node.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
    localOnly: performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .every((url) => url.startsWith("${baseUrl}")),
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  }))()`);
  assert.equal(initial.title, "선택의 박물관 · 260729 TTT");
  assert.equal(initial.h1.replace(/\s+/g, " "), "선택의 박물관");
  assert.equal(initial.quizCount, 8);
  assert.equal(initial.walkthroughCount, 10);
  assert.equal(initial.openWalkthroughCount, 10);
  assert.equal(initial.lessonCardCount, 30);
  assert.equal(initial.teachBackCount, 10);
  assert.equal(initial.glossaryTermCount, 15);
  assert.equal(initial.introHeadingLevel, "H2");
  assert.equal(initial.introHeadingParent, "SUMMARY");
  assert.equal(initial.summaryFocus.visible, true);
  assert.equal(initial.summaryFocus.outlineOffset, "-4px");
  assert.equal(initial.darkSummaryFocus.visible, true);
  assert.equal(initial.darkSummaryFocus.outlineColor, "rgb(255, 202, 92)");
  assert.deepEqual(initial.duplicateIds, []);
  assert.equal(initial.localOnly, true);
  assert.equal(initial.noHorizontalOverflow, true);

  const explanationModes = await evaluate(`(() => {
    document.querySelector('input[name="explanation-mode"][value="quick"]').click();
    const quick = {
      open: document.querySelectorAll("[data-walkthrough][open]").length,
      duration: document.querySelector("#visit-duration").textContent
    };
    document.querySelector('input[name="explanation-mode"][value="guided"]').click();
    const guided = {
      open: document.querySelectorAll("[data-walkthrough][open]").length,
      duration: document.querySelector("#visit-duration").textContent
    };
    return { quick, guided };
  })()`);
  assert.equal(explanationModes.quick.open, 0);
  assert.match(explanationModes.quick.duration, /12분/);
  assert.equal(explanationModes.guided.open, 10);
  assert.match(explanationModes.guided.duration, /25분/);

  const skipLinks = await evaluate(`(async () => {
    document.querySelector('.skip-link[href="#main"]').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const mainFocused = document.activeElement?.id === "main";
    document.querySelector('.skip-link[href="#docent"]').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const docentFocused = document.activeElement?.id === "docent";
    window.scrollTo(0, 0);
    return { mainFocused, docentFocused };
  })()`);
  assert.equal(skipLinks.mainFocused, true);
  assert.equal(skipLinks.docentFocused, true);

  const earlyQuiz = await evaluate(`(() => {
    const answers = {
      constraint: "constraint",
      shadow: "shadow",
      causal: "relation",
      counterfactual: "comparison",
      measurement: "audit-more",
      uncertainty: "estimate-range",
      agent: "approve",
      "zero-token": "tool"
    };
    Object.entries(answers).forEach(([id, answer]) => {
      document.querySelector(
        'input[name="quiz-' + id + '"][value="' + answer + '"]'
      ).checked = true;
    });
    document.querySelector("#mastery-quiz").requestSubmit();
    return {
      certificateHidden: document.querySelector("#certificate").hidden,
      result: document.querySelector("#quiz-result").textContent
    };
  })()`);
  assert.equal(earlyQuiz.certificateHidden, true);
  assert.match(earlyQuiz.result, /체험 뒤 열립니다/);

  const journey = await evaluate(`(() => {
    const click = (selector) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error("Missing selector: " + selector);
      node.click();
    };
    const plus = (id, count) => {
      for (let index = 0; index < count; index += 1) {
        click('[data-activity="' + id + '"] [data-action="plus"]');
      }
    };
    click(".primary-cta[href='#scarcity']");
    plus("understanding", 3);
    plus("verification", 3);
    plus("experience", 2);
    click('[data-opt-prediction="mine"]');
    click("#run-optimizer");
    click('[data-shadow-prediction="verification"]');
    click("#reveal-shadow");
    click("#toggle-readiness");
    click('[data-experiment="random"]');
    const audit = {
      shadow: "understood",
      cause: "confused",
      objective: "understood",
      zero: "confused",
    };
    Object.entries(audit).forEach(([id, label]) =>
      click('[data-audit-id="' + id + '"][data-audit-label="' + label + '"]'),
    );
    document.querySelectorAll(".approval-gates input").forEach((input) => input.click());
    click("#reject-proposal");
    const rejectionReturnedToQuestion =
      document.activeElement?.matches('input[name="goal"]') &&
      document.querySelector("#approve-proposal").disabled &&
      document.querySelectorAll(".approval-gates input:checked").length === 0;
    const verificationGoal = document.querySelector('input[name="goal"][value="verification"]');
    verificationGoal.checked = true;
    verificationGoal.dispatchEvent(new Event("change", { bubbles: true }));
    const balanceGoal = document.querySelector('input[name="goal"][value="balance"]');
    balanceGoal.checked = true;
    balanceGoal.dispatchEvent(new Event("change", { bubbles: true }));
    click("#revise-proposal");
    const revisionVisible =
      document.querySelector("#proposal-body").textContent.includes("현실의 최적안") &&
      document.querySelector("#proposal-uncertainty").textContent.includes("오차범위");
    document.querySelectorAll(".approval-gates input").forEach((input) => input.click());
    click("#approve-proposal");
    const runs = document.querySelector("#runs");
    runs.value = "31";
    runs.dispatchEvent(new Event("input", { bubbles: true }));
    const quiz = {
      constraint: "constraint",
      shadow: "shadow",
      causal: "relation",
      counterfactual: "comparison",
      measurement: "audit-more",
      uncertainty: "estimate-range",
      agent: "approve",
      "zero-token": "tool",
    };
    Object.entries(quiz).forEach(([id, answer]) => {
      const input = document.querySelector(
        'input[name="quiz-' + id + '"][value="' + answer + '"]',
      );
      input.checked = true;
    });
    document.querySelector("#mastery-quiz").requestSubmit();
    const state = JSON.parse(localStorage.getItem("260729TTT-tour-v1"));
    return {
      manualScore: document.querySelector("#manual-score").textContent,
      optimum: document.querySelector("#optimizer-result").textContent,
      shadow: document.querySelector("#shadow-value").textContent,
      causal: document.querySelector("#causal-answer").textContent,
      experiment: document.querySelector("#experiment-result").textContent,
      audit: document.querySelector("#audit-summary").textContent,
      proposal: document.querySelector("#proposal-status").textContent,
      quiz: document.querySelector("#quiz-result").textContent,
      certificateVisible: !document.querySelector("#certificate").hidden,
      completed: Object.keys(state.completed).filter((key) => state.completed[key]).length,
      rejectionReturnedToQuestion,
      revisionVisible,
    };
  })()`);

  assert.equal(journey.manualScore, "109점");
  assert.match(journey.optimum, /109점/);
  assert.equal(journey.shadow, "9");
  assert.match(journey.causal, /시간당 관계는 0점/);
  assert.match(journey.experiment, /약 \+2점/);
  assert.match(journey.audit, /검증표본 4개/);
  assert.match(journey.proposal, /사람 승인/);
  assert.match(journey.quiz, /8 \/ 8/);
  assert.equal(journey.certificateVisible, true);
  assert.equal(journey.completed, 10);
  assert.equal(journey.rejectionReturnedToQuestion, true);
  assert.equal(journey.revisionVisible, true);

  const budgetGateReset = await evaluate(`(() => {
    const budget = document.querySelector("#budget");
    budget.value = "9";
    budget.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      checked: document.querySelectorAll(".approval-gates input:checked").length,
      approveDisabled: document.querySelector("#approve-proposal").disabled
    };
  })()`);
  assert.equal(budgetGateReset.checked, 0);
  assert.equal(budgetGateReset.approveDisabled, true);

  await evaluate(`(() => {
    const understandingGoal = document.querySelector(
      'input[name="goal"][value="understanding"]'
    );
    understandingGoal.checked = true;
    understandingGoal.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('[data-depth="deep"]').click();
    document.documentElement.style.scrollBehavior = "auto";
    document.querySelector("#garden").scrollIntoView({ block: "start" });
  })()`);
  await wait(150);
  const dynamicGardenDocent = await evaluate(
    `document.querySelector("#docent-message").textContent`,
  );
  assert.match(dynamicGardenDocent, /9칸/);
  assert.match(dynamicGardenDocent, /이해 4 · 검증 4 · 체험 1/);
  assert.match(dynamicGardenDocent, /140.3점/);
  assert.doesNotMatch(dynamicGardenDocent, /109점/);

  const shadowTransition = await evaluate(`(async () => {
    const section = document.querySelector("#shadow");
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    const start = sectionTop - window.innerHeight * 0.65;
    const end = sectionTop + Math.min(900, section.offsetHeight * 0.4);
    for (let y = start; y <= end; y += 80) {
      window.scrollTo(0, y);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      active: document.querySelector('[data-route][aria-current="location"]')?.dataset.route,
      message: document.querySelector("#docent-message").textContent
    };
  })()`);
  assert.equal(shadowTransition.active, "shadow");
  assert.match(shadowTransition.message, /9칸 최고점 140.3/);
  assert.match(shadowTransition.message, /10칸 최고점 149.3/);
  assert.match(shadowTransition.message, /빼면 9/);
  assert.doesNotMatch(shadowTransition.message, /109|118/);

  const exitTransition = await evaluate(`(async () => {
    const section = document.querySelector("#exit");
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const start = sectionTop - window.innerHeight * 0.65;
    const end = Math.min(maxScroll, sectionTop + Math.min(900, section.offsetHeight * 0.35));
    window.scrollTo(0, start);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let y = start; y <= end; y += 80) {
      window.scrollTo(0, y);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      active: document.querySelector('[data-route][aria-current="location"]')?.dataset.route,
      message: document.querySelector("#docent-message").textContent
    };
  })()`);
  assert.equal(exitTransition.active, "exit");
  assert.match(exitTransition.message, /전이는/);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait(100);
  const mobile = await evaluate(`(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    docentVisible: getComputedStyle(document.querySelector("#docent")).display !== "none",
    docentDepthVisible: getComputedStyle(document.querySelector(".docent__depth")).display !== "none",
    progressVisible: getComputedStyle(document.querySelector(".topbar__progress")).display !== "none",
    targetSizes: [
      "[data-walkthrough] > summary",
      "#toggle-readiness",
      "#run-optimizer",
      "#reveal-shadow",
      "#approve-proposal"
    ].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, width: rect.width, height: rect.height };
    }),
    readingFontSizes: [
      ".lesson-grid p",
      ".worked-example p",
      ".room-bridge span",
      ".glossary-grid span",
      ".quiz-options label",
      ".docent__message"
    ].map((selector) => ({
      selector,
      size: Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
    })),
  }))()`);
  assert.equal(mobile.width, 390);
  assert.equal(mobile.noHorizontalOverflow, true, `mobile scroll width was ${mobile.scrollWidth}`);
  assert.equal(mobile.docentVisible, true);
  assert.equal(mobile.docentDepthVisible, true);
  assert.equal(mobile.progressVisible, true);
  mobile.targetSizes.forEach((target) => {
    assert.ok(target.height >= 44, `${target.selector} height was ${target.height}`);
  });
  mobile.readingFontSizes.forEach((text) => {
    assert.ok(text.size >= 15, `${text.selector} font size was ${text.size}`);
  });

  await evaluate(`localStorage.setItem("260729TTT-tour-v1", JSON.stringify({
    goal: "broken",
    explanationMode: "too-much",
    budget: "many",
    shadowPrediction: "not-an-activity",
    experiment: "not-an-experiment",
    approvalGates: ["why", "why", "unknown"],
    proposalStatus: "approved",
    price: {
      monthlyPrice: "free",
      weeklyListValue: -1,
      utilizationPercent: 900,
      assumedCostRatioPercent: null
    },
    docentDepth: "verbose",
    completed: { entrance: true, unknown: true }
  }))`);
  await cdp.send("Page.reload", { ignoreCache: true });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(50);
    try {
      if ((await evaluate("document.readyState")) === "complete") break;
    } catch {
      // The JavaScript execution context is briefly replaced during reload.
    }
  }
  await wait(150);
  const recovered = await evaluate(`(() => ({
    monthlyPrice: document.querySelector("#monthly-price").value,
    shadow: document.querySelector("#shadow-value").textContent,
    goal: document.querySelector('input[name="goal"]:checked')?.value,
    proposal: document.querySelector("#proposal-status").textContent,
    selectedExperiments: document.querySelectorAll("[data-experiment].is-selected").length,
    explanationMode: document.querySelector('input[name="explanation-mode"]:checked')?.value,
    openWalkthroughs: document.querySelectorAll("[data-walkthrough][open]").length
  }))()`);
  assert.equal(recovered.monthlyPrice, "30000");
  assert.equal(recovered.shadow, "?");
  assert.equal(recovered.goal, "balance");
  assert.match(recovered.proposal, /승인 대기/);
  assert.equal(recovered.selectedExperiments, 0);
  assert.equal(recovered.explanationMode, "guided");
  assert.equal(recovered.openWalkthroughs, 10);

  const browserErrors = cdp.events.filter(
    (event) =>
      event.method === "Runtime.exceptionThrown" ||
      (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"),
  );
  assert.deepEqual(browserErrors, []);
  cdp.close();
  process.stdout.write(
    "Browser smoke passed: 10 guided lessons, continuous room tracking, dynamic goal/budget docent, skip links, dark focus, full 10-stop journey, approval loop, storage recovery, 8/8 quiz, desktop and 390px mobile\n",
  );
}

try {
  await main();
} finally {
  if (browser && browser.exitCode === null) browser.kill("SIGTERM");
  if (server && server.exitCode === null) server.kill("SIGTERM");
  rmSync(profile, { recursive: true, force: true });
}
