import {
  analyzeDecisionUnderUncertainty,
  calculateAccessEconomics,
  estimateConstraintMarginalValue,
  solveTwoVariableLinearProgram,
} from "./model.js";
import {
  CAPSTONE_FIELDS,
  CAPSTONE_RUBRIC,
  CASES,
  COURSE_PARTS,
  GLOSSARY,
} from "./course-content.js";
import { SOURCES } from "./sources.js";

const STORAGE_KEY = "260729TTT-course-v2";
const SCHEMA_VERSION = 2;
const COURSE_VERSION = "2026-07-30";
const CAPSTONE_MAX_LENGTH = 5000;
const SVG_NS = "http://www.w3.org/2000/svg";

const defaultState = {
  schemaVersion: SCHEMA_VERSION,
  courseVersion: COURSE_VERSION,
  completedLessonIds: [],
  density: "map",
  quizAttempts: {},
  capstoneDraft: {},
};

function safeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeStoredState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function allLessons() {
  return COURSE_PARTS.flatMap((part) => part.lessons);
}

function validateContent() {
  const lessons = allLessons();
  const sourceIds = new Set(SOURCES.map((source) => source.id));
  const lessonIds = new Set();
  const partIds = new Set();
  const glossaryIds = new Set();

  if (COURSE_PARTS.length !== 8) {
    throw new Error(`교과서 데이터는 정확히 8부여야 합니다: ${COURSE_PARTS.length}`);
  }
  if (lessons.length !== 40) {
    throw new Error(`교과서 데이터는 정확히 40강이어야 합니다: ${lessons.length}`);
  }
  if (CASES.length !== 12) {
    throw new Error(`사례 데이터는 정확히 12개여야 합니다: ${CASES.length}`);
  }
  if (GLOSSARY.length !== 80) {
    throw new Error(`용어 데이터는 정확히 80개여야 합니다: ${GLOSSARY.length}`);
  }
  if (CAPSTONE_FIELDS.length !== 10) {
    throw new Error(`캡스톤 기록칸은 정확히 10개여야 합니다: ${CAPSTONE_FIELDS.length}`);
  }
  if (!Array.isArray(CAPSTONE_RUBRIC) || CAPSTONE_RUBRIC.length === 0) {
    throw new Error("캡스톤 검토 기준이 없습니다.");
  }

  COURSE_PARTS.forEach((part) => {
    if (!part.id || partIds.has(part.id)) throw new Error(`중복되거나 빈 부 ID: ${part.id}`);
    partIds.add(part.id);
    if (!Array.isArray(part.lessons) || part.lessons.length === 0) {
      throw new Error(`${part.id}에 강의가 없습니다.`);
    }
    if (
      typeof part.summary !== "string" ||
      !Array.isArray(part.learningObjectives) ||
      part.learningObjectives.length < 3
    ) {
      throw new Error(`${part.id}의 요약 또는 학습목표가 올바르지 않습니다.`);
    }
  });

  lessons.forEach((lesson) => {
    if (!lesson.id || lessonIds.has(lesson.id)) {
      throw new Error(`중복되거나 빈 강 ID: ${lesson.id}`);
    }
    lessonIds.add(lesson.id);
    if (!Array.isArray(lesson.sections) || lesson.sections.length < 2) {
      throw new Error(`${lesson.id}에는 설명 절이 최소 2개 필요합니다.`);
    }
    if (
      !lesson.workedExample ||
      !Array.isArray(lesson.workedExample.steps) ||
      lesson.workedExample.steps.length < 3
    ) {
      throw new Error(`${lesson.id}에는 3단계 이상의 완전 풀이가 필요합니다.`);
    }
    if (
      lesson.equation &&
      (typeof lesson.equation.expression !== "string" ||
        typeof lesson.equation.readAs !== "string")
    ) {
      throw new Error(`${lesson.id}의 수식 설명 스키마가 올바르지 않습니다.`);
    }
    if (
      !lesson.checkpoint ||
      !Array.isArray(lesson.checkpoint.options) ||
      lesson.checkpoint.options.length !== 3 ||
      !Number.isSafeInteger(lesson.checkpoint.answer) ||
      lesson.checkpoint.answer < 0 ||
      lesson.checkpoint.answer >= lesson.checkpoint.options.length
    ) {
      throw new Error(`${lesson.id}의 회상 문제가 올바르지 않습니다.`);
    }
    (lesson.sourceIds ?? []).forEach((sourceId) => {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`${lesson.id}가 존재하지 않는 출처 ${sourceId}를 참조합니다.`);
      }
    });
  });

  GLOSSARY.forEach((entry) => {
    if (!entry.id || glossaryIds.has(entry.id)) {
      throw new Error(`중복되거나 빈 용어 ID: ${entry.id}`);
    }
    glossaryIds.add(entry.id);
  });

  CASES.forEach((item) => {
    const requiredStrings = [
      item.title,
      item.categoryLabel,
      item.situation,
      item.decision,
      item.bottleneck,
      item.caution,
    ];
    if (requiredStrings.some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new Error(`${item.id} 사례의 필수 설명이 비어 있습니다.`);
    }
  });

  CAPSTONE_FIELDS.forEach((field) => {
    if (
      typeof field.prompt !== "string" ||
      field.prompt.trim() === "" ||
      typeof field.hint !== "string" ||
      field.hint.trim() === ""
    ) {
      throw new Error(`${field.id} 캡스톤 기록칸의 문구가 비어 있습니다.`);
    }
  });

  CAPSTONE_RUBRIC.forEach((item, index) => {
    if (
      typeof item.label !== "string" ||
      item.label.trim() === "" ||
      typeof item.criterion !== "string" ||
      item.criterion.trim() === ""
    ) {
      throw new Error(`${index + 1}번째 캡스톤 검토 기준의 문구가 비어 있습니다.`);
    }
  });
}

