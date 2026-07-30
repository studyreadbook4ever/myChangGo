import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = 4280;
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

const profile = mkdtempSync(join(tmpdir(), "ttt-course-chromium-"));
let server;
let browser;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHttp(url, attempts = 100) {
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

async function waitForTarget(debugPort, attempts = 100) {
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
  const malformedPathResponse = await fetch(`${baseUrl}%E0%A4%A`);
  assert.equal(malformedPathResponse.status, 400);
  assert.equal((await fetch(baseUrl)).ok, true);

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

  async function waitForCourseReady(expectedUrl = null) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      try {
        const pageState = await evaluate(`({
          ready: document.documentElement.dataset.ready,
          href: window.location.href
        })`);
        if (
          pageState.ready === "true" &&
          (expectedUrl === null || pageState.href === expectedUrl)
        ) {
          return;
        }
      } catch {
        // The execution context is replaced during navigation.
      }
      await wait(50);
    }
    throw new Error("Course did not publish its ready signal");
  }

  await waitForCourseReady();

  const initial = await evaluate(`(() => {
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    const localAnchors = [...document.querySelectorAll('a[href^="#"]')]
      .map((anchor) => anchor.getAttribute("href").slice(1))
      .filter(Boolean);
    const hasAccessibleName = (node) => {
      const labelledBy = (node.getAttribute("aria-labelledby") || "")
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      const nativeLabels = [...(node.labels || [])]
        .map((label) => label.textContent || "")
        .join(" ");
      return [
        node.getAttribute("aria-label"),
        labelledBy,
        nativeLabels,
        node.getAttribute("alt"),
        node.getAttribute("title"),
        node.matches("button, a[href]") ? node.textContent : "",
        node.matches('input[type="button"], input[type="submit"], input[type="reset"]')
          ? node.value
          : ""
      ].some((candidate) => candidate?.trim());
    };
    const interactiveElements = [
      ...document.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea'
      )
    ];
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent.trim(),
      partCount: document.querySelectorAll(".course-part").length,
      lessonCount: document.querySelectorAll(".lesson").length,
      openLessonCount: document.querySelectorAll(".lesson[open]").length,
      caseCount: document.querySelectorAll(".case-card").length,
      glossaryCount: document.querySelectorAll(".glossary-entry").length,
      sourceCount: document.querySelectorAll(".source-card").length,
      capstoneCount: document.querySelectorAll(".capstone-field").length,
      lpVertices: document.querySelectorAll("#lp-chart circle").length,
      lessonHeadingCount: document.querySelectorAll(
        ".lesson > summary > .lesson__summary-heading"
      ).length,
      uniqueCompletionNames: (() => {
        const names = [...document.querySelectorAll("[data-complete-lesson]")]
          .map((node) => node.getAttribute("aria-label"));
        return names.length === 40 && new Set(names).size === 40;
      })(),
      sourceLinksNameTheirSource: [
        ...document.querySelectorAll(".lesson-sources a, .source-card a")
      ].every((link) => {
        const sourceTitle =
          link.closest(".source-card")?.querySelector("h3")?.textContent.trim() ||
          link.textContent.trim();
        return (link.getAttribute("aria-label") || "").includes(sourceTitle);
      }),
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      brokenLocalAnchors: localAnchors.filter((id) => !document.getElementById(id)),
      unnamedInteractiveElements: interactiveElements
        .filter((node) => !hasAccessibleName(node))
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          id: node.id,
          name: node.getAttribute("name"),
          type: node.getAttribute("type")
        })),
      localOnly: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .every((url) => url.startsWith("${baseUrl}")),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      ready: document.documentElement.dataset.ready
    };
  })()`);

  assert.equal(initial.title, "하루의 목적함수 · 칸토로비치에서 AI 일일경제까지");
  assert.equal(initial.h1, "하루의 목적함수");
  assert.equal(initial.partCount, 8);
  assert.equal(initial.lessonCount, 40);
  assert.equal(initial.openLessonCount, 0);
  assert.equal(initial.caseCount, 12);
  assert.equal(initial.glossaryCount, 80);
  assert.equal(initial.sourceCount, 44);
  assert.equal(initial.capstoneCount, 10);
  assert.ok(initial.lpVertices >= 4);
  assert.equal(initial.lessonHeadingCount, 40);
  assert.equal(initial.uniqueCompletionNames, true);
  assert.equal(initial.sourceLinksNameTheirSource, true);
  assert.deepEqual(initial.duplicateIds, []);
  assert.deepEqual(initial.brokenLocalAnchors, []);
  assert.deepEqual(initial.unnamedInteractiveElements, []);
  assert.equal(initial.localOnly, true);
  assert.equal(initial.noHorizontalOverflow, true);
  assert.equal(initial.ready, "true");

  const readingModes = await evaluate(`(() => {
    const choose = (value) => {
      const radio = document.querySelector('input[name="density"][value="' + value + '"]');
      radio.click();
      return document.querySelectorAll(".lesson[open]").length;
    };
    return {
      all: choose("all"),
      map: choose("map"),
      guided: choose("guided")
    };
  })()`);
  assert.equal(readingModes.all, 40);
  assert.equal(readingModes.map, 0);
  assert.equal(readingModes.guided, 1);

  const search = await evaluate(`(() => {
    const input = document.querySelector("#course-search");
    input.value = "그림자가격";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = [...document.querySelectorAll(".lesson")].filter((node) => !node.hidden).length;
    const visibleParts = [...document.querySelectorAll(".course-part")].filter((node) => !node.hidden).length;
    const status = document.querySelector("#course-search-status").textContent;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      visible,
      visibleParts,
      status,
      openAfterClear: document.querySelectorAll(".lesson[open]").length
    };
  })()`);
  assert.ok(search.visible > 0 && search.visible < 40);
  assert.ok(search.visibleParts > 0 && search.visibleParts < 8);
  assert.match(search.status, /그림자가격/);
  assert.equal(search.openAfterClear, 1);

  const lessonInteraction = await evaluate(`(async () => {
    const lesson = document.querySelector(".lesson");
    lesson.open = true;
    const option = lesson.querySelector(".checkpoint__option");
    option.click();
    const checkpoint = lesson.querySelector(".checkpoint__answer").textContent;
    const complete = lesson.querySelector("[data-complete-lesson]");
    complete.click();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const stored = JSON.parse(localStorage.getItem("260729TTT-course-v2"));
    return {
      checkpoint,
      progress: document.querySelector("#lesson-progress-label").textContent,
      storedCompleted: stored.completedLessonIds.length,
      selected: option.dataset.selected,
      pressed: option.getAttribute("aria-pressed"),
      openLessonId: document.querySelector(".lesson[open]")?.id,
      focusedTag: document.activeElement?.tagName,
      focusedLessonId: document.activeElement?.closest(".lesson")?.id
    };
  })()`);
  assert.doesNotMatch(lessonInteraction.checkpoint, /답을 고르면/);
  assert.equal(lessonInteraction.progress, "1 / 40강");
  assert.equal(lessonInteraction.storedCompleted, 1);
  assert.equal(lessonInteraction.selected, "true");
  assert.equal(lessonInteraction.pressed, "true");
  assert.equal(lessonInteraction.openLessonId, "lesson-02");
  assert.equal(lessonInteraction.focusedTag, "SUMMARY");
  assert.equal(lessonInteraction.focusedLessonId, "lesson-02");

  const calculators = await evaluate(`(() => {
    const before = document.querySelector("#lp-result").textContent;
    const capacity = document.querySelector('#lp-form [name="capacityWriting"]');
    capacity.value = "20";
    capacity.dispatchEvent(new Event("input", { bubbles: true }));
    const after = document.querySelector("#lp-result").textContent;
    const delta = document.querySelector("#shadow-delta");
    delta.value = "4";
    delta.dispatchEvent(new Event("input", { bubbles: true }));
    const probability = document.querySelector("#normal-probability");
    probability.value = "20";
    probability.dispatchEvent(new Event("input", { bubbles: true }));
    const price = document.querySelector('#access-form [name="price"]');
    price.value = "60000";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      lpChanged: before !== after,
      optimumDots: document.querySelectorAll("#lp-chart .lp-optimum").length,
      dual: document.querySelector("#dual-result").textContent,
      uncertaintyRows: document.querySelectorAll(".decision-table tbody tr").length,
      access: document.querySelector("#access-result").textContent
    };
  })()`);
  assert.equal(calculators.lpChanged, true);
  assert.equal(calculators.optimumDots, 1);
  assert.match(calculators.dual, /단위당 차분가치/);
  assert.equal(calculators.uncertaintyRows, 3);
  assert.match(calculators.access, /가격 부담률/);

  const lpExtremes = await evaluate(`(() => {
    const writing = document.querySelector('#lp-form [name="capacityWriting"]');
    const review = document.querySelector('#lp-form [name="capacityReview"]');
    const inspect = (writingValue, reviewValue) => {
      writing.value = String(writingValue);
      review.value = String(reviewValue);
      review.dispatchEvent(new Event("input", { bubbles: true }));
      const polygonBox = document.querySelector("#lp-chart .lp-feasible").getBBox();
      return {
        constraints: document.querySelectorAll("#lp-chart .lp-constraint").length,
        labels: document.querySelectorAll("#lp-chart .lp-constraint-label").length,
        polygonWidth: polygonBox.width,
        polygonHeight: polygonBox.height
      };
    };
    return [inspect(20, 4), inspect(4, 20)];
  })()`);
  lpExtremes.forEach((result) => {
    assert.equal(result.constraints, 2);
    assert.equal(result.labels, 2);
    assert.ok(result.polygonWidth > 100);
    assert.ok(result.polygonHeight > 100);
  });

  const filters = await evaluate(`(() => {
    const caseFilter = document.querySelector("#case-filter");
    caseFilter.value = "ai";
    caseFilter.dispatchEvent(new Event("change", { bubbles: true }));
    const visibleCases = [...document.querySelectorAll(".case-card")].filter((node) => !node.hidden).length;
    const glossarySearch = document.querySelector("#glossary-search");
    glossarySearch.value = "쌍대";
    glossarySearch.dispatchEvent(new Event("input", { bubbles: true }));
    const visibleTerms = [...document.querySelectorAll(".glossary-entry")].filter((node) => !node.hidden).length;
    return {
      visibleCases,
      visibleTerms,
      caseStatus: document.querySelector("#case-filter-status").textContent,
      glossaryStatus: document.querySelector("#glossary-status").textContent
    };
  })()`);
  assert.ok(filters.visibleCases > 0 && filters.visibleCases < 12);
  assert.ok(filters.visibleTerms > 0 && filters.visibleTerms < 80);
  assert.match(filters.caseStatus, /개 사례/);
  assert.match(filters.glossaryStatus, /개 용어/);

  const capstone = await evaluate(`(() => {
    const first = document.querySelector(".capstone-field textarea");
    first.value = "냉방과 취약계층 상담을 하드 제약으로 먼저 지킨다.";
    document.querySelector("#save-capstone").click();
    const saved = JSON.parse(localStorage.getItem("260729TTT-course-v2")).capstoneDraft[first.name];
    first.value = "가".repeat(5001);
    document.querySelector("#save-capstone").click();
    document.querySelector("#reveal-capstone").click();
    return {
      saved,
      maxLength: first.maxLength,
      cappedSavedLength:
        JSON.parse(localStorage.getItem("260729TTT-course-v2")).capstoneDraft[first.name].length,
      rubricVisible: !document.querySelector("#capstone-rubric").hidden,
      rubricItems: document.querySelectorAll("#capstone-rubric li").length,
      expanded: document.querySelector("#reveal-capstone").getAttribute("aria-expanded"),
      scrollRegionsFocusable:
        document.querySelector(".system-map").tabIndex === 0 &&
        document.querySelector(".decision-table-scroll").tabIndex === 0
    };
  })()`);
  assert.match(capstone.saved, /냉방/);
  assert.equal(capstone.maxLength, 5000);
  assert.equal(capstone.cappedSavedLength, 5000);
  assert.equal(capstone.rubricVisible, true);
  assert.ok(capstone.rubricItems >= 8);
  assert.equal(capstone.expanded, "true");
  assert.equal(capstone.scrollRegionsFocusable, true);

  const failedCapstoneSave = await evaluate(`(() => {
    const originalSetItem = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = () => {
        throw new DOMException("blocked", "QuotaExceededError");
      };
      document.querySelector("#save-capstone").click();
      return document.querySelector("#capstone-status").textContent;
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  })()`);
  assert.match(failedCapstoneSave, /저장하지 못했습니다/);

  const closedRubric = await evaluate(`(() => {
    const rubric = document.querySelector("#capstone-rubric");
    if (!rubric.hidden) document.querySelector("#reveal-capstone").click();
    document.querySelector('input[name="density"][value="map"]').click();
    return {
      hidden: rubric.hidden,
      expanded: document.querySelector("#reveal-capstone").getAttribute("aria-expanded")
    };
  })()`);
  assert.equal(closedRubric.hidden, true);
  assert.equal(closedRubric.expanded, "false");

  await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
  const printCompleteness = await evaluate(`(() => {
    const displayed = (selector) =>
      [...document.querySelectorAll(selector)].filter(
        (node) => getComputedStyle(node).display !== "none"
      ).length;
    return {
      lessonBodies: displayed(".lesson__body"),
      cases: displayed(".case-card"),
      glossaryEntries: displayed(".glossary-entry"),
      rubricDisplayed:
        getComputedStyle(document.querySelector("#capstone-rubric")).display !== "none",
      hiddenAttributesPreserved: {
        cases: document.querySelectorAll(".case-card[hidden]").length,
        glossaryEntries: document.querySelectorAll(".glossary-entry[hidden]").length,
        rubric: document.querySelector("#capstone-rubric").hidden
      },
      controlsSuppressed: [
        ".filter-box",
        ".search-box--compact",
        ".search-status",
        ".capstone-actions"
      ].every(
        (selector) => getComputedStyle(document.querySelector(selector)).display === "none"
      )
    };
  })()`);
  assert.equal(printCompleteness.lessonBodies, 40);
  assert.equal(printCompleteness.cases, 12);
  assert.equal(printCompleteness.glossaryEntries, 80);
  assert.equal(printCompleteness.rubricDisplayed, true);
  assert.ok(printCompleteness.hiddenAttributesPreserved.cases > 0);
  assert.ok(printCompleteness.hiddenAttributesPreserved.glossaryEntries > 0);
  assert.equal(printCompleteness.hiddenAttributesPreserved.rubric, true);
  assert.equal(printCompleteness.controlsSuppressed, true);

  await cdp.send("Emulation.setEmulatedMedia", { media: "screen" });
  const restoredScreen = await evaluate(`(() => {
    const result = {
      visibleCases: [...document.querySelectorAll(".case-card")].filter(
        (node) => getComputedStyle(node).display !== "none"
      ).length,
      visibleTerms: [...document.querySelectorAll(".glossary-entry")].filter(
        (node) => getComputedStyle(node).display !== "none"
      ).length,
      rubricHidden:
        getComputedStyle(document.querySelector("#capstone-rubric")).display === "none"
    };
    document.querySelector('input[name="density"][value="guided"]').click();
    return result;
  })()`);
  assert.equal(restoredScreen.visibleCases, filters.visibleCases);
  assert.equal(restoredScreen.visibleTerms, filters.visibleTerms);
  assert.equal(restoredScreen.rubricHidden, true);

  const skipFocus = await evaluate(`(async () => {
    document.querySelector(".skip-link").click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return document.activeElement?.id;
  })()`);
  assert.equal(skipFocus, "main");

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
    targets: [
      ".header-lab-link",
      ".mobile-nav summary",
      ".button--primary",
      ".lesson > summary",
      ".lesson[open] .checkpoint__option",
      "#save-capstone"
    ].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, height: rect.height, width: rect.width };
    }),
    fontSizes: [
      ".hero__lead",
      ".lesson-section p",
      ".case-card > p",
      ".glossary-entry dd"
    ].map((selector) => ({
      selector,
      size: Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
    }))
  }))()`);
  assert.equal(mobile.width, 390);
  assert.equal(mobile.noHorizontalOverflow, true, `mobile scroll width was ${mobile.scrollWidth}`);
  mobile.targets.forEach((target) => {
    assert.ok(target.height >= 44, `${target.selector} height was ${target.height}`);
  });
  mobile.fontSizes.forEach((text) => {
    assert.ok(text.size >= 14, `${text.selector} font size was ${text.size}`);
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait(100);
  const narrowMobile = await evaluate(`(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    headerTargets: [".wordmark", ".mobile-nav summary", ".header-lab-link"].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { selector, height: rect.height };
    })
  }))()`);
  assert.equal(narrowMobile.width, 320);
  assert.equal(
    narrowMobile.noHorizontalOverflow,
    true,
    `320px scroll width was ${narrowMobile.scrollWidth}`,
  );
  narrowMobile.headerTargets.forEach((target) => {
    assert.ok(target.height >= 44, `${target.selector} height was ${target.height} at 320px`);
  });

  await evaluate(`localStorage.setItem("260729TTT-course-v2", JSON.stringify({
    schemaVersion: 2,
    courseVersion: "2026-07-30",
    completedLessonIds: [],
    density: "map",
    quizAttempts: {
      "lesson-01": { selected: 0, correct: true, attemptedAt: "2026-07-30T00:00:00.000Z" }
    },
    capstoneDraft: {}
  }))`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForCourseReady();
  const recomputedQuiz = await evaluate(`(() => {
    const stored = JSON.parse(localStorage.getItem("260729TTT-course-v2"));
    const lesson = document.querySelector("#lesson-01");
    return {
      selected: lesson.querySelector('[data-option-index="0"]').dataset.selected,
      feedback: lesson.querySelector(".checkpoint__answer").textContent,
      storedCorrect: stored.quizAttempts["lesson-01"].correct
    };
  })()`);
  assert.equal(recomputedQuiz.selected, "true");
  assert.match(recomputedQuiz.feedback, /한 번 더 구분해 봅시다/);
  assert.equal(recomputedQuiz.storedCorrect, false);

  await evaluate(`localStorage.setItem("260729TTT-course-v2", JSON.stringify({
    schemaVersion: 2,
    courseVersion: "outdated-content",
    completedLessonIds: ["lesson-01"],
    density: "guided",
    quizAttempts: {
      "lesson-01": { selected: 1, correct: true }
    },
    capstoneDraft: { problem: "버전이 바뀌어도 남겨야 할 나의 초안" }
  }))`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForCourseReady();
  const migratedState = await evaluate(`(() => {
    const stored = JSON.parse(localStorage.getItem("260729TTT-course-v2"));
    return {
      progress: document.querySelector("#lesson-progress-label").textContent,
      selectedOptions: document.querySelectorAll('.checkpoint__option[data-selected="true"]').length,
      density: document.querySelector('input[name="density"]:checked')?.value,
      capstone: document.querySelector('[name="problem"]').value,
      storedVersion: stored.courseVersion
    };
  })()`);
  assert.equal(migratedState.progress, "0 / 40강");
  assert.equal(migratedState.selectedOptions, 0);
  assert.equal(migratedState.density, "guided");
  assert.match(migratedState.capstone, /나의 초안/);
  assert.equal(migratedState.storedVersion, "2026-07-30");

  await evaluate(`localStorage.setItem("260729TTT-course-v2", JSON.stringify({
    schemaVersion: 2,
    courseVersion: "2026-07-30",
    completedLessonIds: Array.from({ length: 39 }, (_, index) =>
      "lesson-" + String(index + 1).padStart(2, "0")
    ),
    density: "guided",
    quizAttempts: {},
    capstoneDraft: { problem: "초기화 뒤에도 남는 초안" }
  }))`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForCourseReady();
  const guidedCompletion = await evaluate(`(async () => {
    document.querySelector('#lesson-40 [data-complete-lesson]').click();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const completed = {
      progress: document.querySelector("#lesson-progress-label").textContent,
      openLessons: document.querySelectorAll(".lesson[open]").length,
      firstOpen: document.querySelector("#lesson-01").open,
      focusedId: document.activeElement?.id
    };
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    document.querySelector("#reset-course").click();
    window.confirm = originalConfirm;
    return {
      completed,
      reset: {
        progress: document.querySelector("#lesson-progress-label").textContent,
        openLessonId: document.querySelector(".lesson[open]")?.id,
        capstone: document.querySelector('[name="problem"]').value
      }
    };
  })()`);
  assert.equal(guidedCompletion.completed.progress, "40 / 40강");
  assert.equal(guidedCompletion.completed.openLessons, 0);
  assert.equal(guidedCompletion.completed.firstOpen, false);
  assert.equal(guidedCompletion.completed.focusedId, "lesson-progress-label");
  assert.equal(guidedCompletion.reset.progress, "0 / 40강");
  assert.equal(guidedCompletion.reset.openLessonId, "lesson-01");
  assert.match(guidedCompletion.reset.capstone, /초기화 뒤에도 남는 초안/);

  await evaluate(`localStorage.setItem("260729TTT-course-v2", JSON.stringify({
    schemaVersion: 999,
    courseVersion: "broken",
    completedLessonIds: ["missing", null],
    density: "everything",
    quizAttempts: "broken",
    capstoneDraft: "broken"
  }))`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForCourseReady();
  const recovered = await evaluate(`(() => ({
    progress: document.querySelector("#lesson-progress-label").textContent,
    density: document.querySelector('input[name="density"]:checked')?.value,
    completed: document.querySelectorAll("[data-complete-lesson]:checked").length,
    capstoneValue: document.querySelector(".capstone-field textarea").value,
    ready: document.documentElement.dataset.ready
  }))()`);
  assert.equal(recovered.progress, "0 / 40강");
  assert.equal(recovered.density, "map");
  assert.equal(recovered.completed, 0);
  assert.equal(recovered.capstoneValue, "");
  assert.equal(recovered.ready, "true");

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  for (const targetId of ["studio", "cases", "finish"]) {
    const directUrl = `${baseUrl}?deep-link=${targetId}#${targetId}`;
    await cdp.send("Page.navigate", { url: directUrl });
    await waitForCourseReady(directUrl);
    const position = await evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = document.getElementById(${JSON.stringify(targetId)});
        const header = document.querySelector(".site-header");
        resolve({
          targetTop: target.getBoundingClientRect().top,
          headerBottom: header.getBoundingClientRect().bottom,
          scrollPaddingTop: Number.parseFloat(
            getComputedStyle(document.documentElement).scrollPaddingTop
          )
        });
      }));
    })`);
    assert.ok(
      Math.abs(position.targetTop - position.scrollPaddingTop) <= 2,
      `#${targetId} top was ${position.targetTop}; expected ${position.scrollPaddingTop}`,
    );
    assert.ok(
      position.targetTop >= position.headerBottom,
      `#${targetId} was obscured by the sticky header`,
    );
  }

  const lessonDeepLinkUrl = `${baseUrl}?deep-link=lesson#lesson-01`;
  await cdp.send("Page.navigate", { url: lessonDeepLinkUrl });
  await waitForCourseReady(lessonDeepLinkUrl);
  const lessonDeepLink = await evaluate(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const lesson = document.getElementById("lesson-01");
      const tools = document.querySelector(".course-tools");
      resolve({
        open: lesson.open,
        targetTop: lesson.getBoundingClientRect().top,
        toolsBottom: tools.getBoundingClientRect().bottom
      });
    }));
  })`);
  assert.equal(lessonDeepLink.open, true);
  assert.ok(
    lessonDeepLink.targetTop >= lessonDeepLink.toolsBottom,
    "#lesson-01 was obscured by the sticky course tools",
  );

  const browserErrors = cdp.events.filter(
    (event) =>
      event.method === "Runtime.exceptionThrown" ||
      (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"),
  );
  assert.deepEqual(browserErrors, []);
  cdp.close();
  process.stdout.write(
    "Course smoke passed: 8 parts, 40 lessons, 12 cases, 80 terms, source registry, four calculators, search, guided focus, state migration, capstone, accessible names, direct deep links, print, desktop and mobile\n",
  );
}

try {
  await main();
} finally {
  if (browser && browser.exitCode === null) browser.kill("SIGTERM");
  if (server && server.exitCode === null) server.kill("SIGTERM");
  rmSync(profile, { recursive: true, force: true });
}