const rawStoredState = safeStoredState();
const storedState =
  rawStoredState.schemaVersion === SCHEMA_VERSION && !Array.isArray(rawStoredState)
    ? rawStoredState
    : {};
const lessonsById = new Map(allLessons().map((lesson) => [lesson.id, lesson]));
const knownLessonIds = new Set(lessonsById.keys());
const knownCapstoneIds = new Set(CAPSTONE_FIELDS.map((field) => field.id));
const contentState =
  storedState.courseVersion === COURSE_VERSION ? storedState : {};

function sanitizeQuizAttempts(attempts) {
  if (!attempts || typeof attempts !== "object" || Array.isArray(attempts)) return {};
  return Object.fromEntries(
    Object.entries(attempts).flatMap(([id, attempt]) => {
      const lesson = lessonsById.get(id);
      if (
        !lesson ||
        !attempt ||
        typeof attempt !== "object" ||
        Array.isArray(attempt) ||
        !Number.isSafeInteger(attempt.selected) ||
        attempt.selected < 0 ||
        attempt.selected >= lesson.checkpoint.options.length
      ) {
        return [];
      }
      const normalizedAttempt = {
        selected: attempt.selected,
        correct: attempt.selected === lesson.checkpoint.answer,
      };
      if (
        typeof attempt.attemptedAt === "string" &&
        attempt.attemptedAt.length <= 64 &&
        !Number.isNaN(Date.parse(attempt.attemptedAt))
      ) {
        normalizedAttempt.attemptedAt = attempt.attemptedAt;
      }
      return [[id, normalizedAttempt]];
    }),
  );
}

function sanitizeCapstoneDraft(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return {};
  return Object.fromEntries(
    Object.entries(draft)
      .filter(([id, value]) => knownCapstoneIds.has(id) && typeof value === "string")
      .map(([id, value]) => [id, value.slice(0, CAPSTONE_MAX_LENGTH)]),
  );
}

const state = {
  ...defaultState,
  schemaVersion: SCHEMA_VERSION,
  courseVersion: COURSE_VERSION,
  completedLessonIds: Array.isArray(contentState.completedLessonIds)
    ? [...new Set(contentState.completedLessonIds)].filter((id) => knownLessonIds.has(id))
    : [],
  density: ["map", "guided", "all"].includes(storedState.density)
    ? storedState.density
    : "map",
  quizAttempts: sanitizeQuizAttempts(contentState.quizAttempts),
  capstoneDraft: sanitizeCapstoneDraft(storedState.capstoneDraft),
};

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // Storage is optional. The course remains fully usable in private/locked-down contexts.
    return false;
  }
}

function sourceById(id) {
  return SOURCES.find((source) => source.id === id);
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: digits,
  }).format(value);
}

function formatWon(value) {
  return `${new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0,
  }).format(value)}원`;
}

function renderPartMap() {
  document.querySelector("#part-map").innerHTML = COURSE_PARTS.map(
    (part, index) => `
      <article class="part-map__item">
        <span class="part-map__number">${String(index + 1).padStart(2, "0")} · ${part.lessons.length}강</span>
        <h3>${safeText(part.title)}</h3>
        <p>${safeText(part.summary)}</p>
        <a href="#${safeText(part.id)}">이 부로 이동 ↓</a>
      </article>
    `,
  ).join("");
}

function renderLessonSources(sourceIds = []) {
  if (sourceIds.length === 0) return "";
  const links = sourceIds
    .map(sourceById)
    .filter(Boolean)
    .map(
      (source) =>
        `<a href="${safeText(source.url)}" target="_blank" rel="noreferrer" aria-label="${safeText(source.title)}, 새 창에서 열기">${safeText(source.title)}</a>`,
    )
    .join("");
  return `<p class="lesson-sources"><strong>근거·더 읽기</strong> ${links}</p>`;
}

function lessonSearchText(lesson) {
  const sourceTitles = (lesson.sourceIds ?? [])
    .map(sourceById)
    .filter(Boolean)
    .map((source) => source.title);
  return [
    lesson.title,
    lesson.question,
    lesson.thesis,
    lesson.takeaway,
    ...(lesson.terms ?? []),
    ...lesson.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    lesson.equation?.label,
    lesson.equation?.expression,
    lesson.equation?.readAs,
    lesson.workedExample.title,
    ...lesson.workedExample.steps,
    lesson.misconception.claim,
    lesson.misconception.correction,
    lesson.checkpoint.prompt,
    ...lesson.checkpoint.options,
    lesson.checkpoint.explanation,
    ...sourceTitles,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ko");
}

function renderLesson(part, lesson, globalIndex) {
  const previousAttempt = state.quizAttempts[lesson.id];
  const equation = lesson.equation
    ? `
      <div class="equation-card">
        ${lesson.equation.label ? `<h5>${safeText(lesson.equation.label)}</h5>` : ""}
        <p class="equation-card__formula">${safeText(lesson.equation.expression)}</p>
        <p>${safeText(lesson.equation.readAs)}</p>
      </div>
    `
    : "";
  const sections = lesson.sections
    .map(
      (section) => `
        <section class="lesson-section">
          <h5>${safeText(section.heading)}</h5>
          ${section.paragraphs.map((paragraph) => `<p>${safeText(paragraph)}</p>`).join("")}
        </section>
      `,
    )
    .join("");
  const options = lesson.checkpoint.options
    .map(
      (option, optionIndex) => `
        <button
          class="checkpoint__option"
          type="button"
          data-lesson-id="${safeText(lesson.id)}"
          data-option-index="${optionIndex}"
          data-selected="${String(previousAttempt?.selected === optionIndex)}"
          aria-pressed="${String(previousAttempt?.selected === optionIndex)}"
        >
          <span>${String.fromCharCode(65 + optionIndex)}</span>
          <span>${safeText(option)}</span>
        </button>
      `,
    )
    .join("");
  const completed = state.completedLessonIds.includes(lesson.id);

  return `
    <details
      id="${safeText(lesson.id)}"
      class="lesson"
      data-lesson-id="${safeText(lesson.id)}"
      data-search="${safeText(lessonSearchText(lesson))}"
    >
      <summary>
        <h4 class="lesson__summary-heading" style="display: contents">
          <span class="lesson__number">${String(globalIndex + 1).padStart(2, "0")}</span>
          <span>
            <span class="lesson__question">${safeText(lesson.question)}</span>
            <span class="lesson__title">${safeText(lesson.title)}</span>
          </span>
          <span class="lesson__time">약 ${safeText(lesson.minutes)}분</span>
        </h4>
      </summary>
      <div class="lesson__body">
        <p class="lesson__thesis">${safeText(lesson.thesis)}</p>
        ${sections}
        ${equation}
        <div class="worked-example">
          <h5>완전 풀이 · ${safeText(lesson.workedExample.title)}</h5>
          <ol>${lesson.workedExample.steps.map((step) => `<li>${safeText(step)}</li>`).join("")}</ol>
        </div>
        <div class="misconception">
          <h5>오개념 점검</h5>
          <blockquote>“${safeText(lesson.misconception.claim)}”</blockquote>
          <p>${safeText(lesson.misconception.correction)}</p>
        </div>
        <section class="checkpoint" data-checkpoint="${safeText(lesson.id)}">
          <h5>화면을 덮기 전 한 번 회상하기</h5>
          <p>${safeText(lesson.checkpoint.prompt)}</p>
          <div class="checkpoint__options" role="group" aria-label="회상 문제 선택지">${options}</div>
          <p class="checkpoint__answer" aria-live="polite">${
            previousAttempt
              ? `${previousAttempt.correct ? "맞았습니다." : "한 번 더 구분해 봅시다."} ${safeText(lesson.checkpoint.explanation)}`
              : "답을 고르면 이유를 확인할 수 있습니다."
          }</p>
        </section>
        <div class="definition-box">
          <p class="eyebrow">내 말로 남길 한 문장</p>
          <p>${safeText(lesson.takeaway)}</p>
        </div>
        ${renderLessonSources(lesson.sourceIds)}
        <label class="lesson-complete">
          <input
            type="checkbox"
            name="complete-${safeText(lesson.id)}"
            data-complete-lesson="${safeText(lesson.id)}"
            aria-label="${safeText(lesson.title)}: 이 강을 이해했다고 표시"
            ${completed ? "checked" : ""}
          />
          이 강을 이해했다고 표시
        </label>
      </div>
    </details>
  `;
}

function renderCourse() {
  let globalIndex = 0;
  document.querySelector("#course-parts").innerHTML = COURSE_PARTS.map((part, partIndex) => {
    const outcomes = part.learningObjectives;
    const lessons = part.lessons
      .map((lesson) => {
        const html = renderLesson(part, lesson, globalIndex);
        globalIndex += 1;
        return html;
      })
      .join("");
    return `
      <section id="${safeText(part.id)}" class="course-part" data-part-id="${safeText(part.id)}">
        <header class="part-heading">
          <div>
            <span class="part-heading__number">PART ${String(partIndex + 1).padStart(2, "0")}</span>
            <p class="part-heading__meta">${part.lessons.length}강 · 약 ${part.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0)}분</p>
          </div>
          <div>
            <h3>${safeText(part.title)}</h3>
            <p class="part-heading__thesis">${safeText(part.summary)}</p>
            <ul class="part-outcomes">
              ${outcomes.map((outcome) => `<li>${safeText(outcome)}</li>`).join("")}
            </ul>
          </div>
        </header>
        <div class="lesson-list">${lessons}</div>
      </section>
    `;
  }).join("");
}

function renderCases() {
  document.querySelector("#case-grid").innerHTML = CASES.map(
    (item, index) => `
      <article class="case-card" data-case-category="${safeText(item.category)}">
        <div class="case-card__meta"><span>${String(index + 1).padStart(2, "0")}</span><span>${safeText(item.categoryLabel)}</span></div>
        <h3>${safeText(item.title)}</h3>
        <p>${safeText(item.situation)}</p>
        <dl>
          <div><dt>결정변수</dt><dd>${safeText(item.decision)}</dd></div>
          <div><dt>병목</dt><dd>${safeText(item.bottleneck)}</dd></div>
          <div><dt>놓치기 쉬운 것</dt><dd>${safeText(item.caution)}</dd></div>
        </dl>
      </article>
    `,
  ).join("");
}

function renderGlossary() {
  document.querySelector("#glossary-list").innerHTML = GLOSSARY.map(
    (entry) => `
      <div
        id="term-${safeText(entry.id)}"
        class="glossary-entry"
        data-search="${safeText(
          [entry.term, entry.english, entry.definition, entry.caution]
            .join(" ")
            .toLocaleLowerCase("ko"),
        )}"
      >
        <dt>${safeText(entry.term)}${entry.english ? `<span>${safeText(entry.english)}</span>` : ""}</dt>
        <dd>${safeText(entry.definition)}${entry.caution ? ` <strong>경계:</strong> ${safeText(entry.caution)}` : ""}</dd>
      </div>
    `,
  ).join("");
}

function renderCapstone() {
  document.querySelector("#capstone-form").innerHTML = CAPSTONE_FIELDS.map(
    (field, index) => `
      <div class="capstone-field">
        <span class="capstone-field__number">${String(index + 1).padStart(2, "0")}</span>
        <label for="capstone-${safeText(field.id)}">${safeText(field.prompt)}</label>
        <p>${safeText(field.hint)}</p>
        <textarea id="capstone-${safeText(field.id)}" name="${safeText(field.id)}" rows="4" maxlength="${CAPSTONE_MAX_LENGTH}">${safeText(state.capstoneDraft[field.id] ?? "")}</textarea>
      </div>
    `,
  ).join("");

  document.querySelector("#capstone-rubric").innerHTML = `
    <h3>정답표가 아니라 검토 기준</h3>
    <ol>${CAPSTONE_RUBRIC.map((item) => `<li><strong>${safeText(item.label)}</strong> — ${safeText(item.criterion)}</li>`).join("")}</ol>
    <p>서로 다른 운영안도 이 기준을 충족할 수 있습니다. 핵심은 선택·가정·포기·복구 조건을 숨기지 않는 것입니다.</p>
  `;
}

function renderSources() {
  document.querySelector("#source-list").innerHTML = SOURCES.map(
    (source) => `
      <article class="source-card" id="source-${safeText(source.id)}">
        <span class="source-card__kind">${safeText(source.kind)}</span>
        <h3>${safeText(source.title)}</h3>
        <p class="source-card__meta">${safeText(source.authors)} · ${safeText(source.year)}</p>
        <p class="source-card__note">${safeText(source.note)}</p>
        <a href="${safeText(source.url)}" target="_blank" rel="noreferrer" aria-label="${safeText(source.title)}: 원문 또는 공식 페이지, 새 창">원문 또는 공식 페이지 ↗</a>
      </article>
    `,
  ).join("");
}

function updateLessonProgress() {
  const total = allLessons().length;
  const completed = state.completedLessonIds.length;
  document.querySelector("#lesson-progress-label").textContent = `${completed} / ${total}강`;
  document.querySelector("#lesson-progress-bar").style.width = `${(completed / total) * 100}%`;
}

function focusGuidedDestination(lesson) {
  requestAnimationFrame(() => {
    const summary = lesson?.querySelector("summary");
    if (summary) {
      summary.focus();
      return;
    }
    const terminalStatus = document.querySelector("#lesson-progress-label");
    terminalStatus.tabIndex = -1;
    terminalStatus.focus();
  });
}

function applyDensity({ focusGuidedTarget = false } = {}) {
  document.querySelector(`input[name="density"][value="${state.density}"]`).checked = true;
  const lessons = [...document.querySelectorAll(".lesson")];
  if (state.density === "all") {
    lessons.forEach((lesson) => {
      lesson.open = true;
    });
    return;
  }
  lessons.forEach((lesson) => {
    lesson.open = false;
  });
  if (state.density === "guided") {
    const nextIncomplete = lessons.find(
      (lesson) => !state.completedLessonIds.includes(lesson.dataset.lessonId),
    );
    if (nextIncomplete) nextIncomplete.open = true;
    if (focusGuidedTarget) focusGuidedDestination(nextIncomplete);
  }
}

function filterCourse(query) {
  const normalized = query.trim().toLocaleLowerCase("ko");
  let matches = 0;
  document.querySelectorAll(".course-part").forEach((part) => {
    let partMatches = 0;
    part.querySelectorAll(".lesson").forEach((lesson) => {
      const match = normalized.length === 0 || lesson.dataset.search.includes(normalized);
      lesson.hidden = !match;
      if (match) {
        matches += 1;
        partMatches += 1;
        if (normalized.length > 0) lesson.open = true;
      }
    });
    part.hidden = partMatches === 0;
  });
  const status = document.querySelector("#course-search-status");
  status.textContent =
    normalized.length === 0
      ? "40강 전체를 표시합니다."
      : `${matches}강에서 “${query.trim()}”을 찾았습니다.`;
  if (normalized.length === 0) applyDensity();
}

function handleCheckpoint(button) {
  const lessonId = button.dataset.lessonId;
  const lesson = allLessons().find((item) => item.id === lessonId);
  if (!lesson) return;
  const selected = Number(button.dataset.optionIndex);
  const container = button.closest(".checkpoint");
  container.querySelectorAll(".checkpoint__option").forEach((option) => {
    option.dataset.selected = String(option === button);
    option.setAttribute("aria-pressed", String(option === button));
  });
  const correct = selected === lesson.checkpoint.answer;
  container.querySelector(".checkpoint__answer").textContent = `${correct ? "맞았습니다." : "한 번 더 구분해 봅시다."} ${lesson.checkpoint.explanation}`;
  state.quizAttempts[lessonId] = {
    selected,
    correct,
    attemptedAt: new Date().toISOString(),
  };
  saveState();
}

function currentLpInput() {
  const form = document.querySelector("#lp-form");
  const data = new FormData(form);
  return {
    objective: [Number(data.get("valueA")), Number(data.get("valueB"))],
    constraints: [
      {
        id: "writing",
        label: "작성 시간",
        coefficients: [2, 1],
        limit: Number(data.get("capacityWriting")),
      },
      {
        id: "review",
        label: "검토 시간",
        coefficients: [1, 2],
        limit: Number(data.get("capacityReview")),
      },
    ],
  };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function renderLpChart(solution) {
  const svg = document.querySelector("#lp-chart");
  const title = svg.querySelector("title")?.cloneNode(true);
  const desc = svg.querySelector("desc")?.cloneNode(true);
  svg.replaceChildren();
  if (title) svg.append(title);
  if (desc) svg.append(desc);

  const width = 520;
  const height = 360;
  const margin = { left: 54, right: 24, top: 24, bottom: 46 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const maxX =
    Math.max(1, ...solution.feasibleVertices.map((vertex) => vertex.point[0])) * 1.2;
  const maxY =
    Math.max(1, ...solution.feasibleVertices.map((vertex) => vertex.point[1])) * 1.2;
  const x = (value) => margin.left + (value / maxX) * innerWidth;
  const y = (value) => height - margin.bottom - (value / maxY) * innerHeight;

  for (let index = 0; index <= 5; index += 1) {
    const xValue = (maxX / 5) * index;
    const yValue = (maxY / 5) * index;
    svg.append(
      svgElement("line", {
        x1: x(xValue),
        y1: margin.top,
        x2: x(xValue),
        y2: height - margin.bottom,
        class: "lp-grid",
      }),
      svgElement("line", {
        x1: margin.left,
        y1: y(yValue),
        x2: width - margin.right,
        y2: y(yValue),
        class: "lp-grid",
      }),
    );
    const xLabel = svgElement("text", {
      x: x(xValue),
      y: height - 18,
      "text-anchor": "middle",
      class: "lp-label",
    });
    xLabel.textContent = formatNumber(xValue);
    const yLabel = svgElement("text", {
      x: margin.left - 8,
      y: y(yValue) + 4,
      "text-anchor": "end",
      class: "lp-label",
    });
    yLabel.textContent = formatNumber(yValue);
    svg.append(xLabel, yLabel);
  }

  svg.append(
    svgElement("line", {
      x1: margin.left,
      y1: height - margin.bottom,
      x2: width - margin.right,
      y2: height - margin.bottom,
      class: "lp-axis",
    }),
    svgElement("line", {
      x1: margin.left,
      y1: height - margin.bottom,
      x2: margin.left,
      y2: margin.top,
      class: "lp-axis",
    }),
  );
  const xAxisLabel = svgElement("text", {
    x: width - margin.right,
    y: height - 7,
    "text-anchor": "end",
    class: "lp-axis-label",
  });
  xAxisLabel.textContent = "안내서 x";
  const yAxisLabel = svgElement("text", {
    x: margin.left + 7,
    y: margin.top + 12,
    "text-anchor": "start",
    class: "lp-axis-label",
  });
  yAxisLabel.textContent = "보고서 y";
  svg.append(xAxisLabel, yAxisLabel);

  const polygon = svgElement("polygon", {
    points: solution.feasibleVertices
      .map((vertex) => `${x(vertex.point[0])},${y(vertex.point[1])}`)
      .join(" "),
    class: "lp-feasible",
  });
  svg.append(polygon);

  solution.constraints.forEach((constraint, constraintIndex) => {
    const [a, b] = constraint.coefficients;
    const tolerance = Math.max(maxX, maxY) * 1e-9;
    const candidates = [];
    const addCandidate = (point) => {
      if (
        point.every(Number.isFinite) &&
        point[0] >= -tolerance &&
        point[0] <= maxX + tolerance &&
        point[1] >= -tolerance &&
        point[1] <= maxY + tolerance &&
        !candidates.some(
          (candidate) =>
            Math.abs(candidate[0] - point[0]) <= tolerance &&
            Math.abs(candidate[1] - point[1]) <= tolerance,
        )
      ) {
        candidates.push([
          Math.min(maxX, Math.max(0, point[0])),
          Math.min(maxY, Math.max(0, point[1])),
        ]);
      }
    };
    if (b !== 0) {
      addCandidate([0, constraint.limit / b]);
      addCandidate([maxX, (constraint.limit - a * maxX) / b]);
    }
    if (a !== 0) {
      addCandidate([constraint.limit / a, 0]);
      addCandidate([(constraint.limit - b * maxY) / a, maxY]);
    }

    let segment = [];
    let longestDistance = -1;
    candidates.forEach((start, startIndex) => {
      candidates.slice(startIndex + 1).forEach((end) => {
        const distance = (start[0] - end[0]) ** 2 + (start[1] - end[1]) ** 2;
        if (distance > longestDistance) {
          longestDistance = distance;
          segment = [start, end];
        }
      });
    });

    if (segment.length === 2) {
      svg.append(
        svgElement("line", {
          x1: x(segment[0][0]),
          y1: y(segment[0][1]),
          x2: x(segment[1][0]),
          y2: y(segment[1][1]),
          class: `lp-constraint lp-constraint--${constraintIndex + 1}`,
        }),
      );
      const midpoint = [
        (segment[0][0] + segment[1][0]) / 2,
        (segment[0][1] + segment[1][1]) / 2,
      ];
      const label = svgElement("text", {
        x: Math.min(width - margin.right - 8, Math.max(margin.left + 8, x(midpoint[0]))),
        y: Math.min(
          height - margin.bottom - 8,
          Math.max(margin.top + 14, y(midpoint[1]) - 7),
        ),
        "text-anchor": "middle",
        class: `lp-constraint-label lp-constraint-label--${constraintIndex + 1}`,
      });
      label.textContent = constraint.label;
      svg.append(label);
      return;
    }

    const markerY = margin.top + 18 + constraintIndex * 22;
    svg.append(
      svgElement("line", {
        x1: width - margin.right - 178,
        y1: markerY - 4,
        x2: width - margin.right - 154,
        y2: markerY - 4,
        class: `lp-constraint lp-constraint--${constraintIndex + 1}`,
      }),
    );
    const offChartLabel = svgElement("text", {
      x: width - margin.right,
      y: markerY,
      "text-anchor": "end",
      class: `lp-constraint-label lp-constraint-label--${constraintIndex + 1}`,
    });
    offChartLabel.textContent = `${constraint.label} 경계 ↗ 표시 범위 밖`;
    svg.append(offChartLabel);
  });

  if (solution.optimalVertices.length === 2) {
    svg.append(
      svgElement("line", {
        x1: x(solution.optimalVertices[0].point[0]),
        y1: y(solution.optimalVertices[0].point[1]),
        x2: x(solution.optimalVertices[1].point[0]),
        y2: y(solution.optimalVertices[1].point[1]),
        class: "lp-optimal-edge",
      }),
    );
  }
  solution.feasibleVertices.forEach((vertex) => {
    const isOptimum = solution.optimalVertices.includes(vertex);
    svg.append(
      svgElement("circle", {
        cx: x(vertex.point[0]),
        cy: y(vertex.point[1]),
        r: isOptimum ? 7 : 4,
        class: isOptimum ? "lp-optimum" : "lp-feasible-point",
      }),
    );
  });
}

function updateLpLab() {
  const form = document.querySelector("#lp-form");
  form.querySelectorAll('input[type="range"]').forEach((input) => {
    input.closest("label").querySelector("output").textContent = input.value;
  });
  const input = currentLpInput();
  const [valueA, valueB] = input.objective;
  const [writing, review] = input.constraints;
  form.querySelector(".formula").innerHTML = `최대화: <i>${valueA}x + ${valueB}y</i><br />제약: <i>2x + y ≤ ${writing.limit}</i>, <i>x + 2y ≤ ${review.limit}</i>`;
  const solution = solveTwoVariableLinearProgram(input);
  renderLpChart(solution);
  const [x, y] = solution.optimum.point;
  const vertices = solution.feasibleVertices
    .map(
      (vertex) =>
        `(${formatNumber(vertex.point[0])}, ${formatNumber(vertex.point[1])}) → ${formatNumber(vertex.value)}`,
    )
    .join(" · ");
  document.querySelector("#lp-result").innerHTML = `
    <h4>최적점: 안내서 ${formatNumber(x)}묶음 · 보고서 ${formatNumber(y)}묶음</h4>
    <p>목적값은 <strong>${formatNumber(solution.optimum.value)}</strong>입니다. ${
      solution.hasUnboundedOptimalFace
        ? "목적값을 바꾸지 않는 무한한 최적 방향이 있습니다."
        : solution.optimalVertices.length > 1
          ? "같은 값을 갖는 꼭짓점 사이의 모든 혼합도 최적입니다."
          : "이 입력에서는 표시된 꼭짓점이 유일한 최적점입니다."
    }</p>
    <dl>
      <div><dt>작성시간 잔여</dt><dd>${formatNumber(solution.optimum.slacks[0])}</dd></div>
      <div><dt>검토시간 잔여</dt><dd>${formatNumber(solution.optimum.slacks[1])}</dd></div>
      <div><dt>결합 제약</dt><dd>${solution.optimum.bindingConstraintIds.length}개</dd></div>
    </dl>
    <p><small>꼭짓점 비교: ${vertices}</small></p>
  `;
  updateDualLab();
}

function updateDualLab() {
  const constraintIndex = Number(document.querySelector("#shadow-constraint").value);
  const deltaInput = document.querySelector("#shadow-delta");
  const delta = Number(deltaInput.value);
  deltaInput.closest("label").querySelector("output").textContent = formatNumber(delta, 2);
  const analysis = estimateConstraintMarginalValue({
    ...currentLpInput(),
    constraintIndex,
    delta,
  });
  document.querySelector("#dual-result").innerHTML = `
    <h4>${safeText(analysis.constraint.label)} ${formatNumber(delta, 2)}단위 추가 → 목적값 ${formatNumber(analysis.change, 2)} 증가</h4>
    <dl>
      <div><dt>기존 최적값</dt><dd>${formatNumber(analysis.base.optimum.value, 2)}</dd></div>
      <div><dt>증가 뒤 최적값</dt><dd>${formatNumber(analysis.expanded.optimum.value, 2)}</dd></div>
      <div><dt>단위당 차분가치</dt><dd>${formatNumber(analysis.marginalValue, 2)}</dd></div>
    </dl>
    <p>${
      analysis.slopeStable
        ? "구간의 앞 절반과 뒤 절반에서 단위당 증가가 같았습니다. 그래도 이는 표시한 구간 안의 결과이며 더 멀리 연장할 수 없습니다."
        : `구간 안에서 기울기가 ${formatNumber(analysis.firstHalfMarginalValue, 2)}에서 ${formatNumber(analysis.secondHalfMarginalValue, 2)}로 바뀌었습니다. 위 숫자는 국소 그림자가격이 아니라 구간 평균입니다.`
    }</p>
  `;
}

const uncertaintyAlternatives = [
  { id: "peak", label: "피크 성능안", payoffs: [100, 20] },
  { id: "balanced", label: "균형안", payoffs: [78, 64] },
  { id: "reserve", label: "예비용량안", payoffs: [66, 70] },
];

function updateUncertaintyLab() {
  const probability = Number(document.querySelector("#normal-probability").value) / 100;
  document.querySelector("#normal-probability-output").textContent =
    `${Math.round(probability * 100)}%`;
  const result = analyzeDecisionUnderUncertainty({
    alternatives: uncertaintyAlternatives,
    probabilities: [probability, 1 - probability],
  });
  const rows = result.rows
    .map(
      (row) => `
        <tr
          data-expected="${result.expectedBestIds.includes(row.id)}"
          data-robust="${result.robustBestIds.includes(row.id)}"
          data-regret="${result.minimaxRegretIds.includes(row.id)}"
        >
          <th scope="row">${safeText(row.label)}</th>
          <td>${formatNumber(row.payoffs[0])}</td>
          <td>${formatNumber(row.payoffs[1])}</td>
          <td>${formatNumber(row.expectedValue)}</td>
          <td>${formatNumber(row.worstCase)}</td>
          <td>${formatNumber(row.maximumRegret)}</td>
        </tr>
      `,
    )
    .join("");
  document.querySelector("#uncertainty-result").innerHTML = `
    <div class="decision-table-scroll" tabindex="0" role="region" aria-label="불확실성 기준 비교표, 가로로 스크롤할 수 있습니다">
      <table class="decision-table">
        <thead><tr><th>대안</th><th>평시</th><th>충격</th><th>기대값 ↑</th><th>최악값 ↑</th><th>최대후회 ↓</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p>기대값 기준: <strong>${result.expectedBestIds.map((id) => uncertaintyAlternatives.find((item) => item.id === id).label).join(", ")}</strong> ·
      최악값 기준: <strong>${result.robustBestIds.map((id) => uncertaintyAlternatives.find((item) => item.id === id).label).join(", ")}</strong> ·
      최대후회 최소: <strong>${result.minimaxRegretIds.map((id) => uncertaintyAlternatives.find((item) => item.id === id).label).join(", ")}</strong></p>
    <p><small>확률은 위험중립 기대값에만 쓰입니다. 최악값과 최대후회는 확률이 0%로 표시된 상태도 스트레스 시나리오 목록에 남겨 비교합니다.</small></p>
  `;
}

function updateAccessLab() {
  const data = new FormData(document.querySelector("#access-form"));
  let result;
  try {
    result = calculateAccessEconomics({
      monthlyDisposableIncome: Number(data.get("income")),
      monthlyPrice: Number(data.get("price")),
      usageDays: Number(data.get("days")),
      hoursSavedPerDay: Number(data.get("hoursSaved")),
      assumedHourlyValue: Number(data.get("hourlyValue")),
    });
  } catch (error) {
    document.querySelector("#access-result").innerHTML = `
      <h4>입력값을 확인해 주세요.</h4>
      <p>사용일은 1~31 사이의 정수여야 하고, 금액과 시간은 0보다 작을 수 없습니다.</p>
    `;
    return;
  }
  const burden =
    result.burdenShare === null ? "계산 불가" : `${formatNumber(result.burdenShare * 100, 2)}%`;
  const ratio =
    result.benefitCostRatio === null
      ? "무료"
      : `${formatNumber(result.benefitCostRatio, 2)}배`;
  document.querySelector("#access-result").innerHTML = `
    <h4>가격 부담률 ${burden} · 가정한 편익/가격 ${ratio}</h4>
    <dl>
      <div><dt>월 절약시간</dt><dd>${formatNumber(result.monthlyHoursSaved, 2)}시간</dd></div>
      <div><dt>가정한 시간가치</dt><dd>${formatWon(result.imputedTimeValue)}</dd></div>
      <div><dt>가정 순가치</dt><dd>${formatWon(result.netImputedValue)}</dd></div>
    </dl>
    <p>${
      result.breakEvenUsageDays === 0
        ? "구독료가 0원이므로 시간편익으로 비용을 회수한다는 손익분기 질문은 필요하지 않습니다."
        : result.breakEvenUsageDays === null
          ? "절약시간 또는 시간가치 가정이 0이라 시간편익 기준 손익분기를 계산할 수 없습니다."
          : result.breakEvenWithinMonth
            ? `이 가정에서는 월 ${result.breakEvenUsageDays}일 사용하면 구독료만큼의 시간가치에 도달합니다.`
            : `이 가정에서는 손익분기에 ${result.breakEvenUsageDays}일이 필요해 한 달 안에 도달할 수 없습니다.`
    }</p>
    <p><strong>분배 질문:</strong> 같은 가격이라도 부담률은 소득에 따라 달라집니다. 개인의 높은 편익이 공급사의 원가나 사회 전체의 공정성을 증명하지는 않습니다.</p>
  `;
}

function saveCapstone() {
  CAPSTONE_FIELDS.forEach((field) => {
    state.capstoneDraft[field.id] =
      document
        .querySelector(`#capstone-${CSS.escape(field.id)}`)
        .value.slice(0, CAPSTONE_MAX_LENGTH);
  });
  const saved = saveState();
  document.querySelector("#capstone-status").textContent = saved
    ? `이 브라우저에 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 저장했습니다.`
    : "저장하지 못했습니다. 브라우저 저장공간·개인정보 설정을 확인하고, 탭을 닫기 전에 내용을 따로 복사해 주세요.";
}

function announceCalculation(message) {
  document.querySelector("#lab-announcement").textContent = message;
}

function updateReadingProgress() {
  const documentHeight = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = documentHeight <= 0 ? 0 : window.scrollY / documentHeight;
  document.querySelector("#reading-progress-bar").style.width =
    `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function bindEvents() {
  document.querySelectorAll("#lp-form, #access-form, #capstone-form").forEach((form) => {
    form.addEventListener("submit", (event) => event.preventDefault());
  });
  document.querySelector(".skip-link").addEventListener("click", () => {
    requestAnimationFrame(() => document.querySelector("#main").focus({ preventScroll: true }));
  });
  document.querySelectorAll(".mobile-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      link.closest("details").open = false;
    });
  });
  document.querySelector("#course-search").addEventListener("input", (event) => {
    filterCourse(event.target.value);
  });
  document.querySelectorAll('input[name="density"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.density = radio.value;
      saveState();
      const query = document.querySelector("#course-search").value;
      if (query.trim()) filterCourse(query);
      else applyDensity();
    });
  });
  document.querySelector("#course-parts").addEventListener("click", (event) => {
    const option = event.target.closest(".checkpoint__option");
    if (option) handleCheckpoint(option);
  });
  document.querySelector("#course-parts").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-complete-lesson]");
    if (!checkbox) return;
    const id = checkbox.dataset.completeLesson;
    const completed = new Set(state.completedLessonIds);
    if (checkbox.checked) completed.add(id);
    else completed.delete(id);
    state.completedLessonIds = [...completed];
    saveState();
    updateLessonProgress();
    if (
      checkbox.checked &&
      state.density === "guided" &&
      !document.querySelector("#course-search").value.trim()
    ) {
      applyDensity({ focusGuidedTarget: true });
    }
  });
  document.querySelector("#reset-course").addEventListener("click", () => {
    if (!window.confirm("40강의 완료 표시와 회상문제 기록을 초기화할까요? 캡스톤 초안은 남깁니다.")) {
      return;
    }
    state.completedLessonIds = [];
    state.quizAttempts = {};
    saveState();
    document.querySelectorAll("[data-complete-lesson]").forEach((checkbox) => {
      checkbox.checked = false;
    });
    document.querySelectorAll(".checkpoint__option").forEach((option) => {
      option.dataset.selected = "false";
      option.setAttribute("aria-pressed", "false");
    });
    document.querySelectorAll(".checkpoint__answer").forEach((answer) => {
      answer.textContent = "답을 고르면 이유를 확인할 수 있습니다.";
    });
    updateLessonProgress();
    const query = document.querySelector("#course-search").value;
    if (query.trim()) filterCourse(query);
    else applyDensity();
  });
  document.querySelector("#case-filter").addEventListener("change", (event) => {
    const category = event.target.value;
    let matches = 0;
    document.querySelectorAll(".case-card").forEach((card) => {
      const match = category === "all" || card.dataset.caseCategory === category;
      card.hidden = !match;
      if (match) matches += 1;
    });
    document.querySelector("#case-filter-status").textContent =
      category === "all"
        ? `${CASES.length}개 사례 전체를 표시합니다.`
        : `${matches}개 사례를 표시합니다.`;
  });
  document.querySelector("#glossary-search").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLocaleLowerCase("ko");
    let matches = 0;
    document.querySelectorAll(".glossary-entry").forEach((entry) => {
      const match = query.length === 0 || entry.dataset.search.includes(query);
      entry.hidden = !match;
      if (match) matches += 1;
    });
    document.querySelector("#glossary-status").textContent =
      query.length === 0 ? "80개 용어 전체를 표시합니다." : `${matches}개 용어를 찾았습니다.`;
  });
  document.querySelector("#lp-form").addEventListener("input", updateLpLab);
  document.querySelector("#lp-form").addEventListener("change", () => {
    announceCalculation("선형계획 입력을 반영해 가능영역과 최적점 결과를 갱신했습니다.");
  });
  document.querySelector("#shadow-constraint").addEventListener("change", () => {
    updateDualLab();
    announceCalculation("선택한 자원의 구간 평균 한계가치를 갱신했습니다.");
  });
  document.querySelector("#shadow-delta").addEventListener("input", updateDualLab);
  document.querySelector("#shadow-delta").addEventListener("change", () => {
    announceCalculation("증가량을 반영해 구간의 앞·뒤 기울기와 평균 한계가치를 갱신했습니다.");
  });
  document.querySelector("#normal-probability").addEventListener("input", updateUncertaintyLab);
  document.querySelector("#normal-probability").addEventListener("change", () => {
    announceCalculation("평시 확률을 반영해 위험중립 기대값을 갱신했습니다. 최악값과 최대후회는 모든 상태를 계속 비교합니다.");
  });
  document.querySelector("#access-form").addEventListener("input", updateAccessLab);
  document.querySelector("#access-form").addEventListener("change", () => {
    announceCalculation("소득·가격·사용 가정을 반영해 AI 접근부담 장부를 갱신했습니다.");
  });
  document.querySelector("#save-capstone").addEventListener("click", saveCapstone);
  document.querySelector("#reveal-capstone").addEventListener("click", () => {
    const rubric = document.querySelector("#capstone-rubric");
    rubric.hidden = !rubric.hidden;
    const button = document.querySelector("#reveal-capstone");
    button.setAttribute("aria-expanded", String(!rubric.hidden));
    button.textContent = rubric.hidden
      ? "검토 기준 보기"
      : "검토 기준 접기";
  });
  let scheduled = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        updateReadingProgress();
        scheduled = false;
      });
    },
    { passive: true },
  );
}

function finishHydrationAtInitialHash() {
  let target = null;
  if (window.location.hash.length > 1) {
    try {
      target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    } catch {
      // Ignore malformed percent-encoding and finish at the default document position.
    }
  }

  requestAnimationFrame(() => {
    if (target) {
      if (target.matches(".lesson")) target.open = true;
      target.scrollIntoView({ behavior: "instant", block: "start" });
      updateReadingProgress();
    }
    document.documentElement.dataset.ready = "true";
  });
}

function hydrate() {
  validateContent();
  saveState();
  document.querySelector("#fact-lessons").textContent = String(allLessons().length);
  document.querySelector("#fact-parts").textContent = String(COURSE_PARTS.length);
  renderPartMap();
  renderCourse();
  renderCases();
  document.querySelector("#case-filter-status").textContent =
    `${CASES.length}개 사례 전체를 표시합니다.`;
  renderGlossary();
  renderCapstone();
  renderSources();
  updateLessonProgress();
  applyDensity();
  filterCourse("");
  document.querySelector("#glossary-status").textContent = "80개 용어 전체를 표시합니다.";
  updateLpLab();
  updateUncertaintyLab();
  updateAccessLab();
  bindEvents();
  updateReadingProgress();
  finishHydrationAtInitialHash();
}

hydrate();
