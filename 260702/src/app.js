(function initApp() {
  const Core = window.ECFoundryCore;
  const STORAGE_KEY = "spatial-foundry-state-v3";
  const REASONING_STORAGE_KEY = "reasoning-foundry-state-v2";
  const REASONING_GENERATOR_VERSION = 8;
  const STORAGE_KEYS_TO_CLEAR = [
    STORAGE_KEY,
    "spatial-foundry-state-v2",
    "ec-foundry-state-v1",
  ];
  const REASONING_DOMAINS = [
    {
      id: "bi",
      title: "Billiards",
      subtitle: "static collision, rebound, and next-path geometry",
      goal:
        "한 장의 정적 당구 장면에서 충돌 순서, 반사 경로, 다음 접촉 객체를 사람이 검증하는 데이터를 만든다.",
      instruction: "충돌/반사 규칙을 적용했을 때 다음 경로 또는 접촉 객체를 고르세요.",
      difficulty: "2-bank path",
      levers: ["reflection", "collision order", "bank shot", "blocked path", "target ball", "angle trap"],
      schema: ["answer", "first_contact", "reflection_count", "blocked_by", "angle_ambiguity"],
      prompts: [
        "Predict which labeled object the cue ball reaches after the marked rebound.",
        "Choose the valid path after one wall reflection and one ball collision.",
        "Select the blocker that prevents the direct shot.",
      ],
      answers: ["Path A", "Path B", "Ball C", "Blocked"],
    },
    {
      id: "mp",
      title: "Mirror Pattern",
      subtitle: "reflection symmetry and missing-half visual reasoning",
      goal:
        "거울축을 기준으로 패턴의 대응점, 누락 타일, 반전 방향을 라벨링하는 기하 데이터를 만든다.",
      instruction: "거울축을 기준으로 맞는 반사 패턴 또는 누락 조각을 고르세요.",
      difficulty: "axis symmetry",
      levers: ["vertical mirror", "diagonal mirror", "missing tile", "color swap", "rotation distractor"],
      schema: ["answer", "mirror_axis", "missing_cell", "symmetry_type", "distractor_type"],
      prompts: [
        "Choose the tile that completes the reflected pattern.",
        "Select the object that violates the mirror symmetry rule.",
        "Identify the correct mirrored location for the marked token.",
      ],
      answers: ["Tile A", "Tile B", "Tile C", "No match"],
    },
    {
      id: "cc",
      title: "Cube Count",
      subtitle: "visible, hidden, stacked, and total cube counting",
      goal:
        "3D 블록 더미에서 보이는 큐브와 가려진 큐브를 분리해 총량을 검증하는 데이터를 만든다.",
      instruction: "쌓인 큐브 구조를 보고 요청된 큐브 수를 고르세요.",
      difficulty: "hidden stack",
      levers: ["visible cubes", "hidden cubes", "layer count", "support rule", "projection trap"],
      schema: ["answer", "visible_count", "hidden_count", "layer_count", "support_assumption"],
      prompts: [
        "Count the total cubes implied by the visible stack.",
        "Choose how many cubes are hidden behind the front layer.",
        "Select the layer count that matches the projection.",
      ],
      answers: ["4", "5", "6", "7"],
    },
    {
      id: "mc",
      title: "Mirror Clock",
      subtitle: "reflected analog clock and angle reasoning",
      goal:
        "거울에 비친 시계의 실제 시간, 바늘 각도, 반전 오류를 검증하는 데이터를 만든다.",
      instruction: "거울 시계 그림에서 실제 시간 또는 올바른 바늘 배치를 고르세요.",
      difficulty: "mirror time",
      levers: ["hour hand", "minute hand", "mirror flip", "angle gap", "near-hour trap"],
      schema: ["answer", "shown_time", "true_time", "angle_gap", "hand_ambiguity"],
      prompts: [
        "Choose the actual time represented by the mirrored clock.",
        "Select the clock face that matches the reflected hands.",
        "Identify which hand placement is inconsistent after mirroring.",
      ],
      answers: ["2:40", "3:20", "8:40", "9:20"],
    },
    {
      id: "ov",
      title: "Overlap",
      subtitle: "occlusion, intersection, and layer-order geometry",
      goal:
        "겹침, 부분 가림, 교집합, 앞뒤 레이어 순서를 한 장의 그림에서 라벨링하는 데이터를 만든다.",
      instruction: "흰 점이 찍힌 표시 지점만 기준으로 앞/뒤 객체나 겹침 pair를 고르세요. 카운트 문제는 면적이 실제로 가려진 객체만 세고, 모서리 접촉은 제외합니다.",
      difficulty: "layer order",
      levers: ["front layer", "back layer", "intersection", "partial cover", "touching edge"],
      schema: ["answer", "front_object", "back_object", "overlap_area", "edge_touch"],
      prompts: [
        "At the white marked dot, choose the object drawn on top.",
        "Choose the two labels that form the area-overlap under the white marked dot.",
        "Count objects whose filled area is partly covered by any object in front. Count each object once.",
      ],
      answers: ["Object A", "Object B", "Pair C-D", "None"],
    },
    {
      id: "vq",
      title: "Visual Query",
      subtitle: "SQL-like visual select, join, group, and count reasoning",
      goal:
        "텍스트 SQL을 쓰지 않고 색, 위치, 묶음, 연결선을 이용해 조건 검색과 집계 추론 데이터를 만든다.",
      instruction: "색, 모양, 값, 묶음 조건을 함께 만족하는 시각 레코드 묶음을 고르세요.",
      difficulty: "join + group",
      levers: ["filter", "join", "group by", "count", "anti-match", "nested query"],
      schema: ["answer", "query_ops", "distractor_rule", "visual_clarity", "ambiguity_note"],
      prompts: [
        "Find the group that matches the color, shape, and value-threshold rule.",
        "Choose the bucket whose members satisfy the nested count and value condition.",
        "Select the record set left after applying the exclusion marker and threshold.",
      ],
      answers: ["Group A", "Group B", "Group C", "No match"],
    },
    {
      id: "rc",
      title: "Relation Classifier",
      subtitle: "classify join predicates and relation chains for SQL improvement",
      goal:
        "시각 관계를 SQL join predicate처럼 분류해 어떤 관계 연산자가 필요한지 라벨링하는 데이터를 만든다.",
      instruction: "두 레코드/객체 사이에 적용할 관계 분류를 고르세요.",
      difficulty: "join predicate",
      levers: ["foreign key", "left join", "same group", "near relation", "anti relation", "decoy edge"],
      schema: ["answer", "relation_type", "join_key", "chain_length", "decoy_strength"],
      prompts: [
        "Classify which relation predicate connects the two highlighted records.",
        "Choose the join relation needed to retrieve the marked target.",
        "Select the relation class after composing two visual predicates.",
      ],
      answers: ["Same group", "Parent key", "Near pair", "Anti match"],
    },
    {
      id: "cf",
      title: "Condition Filter",
      subtitle: "where-clause, exclusion, threshold, and condition labels",
      goal:
        "WHERE/HAVING 조건을 시각 조건으로 바꿔 필터 통과 여부와 제외 조건을 라벨링하는 데이터를 만든다.",
      instruction: "조건식을 통과하는 레코드 묶음 또는 제외 규칙을 고르세요.",
      difficulty: "nested where",
      levers: ["threshold", "exclusion", "range filter", "not exists", "multi condition"],
      schema: ["answer", "filter_ops", "threshold", "excluded_set", "condition_depth"],
      prompts: [
        "Choose the records that pass all visual conditions.",
        "Select the item removed by the exclusion condition.",
        "Identify the correct threshold bucket for the marked query.",
      ],
      answers: ["Pass A", "Pass B", "Exclude C", "No rows"],
    },
    {
      id: "tg",
      title: "Table Grouping",
      subtitle: "group-by, having, bucket, and aggregate classification",
      goal:
        "GROUP BY와 HAVING을 시각 묶음/버킷 문제로 바꿔 집계 결과를 라벨링하는 데이터를 만든다.",
      instruction: "그룹 규칙을 적용했을 때 맞는 버킷 또는 집계 결과를 고르세요.",
      difficulty: "group + having",
      levers: ["bucket", "count", "sum", "having", "duplicate", "group key"],
      schema: ["answer", "group_key", "aggregate_op", "having_rule", "bucket_count"],
      prompts: [
        "Choose the group that satisfies the aggregate condition.",
        "Select the correct bucket after grouping by color and marker.",
        "Identify the group removed by the HAVING rule.",
      ],
      answers: ["Bucket A", "Bucket B", "Bucket C", "No group"],
    },
    {
      id: "pm",
      title: "Predicate Mapping",
      subtitle: "map visual clauses into reusable SQL predicate labels",
      goal:
        "시각 조건을 재사용 가능한 predicate 단위로 매핑해 SQL 생성용 중간 라벨을 만든다.",
      instruction: "표시된 시각 조건에 가장 맞는 predicate 라벨을 고르세요.",
      difficulty: "predicate map",
      levers: ["equals", "less than", "contains", "between", "exists", "not null"],
      schema: ["answer", "predicate_type", "operator", "operand_source", "negation"],
      prompts: [
        "Map the highlighted visual rule to the correct predicate.",
        "Choose the operator implied by the marked comparison.",
        "Select the predicate label that best represents the exclusion.",
      ],
      answers: ["equals", "between", "exists", "not exists"],
    },
    {
      id: "ca",
      title: "Column Assignment",
      subtitle: "choose source columns, keys, and target fields",
      goal:
        "자연어 없이 시각 구조만 보고 어떤 컬럼/키/타겟 필드가 필요한지 분류하는 데이터를 만든다.",
      instruction: "쿼리에 필요한 컬럼 역할 또는 키 역할을 고르세요.",
      difficulty: "column role",
      levers: ["primary key", "foreign key", "metric", "dimension", "target field", "sort key"],
      schema: ["answer", "column_role", "source_table", "target_field", "key_type"],
      prompts: [
        "Choose which visual field acts as the grouping column.",
        "Select the key column needed to connect the two panels.",
        "Identify the metric column requested by the visual query.",
      ],
      answers: ["Primary key", "Foreign key", "Metric", "Dimension"],
    },
  ];
  const MAX_GPU_CHARGES = 10;
  const GEOMETRY_REASONING_IDS = new Set(["bi", "mp", "cc", "mc", "ov"]);

  const els = {
    brandMark: document.getElementById("brandMark"),
    appTitle: document.getElementById("appTitle"),
    treeNavLink: document.getElementById("treeNavLink"),
    safLocalNav: document.getElementById("safLocalNav"),
    treeDomain: document.getElementById("treeDomain"),
    reasoningDomain: document.getElementById("reasoningDomain"),
    beltTab: document.getElementById("beltTab"),
    settingsTab: document.getElementById("settingsTab"),
    beltDomain: document.getElementById("beltDomain"),
    settingsDomain: document.getElementById("settingsDomain"),
    rendererStatus: document.getElementById("rendererStatus"),
    exportJsonlBtn: document.getElementById("exportJsonlBtn"),
    extractApprovedBtn: document.getElementById("extractApprovedBtn"),
    exportPngBtn: document.getElementById("exportPngBtn"),
    importJsonlInput: document.getElementById("importJsonlInput"),
    clearReviewedBtn: document.getElementById("clearReviewedBtn"),
    queueCountBadge: document.getElementById("queueCountBadge"),
    settingsQueueBadge: document.getElementById("settingsQueueBadge"),
    familySelect: document.getElementById("familySelect"),
    seedInput: document.getElementById("seedInput"),
    randomSeedBtn: document.getElementById("randomSeedBtn"),
    problemTypeSelect: document.getElementById("problemTypeSelect"),
    difficultyRange: document.getElementById("difficultyRange"),
    difficultyOut: document.getElementById("difficultyOut"),
    chargeCountInput: document.getElementById("chargeCountInput"),
    candidateCountInput: document.getElementById("candidateCountInput"),
    batchCountInput: document.getElementById("batchCountInput"),
    gridExtentInput: document.getElementById("gridExtentInput"),
    nearCancelToggle: document.getElementById("nearCancelToggle"),
    symmetryToggle: document.getElementById("symmetryToggle"),
    hardDistractorToggle: document.getElementById("hardDistractorToggle"),
    generateBtn: document.getElementById("generateBtn"),
    statsGrid: document.getElementById("statsGrid"),
    instanceId: document.getElementById("instanceId"),
    promptText: document.getElementById("promptText"),
    statusBadge: document.getElementById("statusBadge"),
    workInstruction: document.getElementById("workInstruction"),
    canvasWrap: document.querySelector(".canvas-wrap"),
    fieldCanvas: document.getElementById("fieldCanvas"),
    sceneCanvas: document.getElementById("sceneCanvas"),
    prevBtn: document.getElementById("prevBtn"),
    carouselRange: document.getElementById("carouselRange"),
    nextBtn: document.getElementById("nextBtn"),
    cycleBatchBtn: document.getElementById("cycleBatchBtn"),
    safNewBtn: document.getElementById("safNewBtn"),
    resetBatchBtn: document.getElementById("resetBatchBtn"),
    safSettingsBtn: document.getElementById("safSettingsBtn"),
    safBeltBtn: document.getElementById("safBeltBtn"),
    confirmModal: document.getElementById("confirmModal"),
    confirmTitle: document.getElementById("confirmTitle"),
    confirmMessage: document.getElementById("confirmMessage"),
    confirmNoBtn: document.getElementById("confirmNoBtn"),
    confirmYesBtn: document.getElementById("confirmYesBtn"),
    submitNextBtn: document.getElementById("submitNextBtn"),
    skipBtn: document.getElementById("skipBtn"),
    overlayBtn: document.getElementById("overlayBtn"),
    thumbStrip: document.getElementById("thumbStrip"),
    splitSelect: document.getElementById("splitSelect"),
    autoAnswerText: document.getElementById("autoAnswerText"),
    humanAnswerSelect: document.getElementById("humanAnswerSelect"),
    flagGrid: document.getElementById("flagGrid"),
    notesInput: document.getElementById("notesInput"),
    solverTrace: document.getElementById("solverTrace"),
    variablesView: document.getElementById("variablesView"),
    reasoningBadge: document.getElementById("reasoningBadge"),
    reasoningTitle: document.getElementById("reasoningTitle"),
    reasoningSubtitle: document.getElementById("reasoningSubtitle"),
    reasoningCountBadge: document.getElementById("reasoningCountBadge"),
    reasoningStatusBadge: document.getElementById("reasoningStatusBadge"),
    reasoningScene: document.getElementById("reasoningScene"),
    reasoningInstruction: document.getElementById("reasoningInstruction"),
    reasoningAnswerSelect: document.getElementById("reasoningAnswerSelect"),
    reasoningSubmitNextBtn: document.getElementById("reasoningSubmitNextBtn"),
    reasoningSkipBtn: document.getElementById("reasoningSkipBtn"),
    reasoningPrevBtn: document.getElementById("reasoningPrevBtn"),
    reasoningRange: document.getElementById("reasoningRange"),
    reasoningNextBtn: document.getElementById("reasoningNextBtn"),
    reasoningExportBtn: document.getElementById("reasoningExportBtn"),
    reasoningNewBtn: document.getElementById("reasoningNewBtn"),
    reasoningSchemaBtn: document.getElementById("reasoningSchemaBtn"),
    reasoningThumbStrip: document.getElementById("reasoningThumbStrip"),
    reasoningNotesInput: document.getElementById("reasoningNotesInput"),
    schemaModal: document.getElementById("schemaModal"),
    schemaTitle: document.getElementById("schemaTitle"),
    schemaMeta: document.getElementById("schemaMeta"),
    schemaCloseBtn: document.getElementById("schemaCloseBtn"),
    schemaDoneBtn: document.getElementById("schemaDoneBtn"),
  };

  const state = loadState();
  const reasoningState = loadReasoningState();
  let activeReasoningId = "vq";
  const renderer = {
    mode: "canvas2d",
    gpuReady: false,
    device: null,
    context: null,
    pipeline: null,
    spatialPipeline: null,
    uniformBuffer: null,
    spatialUniformBuffer: null,
    spatialVertexBuffer: null,
    spatialVertexCapacity: 0,
    bindGroup: null,
    spatialBindGroup: null,
    depthTexture: null,
    depthSize: { width: 0, height: 0 },
    format: null,
    initializing: true,
    statusText: "Renderer initializing",
  };

  let overlay = false;
  let resizeFrame = null;
  let pendingConfirmAction = null;
  let pendingConfirmFocus = null;
  const camera = {
    yaw: -0.78,
    pitch: 0.72,
    zoom: 1.03,
    panX: 0,
    panY: -0.04,
    dragging: false,
    lastX: 0,
    lastY: 0,
  };

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored && Array.isArray(stored.queue)) {
        return {
          queue: stored.queue,
          currentIndex: Math.min(stored.currentIndex || 0, Math.max(stored.queue.length - 1, 0)),
          batchSerial: Number(stored.batchSerial || 0),
        };
      }
    } catch (error) {
      console.warn("Could not load state", error);
    }
    return { queue: [], currentIndex: 0, batchSerial: 0 };
  }

  function loadReasoningState() {
    try {
      const stored = JSON.parse(localStorage.getItem(REASONING_STORAGE_KEY));
      if (stored && stored.queues && stored.indices && stored.serials) {
        return {
          queues: stored.queues,
          indices: stored.indices,
          serials: stored.serials,
        };
      }
    } catch (error) {
      console.warn("Could not load reasoning state", error);
    }
    return { queues: {}, indices: {}, serials: {} };
  }

  function saveState() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        queue: state.queue,
        currentIndex: state.currentIndex,
        batchSerial: state.batchSerial,
      }),
    );
  }

  function saveReasoningState() {
    localStorage.setItem(REASONING_STORAGE_KEY, JSON.stringify(reasoningState));
  }

  function active() {
    return state.queue[state.currentIndex] || null;
  }

  function activeReasoningDomain() {
    return REASONING_DOMAINS.find((domain) => domain.id === activeReasoningId) || REASONING_DOMAINS[0];
  }

  function activeReasoningQueue() {
    return reasoningState.queues[activeReasoningId] || [];
  }

  function activeReasoningIndex() {
    return Core.clamp(Number(reasoningState.indices[activeReasoningId] || 0), 0, Math.max(activeReasoningQueue().length - 1, 0));
  }

  function activeReasoningItem() {
    return activeReasoningQueue()[activeReasoningIndex()] || null;
  }

  function getConfig(extra = {}) {
    return {
      seed: els.seedInput.value.trim() || "electric-charge-field",
      family: els.familySelect.value,
      problemType: els.problemTypeSelect.value,
      difficulty: Number(els.difficultyRange.value),
      chargeCount: Number(els.chargeCountInput.value),
      objectCount: Number(els.chargeCountInput.value),
      candidateCount: Number(els.candidateCountInput.value),
      gridExtent: Number(els.gridExtentInput.value),
      nearCancellation: els.nearCancelToggle.checked,
      symmetryTraps: els.symmetryToggle.checked,
      hardDistractors: els.hardDistractorToggle.checked,
      ...extra,
    };
  }

  function generate(count) {
    const offset = state.queue.length;
    const config = getConfig({ offset });
    const batch = Core.generateBatch(config, count);
    state.queue.push(...batch);
    if (state.queue.length === batch.length) state.currentIndex = 0;
    else state.currentIndex = state.queue.length - batch.length;
    saveState();
    renderAll();
  }

  function regenerateBatch(count = Number(els.batchCountInput.value) || 100) {
    state.batchSerial += 1;
    const size = Core.clamp(Number(count), 1, 200);
    const offset = state.batchSerial * size;
    state.queue = Core.generateBatch(getConfig({ offset }), size);
    state.currentIndex = 0;
    saveState();
    renderAll();
  }

  function ensureReasoningQueue(domainId) {
    const queue = reasoningState.queues[domainId];
    if (queue?.length && queue[0]?.generatorVersion === REASONING_GENERATOR_VERSION) return;
    regenerateReasoningQueue(domainId, 100);
  }

  function regenerateReasoningQueue(domainId, count = 100) {
    const domain = REASONING_DOMAINS.find((item) => item.id === domainId);
    if (!domain) return;
    const serial = Number(reasoningState.serials[domainId] || 0) + 1;
    reasoningState.serials[domainId] = serial;
    const size = Core.clamp(Number(count), 1, 200);
    reasoningState.queues[domainId] = Array.from({ length: size }, (_, index) =>
      makeReasoningDraft(domain, index, serial),
    );
    reasoningState.indices[domainId] = 0;
    saveReasoningState();
  }

  function makeReasoningDraft(domain, index, serial) {
    const rng = createReasoningRng(`${domain.id}:${serial}:${index}`);
    if (GEOMETRY_REASONING_IDS.has(domain.id)) {
      return makeGeometryReasoningDraft(domain, index, serial, rng);
    }
    return makeSqlReasoningDraft(domain, index, serial, rng);
  }

  function buildReasoningDraft(domain, index, serial, draft) {
    const answer = String(draft.answer);
    return {
      id: `${domain.id}_${String(serial).padStart(2, "0")}_${String(index + 1).padStart(3, "0")}`,
      generatorVersion: REASONING_GENERATOR_VERSION,
      domain: domain.id,
      task: draft.task,
      prompt: draft.prompt,
      instruction: draft.instruction || domain.instruction,
      answer,
      answerOptions: makeAnswerOptions(answer, draft.answerOptions || domain.answers),
      scene: {
        ...draft.scene,
        target: draft.scene?.target || draft.task || domain.id.toUpperCase(),
        rule: draft.scene?.rule || draft.task || domain.difficulty,
      },
      solver: draft.solver || {
        method: "synthetic_scene_solver",
        trace: `Auto answer selected from generated ${domain.id.toUpperCase()} scene variables.`,
      },
      annotation: {
        status: "pending",
        humanAnswer: answer,
        notes: "",
        reviewedAt: null,
      },
      createdAt: new Date().toISOString(),
    };
  }

  function createReasoningRng(seedText) {
    let state = hashReasoningSeed(seedText);
    return {
      next() {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
      },
      pick(items) {
        return items[this.int(0, items.length - 1)];
      },
    };
  }

  function hashReasoningSeed(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function makeAnswerOptions(answer, candidates) {
    const values = [answer, ...(candidates || [])];
    const seen = new Set();
    return values
      .map((value) => String(typeof value === "object" ? value.value || value.label : value))
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      })
      .slice(0, 6)
      .map((value) => ({ value, label: value }));
  }

  function numericAnswerOptions(answer, min, max) {
    const number = Number(answer);
    const candidates = [number, number - 1, number + 1, number + 2, number - 2, number + 3]
      .filter((value) => value >= min && value <= max)
      .map(String);
    let cursor = min;
    while (candidates.length < 4 && cursor <= max) {
      if (!candidates.includes(String(cursor))) candidates.push(String(cursor));
      cursor += 1;
    }
    return candidates;
  }

  function makeGeometryReasoningDraft(domain, index, serial, rng) {
    if (domain.id === "bi") return makeBilliardsDraft(domain, index, serial, rng);
    if (domain.id === "mp") return makeMirrorPatternDraft(domain, index, serial, rng);
    if (domain.id === "cc") return makeCubeCountDraft(domain, index, serial, rng);
    if (domain.id === "mc") return makeMirrorClockDraft(domain, index, serial, rng);
    return makeOverlapDraft(domain, index, serial, rng);
  }

  function makeBilliardsDraft(domain, index, serial, rng) {
    const taskIndex = (index + serial) % 4;
    const validPath = rng.pick(["Path A", "Path B", "Path C"]);
    const blockedShot = taskIndex !== 2 && rng.int(0, 5) === 0;
    const pathToBall = { "Path A": "Ball A", "Path B": "Ball B", "Path C": "Ball C" };
    const answer =
      taskIndex === 1
        ? pathToBall[validPath]
        : taskIndex === 2
          ? "Ball D"
          : blockedShot
            ? "Blocked"
            : validPath;
    const cue = { x: 128 + rng.int(-12, 24), y: 255 + rng.int(-22, 24) };
    const bank = { x: 365 + rng.int(-22, 22), y: 72 };
    const secondBank = { x: 650 + rng.int(-18, 12), y: 94 + rng.int(-12, 18) };
    const pathAEnd = { x: 612 + rng.int(-24, 18), y: 250 + rng.int(-20, 24) };
    const pathBEnd = { x: 555 + rng.int(-18, 28), y: 130 + rng.int(-18, 26) };
    const pathCEnd = { x: 515 + rng.int(-20, 24), y: 304 + rng.int(-18, 16) };
    const blockedPathEnd = validPath === "Path A" ? pathBEnd : validPath === "Path B" ? pathCEnd : pathAEnd;
    const blocker = {
      label: "D",
      x: (bank.x + blockedPathEnd.x) / 2 + rng.int(-6, 6),
      y: (bank.y + blockedPathEnd.y) / 2 + rng.int(-6, 6),
    };
    const paths = [
      { label: "Path A", color: "#ffd43b", points: [cue, bank, pathAEnd], valid: validPath === "Path A" && !blockedShot },
      { label: "Path B", color: "#39a9ff", points: [cue, bank, pathBEnd], valid: validPath === "Path B" && !blockedShot },
      { label: "Path C", color: "#ff5c8a", points: [cue, bank, secondBank, pathCEnd], valid: validPath === "Path C" && !blockedShot },
    ];
    const balls = [
      { label: "A", x: pathAEnd.x, y: pathAEnd.y, color: "#e3433b" },
      { label: "B", x: pathBEnd.x, y: pathBEnd.y, color: "#246df0" },
      { label: "C", x: pathCEnd.x, y: pathCEnd.y, color: "#10a052" },
      { label: "D", x: blocker.x, y: blocker.y, color: "#f0bf18", blocker: true },
    ];
    const prompt =
      taskIndex === 1
        ? "Choose the first labeled ball reached after the marked rebound sequence."
        : taskIndex === 2
          ? domain.prompts[2]
          : taskIndex === 3
            ? "Choose the only path that still works after two wall reflections."
            : domain.prompts[0];
    const task =
      taskIndex === 1
        ? "first_contact_after_bank"
        : taskIndex === 2
          ? "blocked_direct_shot"
          : taskIndex === 3
            ? "two_bank_path"
            : blockedShot
              ? "blocked_rebound"
              : "one_bank_path";
    return buildReasoningDraft(domain, index, serial, {
      task,
      prompt,
      answer,
      answerOptions:
        taskIndex === 1 || taskIndex === 2
          ? ["Ball A", "Ball B", "Ball C", "Ball D", "None"]
          : ["Path A", "Path B", "Path C", "Blocked"],
      scene: {
        target: taskIndex === 1 ? "first contact after rebound" : taskIndex === 2 ? "direct lane blocker" : "marked bank path",
        rule: taskIndex === 3 ? "two reflections plus first contact" : "angle of incidence equals angle of reflection",
        billiards: {
          cue,
          bank,
          secondBank,
          paths,
          balls,
          blocker,
          validPath: blockedShot ? "Blocked" : validPath,
          firstContact: pathToBall[validPath],
          blockedBy: "Ball D",
        },
      },
      solver: {
        method: "multi_candidate_bank_reflection",
        trace: `Generated valid path ${validPath}; first contact ${pathToBall[validPath]}; blocker Ball D sits on a decoy lane.`,
      },
    });
  }

  function makeMirrorPatternDraft(domain, index, serial, rng) {
    const shapes = ["circle", "rect", "diamond"];
    const colors = ["#e3433b", "#246df0", "#10a052", "#f0bf18"];
    const axis = (index + serial) % 2 === 0 ? "vertical" : "horizontal";
    const rows = 6;
    const cols = 8;
    const marks = [0, 1, 2, 3].map((slot) => ({
      label: String(slot + 1),
      col: axis === "vertical" ? slot : (index + slot * 2 + serial) % cols,
      row: axis === "vertical" ? (index + serial + slot * 2) % rows : slot % 3,
      shape: shapes[(index + slot + serial) % shapes.length],
      color: colors[(index + slot * 2 + serial) % colors.length],
    }));
    const missingSource = marks[rng.int(0, marks.length - 1)];
    const reflectedCell =
      axis === "vertical"
        ? { col: cols - 1 - missingSource.col, row: missingSource.row }
        : { col: missingSource.col, row: rows - 1 - missingSource.row };
    const missing = {
      ...reflectedCell,
      shape: missingSource.shape,
      color: missingSource.color,
    };
    const noMatch = (index + serial) % 7 === 0;
    const correctIndex = noMatch ? -1 : rng.int(0, 3);
    const tileOptions = ["Tile A", "Tile B", "Tile C", "Tile D"].map((label, optionIndex) => {
      const isCorrect = optionIndex === correctIndex && !noMatch;
      return {
        label,
        shape: isCorrect ? missing.shape : shapes[(optionIndex + index + 1) % shapes.length],
        color: isCorrect ? missing.color : colors[(optionIndex + serial + 1) % colors.length],
        correct: isCorrect,
      };
    });
    const answer = noMatch ? "No match" : tileOptions[correctIndex].label;
    return buildReasoningDraft(domain, index, serial, {
      task: `complete_${axis}_mirror`,
      prompt: noMatch ? "Choose No match if none of the tiles completes the reflected pattern." : domain.prompts[0],
      answer,
      answerOptions: ["Tile A", "Tile B", "Tile C", "Tile D", "No match"],
      scene: {
        target: `missing cell r${missing.row + 1} c${missing.col + 1}`,
        rule: `${axis} mirror symmetry with shape and color preserved`,
        mirrorPattern: {
          rows,
          cols,
          axis,
          marks,
          mirroredMarks: marks
            .filter((mark) => mark !== missingSource)
            .map((mark) => ({
              ...mark,
              label: `${mark.label}'`,
              col: axis === "vertical" ? cols - 1 - mark.col : mark.col,
              row: axis === "vertical" ? mark.row : rows - 1 - mark.row,
            })),
          missing,
          tileOptions,
          noMatch,
        },
      },
      solver: {
        method: "mirror_axis_cell_reflection",
        trace: `Missing source ${missingSource.label} reflects to r${missing.row + 1} c${missing.col + 1}; answer ${answer}.`,
      },
    });
  }

  function makeCubeCountDraft(domain, index, serial, rng) {
    const columns = [];
    const colors = ["#246df0", "#10a052", "#e3433b"];
    for (let z = 0; z < 3; z += 1) {
      for (let x = 0; x < 4; x += 1) {
        const ridge = x === 1 || z === 1 ? 1 : 0;
        const backBoost = z === 2 && x > 0 ? 1 : 0;
        const height = Core.clamp(rng.int(0, 3) + ridge + backBoost + (x === 0 && z === 0 ? 1 : 0), 0, 5);
        if (height > 0) columns.push({ x, z, height, color: colors[(x + z + index + serial) % colors.length] });
      }
    }
    const total = columns.reduce((sum, column) => sum + column.height, 0);
    const hidden = columns.reduce((sum, column) => sum + Math.max(0, column.height - 1), 0);
    const layers = Math.max(...columns.map((column) => column.height));
    const queryColor = colors[(index + serial) % colors.length];
    const colorCount = columns
      .filter((column) => column.color === queryColor)
      .reduce((sum, column) => sum + column.height, 0);
    const taskKinds = ["total", "hidden", "layers", "color"];
    const task = taskKinds[(index + serial) % taskKinds.length];
    const answer = task === "total" ? total : task === "hidden" ? hidden : task === "layers" ? layers : colorCount;
    return buildReasoningDraft(domain, index, serial, {
      task: `cube_count_${task}`,
      prompt:
        task === "total"
          ? domain.prompts[0]
          : task === "hidden"
            ? domain.prompts[1]
            : task === "layers"
              ? domain.prompts[2]
              : "Count only cubes with the highlighted color in the whole stack.",
      answer,
      answerOptions: numericAnswerOptions(answer, 0, 48),
      scene: {
        target: task === "total" ? "whole stack" : task === "hidden" ? "support cubes under visible top faces" : task === "layers" ? "maximum layer height" : `all ${cubeColorName(queryColor)} cubes`,
        rule:
          task === "total"
            ? "sum all occupied grid heights"
            : task === "hidden"
              ? "count cubes implied below visible top cubes"
              : task === "layers"
                ? "max stack height"
                : `sum column heights with color ${cubeColorName(queryColor)}`,
        cubeCount: {
          columns,
          total,
          hidden,
          layers,
          colorCount,
          queryColor,
          task,
        },
      },
      solver: {
        method: "grid_height_sum",
        trace: `Column heights are ${columns.map((column) => column.height).join("+")}; ${task} answer is ${answer}.`,
      },
    });
  }

  function makeMirrorClockDraft(domain, index, serial, rng) {
    const nearHourTrap = (index + serial) % 3 === 0;
    let trueMinutes = nearHourTrap ? rng.int(1, 11) * 60 + rng.pick([5, 10, 50, 55]) : rng.int(1, 143) * 5;
    if (trueMinutes % 60 === 0) trueMinutes += rng.pick([5, 55]);
    trueMinutes %= 720;
    const shownMinutes = mirrorClockMinutes(trueMinutes);
    const answer = formatClockTime(trueMinutes);
    const distractors = [
      formatClockTime(shownMinutes),
      formatClockTime((trueMinutes + 55) % 720),
      formatClockTime((trueMinutes + 65) % 720),
      formatClockTime((shownMinutes + 55) % 720),
      formatClockTime((shownMinutes + 65) % 720),
    ];
    return buildReasoningDraft(domain, index, serial, {
      task: nearHourTrap ? "mirror_clock_near_hour_trap" : "mirror_clock_actual_time",
      prompt: nearHourTrap ? "Choose the actual time; beware the hour hand is close to the next number." : domain.prompts[0],
      answer,
      answerOptions: distractors,
      scene: {
        target: "mirrored clock face",
        rule: "actual time plus mirror time sums to 12:00",
        mirrorClock: {
          shownTime: formatClockTime(shownMinutes),
          trueTime: answer,
          shownMinutes,
          trueMinutes,
          shownAngles: clockAngles(shownMinutes),
          trueAngles: clockAngles(trueMinutes),
          nearHourTrap,
        },
      },
      solver: {
        method: "twelve_hour_mirror_transform",
        trace: `Mirror transform: 12:00 - ${formatClockTime(shownMinutes)} = ${answer}; near-hour trap ${nearHourTrap}.`,
      },
    });
  }

  function mirrorClockMinutes(minutes) {
    return (720 - minutes) % 720;
  }

  function formatClockTime(minutes) {
    const normalized = ((minutes % 720) + 720) % 720;
    const rawHour = Math.floor(normalized / 60);
    const hour = rawHour === 0 ? 12 : rawHour;
    return `${hour}:${String(normalized % 60).padStart(2, "0")}`;
  }

  function clockAngles(minutes) {
    const normalized = ((minutes % 720) + 720) % 720;
    return {
      hour: normalized * 0.5,
      minute: (normalized % 60) * 6,
    };
  }

  function makeOverlapDraft(domain, index, serial, rng) {
    const shapes = [
      { label: "A", kind: "circle", x: 270 + rng.int(-18, 16), y: 198 + rng.int(-12, 14), r: 86, color: "#246df0" },
      { label: "B", kind: "rect", x: 310 + rng.int(-18, 22), y: 125 + rng.int(-12, 16), w: 178, h: 138, color: "#e3433b" },
      { label: "C", kind: "diamond", x: 502 + rng.int(-20, 16), y: 208 + rng.int(-10, 14), w: 166, h: 198, color: "#10a052" },
      { label: "D", kind: "circle", x: 420 + rng.int(-16, 18), y: 250 + rng.int(-14, 12), r: 58, color: "#f0bf18" },
      { label: "E", kind: "rect", x: 235 + rng.int(-12, 18), y: 116 + rng.int(-10, 14), w: 120, h: 86, color: "#d438e0" },
    ];
    const layerOrder = shapes.map((shape) => shape.label).sort((a, b) => {
      const scoreA = hashReasoningSeed(`${serial}:${index}:${a}`) % 7;
      const scoreB = hashReasoningSeed(`${serial}:${index}:${b}`) % 7;
      return scoreA - scoreB;
    });
    for (const shape of shapes) shape.layer = layerOrder.indexOf(shape.label);
    const pairs = overlappingShapePairs(shapes);
    const markedPair = pairs[(index + serial) % Math.max(1, pairs.length)] || ["A", "B"];
    const pairShapes = markedPair.map((label) => shapes.find((shape) => shape.label === label));
    const frontObject = pairShapes.slice().sort((a, b) => b.layer - a.layer)[0]?.label || "A";
    const coveredLabels = shapes
      .filter((shape) => shapes.some((other) => other.label !== shape.label && other.layer > shape.layer && boxesOverlap(shapeBox(shape), shapeBox(other))))
      .map((shape) => shape.label);
    const taskIndex = (index + serial) % 4;
    const taskInstruction =
      taskIndex === 0
        ? "흰 점이 찍힌 겹침 지점에서, 실제로 가장 위에 그려진 객체 라벨을 고르세요."
        : taskIndex === 1
          ? "흰 점이 찍힌 겹침 지점을 만드는 두 객체의 Pair를 고르세요. 면적이 겹친 경우만 인정하고, 단순 접촉은 제외합니다."
          : taskIndex === 2
            ? "더 앞의 객체에 면적 일부가 가려진 객체 수를 세세요. 같은 객체는 한 번만 세고, 모서리 접촉은 제외합니다."
            : "흰 점이 찍힌 겹침 지점에서, 위 객체 아래에 깔려 있는 뒤쪽 객체 라벨을 고르세요.";
    const answer =
      taskIndex === 0
        ? `Object ${frontObject}`
        : taskIndex === 1
          ? `Pair ${markedPair.join("-")}`
          : taskIndex === 2
            ? String(coveredLabels.length)
            : `Object ${pairShapes.slice().sort((a, b) => a.layer - b.layer)[0]?.label || "A"}`;
    const answerOptions =
      taskIndex === 0 || taskIndex === 3
        ? shapes.map((shape) => `Object ${shape.label}`)
        : taskIndex === 1
          ? [...pairs.map((pair) => `Pair ${pair.join("-")}`), "None"]
          : numericAnswerOptions(coveredLabels.length, 0, shapes.length);
    return buildReasoningDraft(domain, index, serial, {
      task:
        taskIndex === 0
          ? "front_at_overlap"
          : taskIndex === 1
            ? "overlap_pair"
            : taskIndex === 2
              ? "partially_covered_count"
              : "back_object_at_overlap",
      prompt:
        taskIndex === 3
          ? "At the white marked dot, choose the object behind the top object."
          : domain.prompts[taskIndex],
      instruction: taskInstruction,
      answer,
      answerOptions,
      scene: {
        target: taskIndex === 2 ? "partly covered objects, counted once" : `white dot overlap ${markedPair.join("-")}`,
        rule:
          taskIndex === 2
            ? "count each object covered by a higher layer once; ignore edge-only contact"
            : "judge only at the white dot; higher layer is visually on top",
        overlap: {
          shapes,
          pairs,
          markedPair,
          markedPoint: overlapPoint(pairShapes[0], pairShapes[1]),
          frontObject,
          coveredLabels,
        },
      },
      solver: {
        method: "bbox_intersection_plus_layer_order",
        trace: `Marked pair ${markedPair.join("-")} overlaps; front label is ${frontObject}; covered labels: ${coveredLabels.join(", ") || "none"}.`,
      },
    });
  }

  function cubeColorName(color) {
    const names = {
      "#246df0": "blue",
      "#10a052": "green",
      "#e3433b": "red",
      "#f0bf18": "yellow",
    };
    return names[color] || "marked-color";
  }

  function overlappingShapePairs(shapes) {
    const pairs = [];
    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = i + 1; j < shapes.length; j += 1) {
        if (boxesOverlap(shapeBox(shapes[i]), shapeBox(shapes[j]))) {
          pairs.push([shapes[i].label, shapes[j].label]);
        }
      }
    }
    return pairs;
  }

  function shapeBox(shape) {
    if (shape.kind === "circle") return { x: shape.x - shape.r, y: shape.y - shape.r, w: shape.r * 2, h: shape.r * 2 };
    if (shape.kind === "rect") return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    return { x: shape.x - shape.w / 2, y: shape.y - shape.h / 2, w: shape.w, h: shape.h };
  }

  function boxesOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function overlapPoint(a, b) {
    if (!a || !b) return { x: 380, y: 200 };
    const boxA = shapeBox(a);
    const boxB = shapeBox(b);
    const x1 = Math.max(boxA.x, boxB.x);
    const y1 = Math.max(boxA.y, boxB.y);
    const x2 = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
    const y2 = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  function makeSqlReasoningDraft(domain, index, serial, rng) {
    const records = makeVisualRecords(index, serial, rng);
    const sqlDraft = buildSqlTask(domain, records, index, serial, rng);
    return buildReasoningDraft(domain, index, serial, {
      ...sqlDraft,
      scene: {
        ...sqlDraft.scene,
        tiles: records.map((record) => ({
          label: record.label,
          hue: record.color,
          marker: `${record.shape} G${record.group} ${record.key}`,
          value: record.value,
          active: sqlDraft.activeLabels.includes(record.label),
        })),
        sql: {
          records,
          activeLabels: sqlDraft.activeLabels,
          candidates: sqlDraft.candidates,
          condition: sqlDraft.condition,
        },
      },
    });
  }

  function makeVisualRecords(index, serial, rng) {
    const colors = ["red", "blue", "green", "yellow"];
    const shapes = ["circle", "square", "star", "triangle"];
    const groups = ["A", "B", "C", "D"];
    return "ABCDEFGHIJKL".split("").map((label, i) => ({
      label,
      color: colors[(i + index + serial) % colors.length],
      shape: shapes[(i + Math.floor(i / 3) + serial) % shapes.length],
      group: groups[(i + rng.int(0, 3)) % groups.length],
      key: `K${(i * 2 + serial + index) % 6}`,
      linkedKey: `K${(i + serial + 3) % 6}`,
      value: ((index + 3) * (i + 2) + serial) % 12,
      tier: ["low", "mid", "high"][Math.min(2, Math.floor((((index + 3) * (i + 2) + serial) % 12) / 4))],
      flag: (i + index + serial) % 4 === 0,
      x: i % 6,
      y: Math.floor(i / 6),
    }));
  }

  function buildSqlTask(domain, records, index, serial, rng) {
    if (domain.id === "vq") return buildVisualQueryTask(domain, records, index, serial, rng);
    if (domain.id === "rc") return buildRelationClassifierTask(domain, records, index, serial, rng);
    if (domain.id === "cf") return buildConditionFilterTask(domain, records, index, serial, rng);
    if (domain.id === "tg") return buildTableGroupingTask(domain, records, index, serial, rng);
    if (domain.id === "pm") return buildPredicateMappingTask(domain, records, index, serial, rng);
    return buildColumnAssignmentTask(domain, records, index, serial, rng);
  }

  function buildVisualQueryTask(domain, records, index, serial, rng) {
    const groups = ["A", "B", "C", "D"];
    const combos = ["red", "blue", "green", "yellow"].flatMap((comboColor) =>
      ["circle", "square", "star", "triangle"].flatMap((comboShape) =>
        [3, 5, 7].map((threshold) => [comboColor, comboShape, threshold]),
      ),
    );
    let [color, shape, threshold] = combos[(index + serial) % combos.length];
    const useEmptyTrap = (index + serial) % 8 === 0;
    if (useEmptyTrap) {
      const emptyCombo = combos.find(([comboColor, comboShape, comboThreshold]) =>
        records.every((record) => record.color !== comboColor || record.shape !== comboShape || record.value < comboThreshold),
      );
      if (emptyCombo) [color, shape, threshold] = emptyCombo;
    } else {
      const uniqueCombos = combos.filter(([comboColor, comboShape, comboThreshold]) => {
        const matches = records.filter((record) => record.color === comboColor && record.shape === comboShape && record.value >= comboThreshold);
        const counts = groups.map((group) => matches.filter((record) => record.group === group).length);
        const max = Math.max(...counts);
        return max > 0 && counts.filter((count) => count === max).length === 1;
      });
      if (uniqueCombos.length) [color, shape, threshold] = uniqueCombos[(index + serial) % uniqueCombos.length];
    }
    const matches = records.filter((record) => record.color === color && record.shape === shape && record.value >= threshold);
    const groupCounts = groups.map((group) => ({
      label: `Group ${group}`,
      count: matches.filter((record) => record.group === group).length,
    }));
    const winner = groupCounts.slice().sort((a, b) => b.count - a.count)[0];
    const answer = winner.count > 0 ? winner.label : "No match";
    return {
      task: useEmptyTrap ? "visual_query_empty_trap" : "visual_select_group_threshold",
      prompt: domain.prompts[index % domain.prompts.length],
      answer,
      answerOptions: ["Group A", "Group B", "Group C", "Group D", "No match"],
      activeLabels: matches.map((record) => record.label),
      candidates: groupCounts.map((group) => `${group.label}: ${group.count}`),
      condition: `${color} + ${shape} + value >= ${threshold}`,
      scene: { target: "group with matching high-value members", rule: `color=${color} AND shape=${shape} AND value>=${threshold}` },
      solver: { method: "filter_threshold_then_group_count", trace: `${matches.length} records match ${color}/${shape}/>=${threshold}; answer ${answer}.` },
    };
  }

  function buildRelationClassifierTask(domain, records, index, serial) {
    const desired = ["Same group", "Parent key", "Near pair", "Anti match"][(index + serial) % 4];
    const pair = findRecordPair(records, desired) || [records[(index + serial) % records.length], records[(index + serial + 5) % records.length]];
    const answer = classifyRecordRelation(pair[0], pair[1]);
    const chainRecord = records.find((record) => record.label !== pair[0].label && record.key === pair[1].linkedKey) || records[(index + serial + 7) % records.length];
    const useChain = (index + serial) % 3 === 0;
    const activeLabels = useChain ? [pair[0].label, pair[1].label, chainRecord.label] : pair.map((record) => record.label);
    return {
      task: useChain ? "relation_chain_predicate_class" : "relation_predicate_class",
      prompt: domain.prompts[index % domain.prompts.length],
      answer,
      answerOptions: domain.answers,
      activeLabels,
      candidates: [
        `pair: ${pair[0].label}-${pair[1].label}`,
        `keys: ${pair[0].key}/${pair[1].key}`,
        `linked: ${pair[0].linkedKey}/${pair[1].linkedKey}`,
        useChain ? `chain: ${pair[0].label}-${pair[1].label}-${chainRecord.label}` : `groups: ${pair[0].group}/${pair[1].group}`,
      ],
      condition: useChain ? "classify highlighted pair inside a 3-record chain" : "classify highlighted pair",
      scene: { target: `${pair[0].label}-${pair[1].label}`, rule: "same group > linked key > near pair > anti match" },
      solver: { method: "relation_priority_classifier", trace: `${pair[0].label}-${pair[1].label} classified as ${answer}; chain mode ${useChain}.` },
    };
  }

  function classifyRecordRelation(a, b) {
    if (a.group === b.group) return "Same group";
    if (a.key === b.linkedKey || a.linkedKey === b.key || a.key === b.key) return "Parent key";
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 2) return "Near pair";
    return "Anti match";
  }

  function findRecordPair(records, desired) {
    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        if (classifyRecordRelation(records[i], records[j]) === desired) return [records[i], records[j]];
      }
    }
    return null;
  }

  function buildConditionFilterTask(domain, records, index, serial, rng) {
    const threshold = rng.int(4, 9);
    const excludedColor = rng.pick(["red", "blue", "green", "yellow"]);
    const requiredShape = rng.pick(["circle", "square", "star", "triangle"]);
    const useOrFlag = (index + serial) % 2 === 0;
    const pass = records.filter(
      (record) =>
        record.value >= threshold &&
        record.color !== excludedColor &&
        (record.shape === requiredShape || (useOrFlag && record.flag)),
    );
    const correctSlot = (index + serial) % 3;
    const passLabels = pass.map((record) => record.label);
    const nonPassLabels = records.filter((record) => !passLabels.includes(record.label)).map((record) => record.label);
    const passBuckets = ["Pass A", "Pass B", "Pass C"].map((label, bucketIndex) => {
      const labels =
        pass.length && bucketIndex === correctSlot
          ? passLabels
          : nonPassLabels.slice(bucketIndex, bucketIndex + Math.max(1, Math.min(3, nonPassLabels.length)));
      return `${label}: ${labels.join(",") || "-"}`;
    });
    const answer = pass.length ? ["Pass A", "Pass B", "Pass C"][correctSlot] : "No rows";
    return {
      task: "condition_filter",
      prompt: domain.prompts[index % domain.prompts.length],
      answer,
      answerOptions: ["Pass A", "Pass B", "Pass C", "No rows"],
      activeLabels: pass.map((record) => record.label),
      candidates: [...passBuckets, `Exclude color: ${excludedColor}`, `Shape/flag: ${requiredShape}${useOrFlag ? " OR flag" : ""}`],
      condition: `value >= ${threshold}, color != ${excludedColor}, ${requiredShape}${useOrFlag ? " or flag" : ""}`,
      scene: { target: "records surviving three visual filters", rule: `value>=${threshold} AND NOT ${excludedColor} AND (${requiredShape}${useOrFlag ? " OR flag" : ""})` },
      solver: { method: "where_filter_with_or_clause", trace: `${pass.length} records pass threshold ${threshold}, excluding ${excludedColor}, requiring ${requiredShape}${useOrFlag ? " or flag" : ""}.` },
    };
  }

  function buildTableGroupingTask(domain, records, index, serial, rng) {
    const key = rng.pick(["color", "shape", "group", "tier"]);
    const aggregate = rng.pick(["count", "sum"]);
    const threshold = aggregate === "count" ? rng.int(2, 4) : rng.int(12, 24);
    const buckets = {};
    for (const record of records) buckets[record[key]] = [...(buckets[record[key]] || []), record];
    const scored = Object.entries(buckets).map(([name, groupRecords]) => ({
        name,
        records: groupRecords,
        score: aggregate === "count" ? groupRecords.length : groupRecords.reduce((sum, record) => sum + record.value, 0),
      }));
    const passing = scored
      .filter((bucket) => bucket.score >= threshold)
      .sort((a, b) => b.score - a.score)[0];
    const bucketNames = ["Bucket A", "Bucket B", "Bucket C", "Bucket D"];
    const bucketLabel = passing ? bucketNames[scored.indexOf(passing) % bucketNames.length] : "No group";
    return {
      task: `group_by_${aggregate}_having`,
      prompt: domain.prompts[index % domain.prompts.length],
      answer: bucketLabel,
      answerOptions: ["Bucket A", "Bucket B", "Bucket C", "Bucket D", "No group"],
      activeLabels: passing ? passing.records.map((record) => record.label) : [],
      candidates: scored.slice(0, 4).map((bucket, i) => `${bucketNames[i]} ${bucket.name}: ${bucket.score}`),
      condition: `GROUP BY ${key}, choose highest ${aggregate} bucket with value >= ${threshold}`,
      scene: { target: "highest bucket passing aggregate rule", rule: `group=${key}, ${aggregate} >= ${threshold}` },
      solver: { method: "group_by_aggregate_having", trace: `${key} buckets: ${scored.map((bucket) => `${bucket.name}:${bucket.score}`).join(", ")}.` },
    };
  }

  function buildPredicateMappingTask(domain, records, index, serial, rng) {
    const predicate = rng.pick(["equals", "between", "exists", "not exists"]);
    const anchor = records[(index + serial) % records.length];
    const activeLabels =
      predicate === "equals"
        ? records.filter((record) => record.color === anchor.color && record.group === anchor.group).map((record) => record.label)
        : predicate === "between"
          ? records.filter((record) => record.value >= 4 && record.value <= 9).map((record) => record.label)
          : predicate === "exists"
            ? records.filter((record) => records.some((other) => other.label !== record.label && other.key === record.linkedKey)).map((record) => record.label)
            : records.filter((record) => !records.some((other) => other.label !== record.label && other.key === record.linkedKey)).map((record) => record.label);
    return {
      task: "predicate_mapping",
      prompt: domain.prompts[index % domain.prompts.length],
      answer: predicate,
      answerOptions: domain.answers,
      activeLabels,
      candidates: [
        `equals: ${anchor.color}+G${anchor.group}`,
        `between: value 4..9`,
        `exists: linkedKey has owner`,
        `not exists: no linked owner`,
      ],
      condition: `highlighted compound rule maps to ${predicate}`,
      scene: { target: "highlighted predicate strip", rule: `${predicate} over color/group/value/key` },
      solver: { method: "compound_visual_predicate_template", trace: `Generated predicate template is ${predicate}; active labels ${activeLabels.join(",") || "none"}.` },
    };
  }

  function buildColumnAssignmentTask(domain, records, index, serial, rng) {
    const roles = ["Primary key", "Foreign key", "Metric", "Dimension"];
    const role = rng.pick(roles);
    const anchor = records[(index + serial) % records.length];
    const activeLabels =
      role === "Metric"
        ? records.filter((record) => record.value >= 7).map((record) => record.label)
        : role === "Dimension"
          ? records.filter((record) => record.group === anchor.group || record.color === anchor.color).map((record) => record.label)
          : role === "Foreign key"
            ? records.filter((record) => records.some((other) => other.key === record.linkedKey)).map((record) => record.label)
            : records.filter((record, i, all) => all.findIndex((other) => other.key === record.key) === i).map((record) => record.label);
    return {
      task: "column_role_assignment",
      prompt: domain.prompts[index % domain.prompts.length],
      answer: role,
      answerOptions: roles,
      activeLabels,
      candidates: [`primary: unique key`, `foreign: linkedKey->key`, `metric: value>=7`, `dimension: group/color`, `target role: ${role}`],
      condition: `assign visual field to ${role} using key, linkedKey, value, and dimension cues`,
      scene: { target: "highlighted visual column", rule: `${role} role over visual table` },
      solver: { method: "multi_column_role_assignment", trace: `Generated visual query requests ${role}; active labels ${activeLabels.join(",") || "none"}.` },
    };
  }

  function showConfirmDialog({ title, message, yesText, danger = false, onConfirm, returnFocus }) {
    pendingConfirmAction = onConfirm;
    pendingConfirmFocus = returnFocus || null;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmYesBtn.textContent = yesText;
    els.confirmYesBtn.className = danger ? "danger-btn" : "primary-btn";
    els.confirmModal.classList.remove("hidden");
    els.confirmYesBtn.focus();
  }

  function showResetConfirm() {
    showConfirmDialog({
      title: "Reset local batch?",
      message:
        "This clears the current local cache without exporting, then creates a fresh 100-item batch.",
      yesText: "Reset 100",
      danger: true,
      onConfirm: resetBatchAndCache,
      returnFocus: els.resetBatchBtn,
    });
  }

  function hideConfirmDialog() {
    els.confirmModal.classList.add("hidden");
    pendingConfirmAction = null;
    const focusTarget = pendingConfirmFocus;
    pendingConfirmFocus = null;
    focusTarget?.focus();
  }

  function runConfirmedAction() {
    const action = pendingConfirmAction;
    hideConfirmDialog();
    action?.();
  }

  function resetBatchAndCache() {
    for (const key of STORAGE_KEYS_TO_CLEAR) localStorage.removeItem(key);
    state.queue = [];
    state.currentIndex = 0;
    state.batchSerial = 0;
    regenerateBatch(100);
  }

  function statusCounts() {
    const counts = { approved: 0, rejected: 0, pending: 0, evalPicks: 0 };
    for (const item of state.queue) {
      const status = item.annotation.status || "pending";
      if (status === "approved") counts.approved += 1;
      else if (status === "rejected") counts.rejected += 1;
      else counts.pending += 1;
      if (item.annotation.flags.includes("good_eval_sample")) counts.evalPicks += 1;
    }
    return counts;
  }

  function ensureCanvasSize() {
    const rect = els.sceneCanvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [els.fieldCanvas, els.sceneCanvas]) {
      const width = Math.max(640, Math.floor(rect.width * dpr));
      const height = Math.max(420, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
  }

  async function initRenderer() {
    if (!navigator.gpu) {
      renderer.statusText = "Canvas2D renderer, WebGPU unavailable";
      if (isSafVisible()) els.rendererStatus.textContent = renderer.statusText;
      renderer.initializing = false;
      return;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter");
      renderer.device = await adapter.requestDevice();
      renderer.context = els.fieldCanvas.getContext("webgpu");
      if (!renderer.context) throw new Error("Canvas WebGPU context unavailable");
      renderer.format = navigator.gpu.getPreferredCanvasFormat();
      renderer.context.configure({
        device: renderer.device,
        format: renderer.format,
        alphaMode: "premultiplied",
      });
      renderer.uniformBuffer = renderer.device.createBuffer({
        size: 16 * 4 * (MAX_GPU_CHARGES + 2),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const shader = renderer.device.createShaderModule({
        code: `
struct Uniforms {
  meta: vec4<f32>,
  charges: array<vec4<f32>, ${MAX_GPU_CHARGES}>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(3.0, 1.0),
    vec2<f32>(-1.0, 1.0)
  );
  var out: VertexOut;
  out.position = vec4<f32>(pos[index], 0.0, 1.0);
  out.uv = (pos[index] + vec2<f32>(1.0, 1.0)) * 0.5;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let extent = u.meta.x;
  let count = i32(u.meta.y);
  let aspect = u.meta.z;
  let overlay = u.meta.w;
  let paper = vec3<f32>(0.965, 0.985, 0.990);
  if (overlay < 0.5) {
    let grid = 0.012 * sin(in.uv.x * 72.0) + 0.012 * sin(in.uv.y * 56.0);
    return vec4<f32>(paper + vec3<f32>(grid), 1.0);
  }
  var coord = vec2<f32>((in.uv.x * 2.0 - 1.0) * extent * aspect, (1.0 - in.uv.y * 2.0) * extent);
  var e = vec2<f32>(0.0, 0.0);
  var v = 0.0;
  for (var i = 0; i < ${MAX_GPU_CHARGES}; i = i + 1) {
    if (i >= count) { break; }
    let c = u.charges[i];
    let d = coord - c.xy;
    let r2 = dot(d, d) + 0.065;
    let r = sqrt(r2);
    e = e + c.z * d / (r2 * r);
    v = v + c.z / r;
  }
  let mag = length(e);
  let warm = vec3<f32>(0.93, 0.50, 0.34);
  let cool = vec3<f32>(0.23, 0.55, 0.78);
  let neutral = paper;
  let signMix = clamp(abs(v) * 0.09, 0.0, 0.42);
  let signedColor = select(cool, warm, v >= 0.0);
  let energy = clamp(log(1.0 + mag) * 0.16, 0.0, 0.34);
  let color = mix(neutral, signedColor, signMix + energy);
  return vec4<f32>(color, 1.0);
}
`,
      });
      renderer.pipeline = renderer.device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: {
          module: shader,
          entryPoint: "fs",
          targets: [{ format: renderer.format }],
        },
      });
      renderer.bindGroup = renderer.device.createBindGroup({
        layout: renderer.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: renderer.uniformBuffer } }],
      });
      initSpatialPipeline();
      renderer.gpuReady = true;
      renderer.mode = "webgpu";
      renderer.statusText = "WebGPU active: 3D scene renderer + Canvas label overlay";
      if (isSafVisible()) els.rendererStatus.textContent = renderer.statusText;
    } catch (error) {
      console.warn("WebGPU setup failed", error);
      renderer.gpuReady = false;
      renderer.mode = "canvas2d";
      renderer.statusText = `Canvas2D fallback: ${error.message}`;
      if (isSafVisible()) els.rendererStatus.textContent = renderer.statusText;
    }
    renderer.initializing = false;
  }

  function initSpatialPipeline() {
    const device = renderer.device;
    renderer.spatialUniformBuffer = device.createBuffer({
      size: 16 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const shader = device.createShaderModule({
      code: `
struct Uniforms {
  meta: vec4<f32>,
  extra0: vec4<f32>,
  extra1: vec4<f32>,
  extra2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(position, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
`,
    });
    renderer.spatialPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 6 * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs",
        targets: [{ format: renderer.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    renderer.spatialBindGroup = device.createBindGroup({
      layout: renderer.spatialPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: renderer.spatialUniformBuffer } }],
    });
  }

  function renderFieldTexture(instance) {
    if (renderer.initializing) return;
    if (!instance) {
      if (renderer.gpuReady) renderGpuClear();
      else clearCanvas(els.fieldCanvas);
      return;
    }
    if (instance.family === "spatial_3d_scene") {
      if (renderer.gpuReady) renderGpu3DScene(instance);
      else renderCpu3DScene(instance);
      return;
    }
    if (renderer.gpuReady) {
      renderGpuField(instance);
      return;
    }
    if (!overlay) renderPaperTexture(instance);
    else renderCpuField(instance);
  }

  function renderGpuClear() {
    const device = renderer.device;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderer.context.getCurrentTexture().createView(),
          clearValue: { r: 0.965, g: 0.985, b: 0.99, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function renderPaperTexture(instance) {
    const canvas = els.fieldCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, "#f8fbfc");
    gradient.addColorStop(0.52, "#fbfaf6");
    gradient.addColorStop(1, "#f4f8f9");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#dfe8ec";
    const extent = instance.parameters.gridExtent;
    const scale = screenScale(instance);
    for (let y = -extent; y <= extent; y += 2) {
      for (let x = -Math.ceil(extent * (w / h)); x <= Math.ceil(extent * (w / h)); x += 2) {
        const p = worldToScreen(instance, { x, y });
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.2, scale * 0.018), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function renderGpuField(instance) {
    const device = renderer.device;
    const aspect = els.fieldCanvas.width / Math.max(els.fieldCanvas.height, 1);
    const values = new Float32Array(4 * (MAX_GPU_CHARGES + 2));
    values[0] = instance.parameters.gridExtent;
    values[1] = Math.min(instance.charges.length, MAX_GPU_CHARGES);
    values[2] = aspect;
    values[3] = overlay ? 1 : 0;
    instance.charges.slice(0, MAX_GPU_CHARGES).forEach((charge, index) => {
      const offset = 4 + index * 4;
      values[offset] = charge.x;
      values[offset + 1] = charge.y;
      values[offset + 2] = charge.q;
      values[offset + 3] = 0;
    });
    device.queue.writeBuffer(renderer.uniformBuffer, 0, values);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderer.context.getCurrentTexture().createView(),
          clearValue: { r: 0.965, g: 0.985, b: 0.99, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(renderer.pipeline);
    pass.setBindGroup(0, renderer.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function renderCpuField(instance) {
    const canvas = els.fieldCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const step = Math.max(3, Math.round(Math.min(w, h) / 210));
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#f5fbfc";
    ctx.fillRect(0, 0, w, h);
    const image = ctx.createImageData(w, h);
    const data = image.data;
    const extent = instance.parameters.gridExtent;
    const aspect = w / h;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const coord = {
          x: ((x / w) * 2 - 1) * extent * aspect,
          y: (1 - (y / h) * 2) * extent,
        };
        const solution = Core.computeFieldAt(coord, instance.charges);
        const mag = Math.log(1 + solution.fieldMagnitude);
        const v = solution.potential;
        const energy = Core.clamp(mag * 0.11, 0, 0.28);
        const sign = Core.clamp(Math.abs(v) * 0.06, 0, 0.32);
        const warm = [237, 127, 86];
        const cool = [59, 140, 197];
        const base = [246, 251, 252];
        const tint = v >= 0 ? warm : cool;
        const mix = sign + energy;
        for (let yy = 0; yy < step; yy += 1) {
          for (let xx = 0; xx < step; xx += 1) {
            const px = x + xx;
            const py = y + yy;
            if (px >= w || py >= h) continue;
            const offset = (py * w + px) * 4;
            data[offset] = Math.round(base[0] * (1 - mix) + tint[0] * mix);
            data[offset + 1] = Math.round(base[1] * (1 - mix) + tint[1] * mix);
            data[offset + 2] = Math.round(base[2] * (1 - mix) + tint[2] * mix);
            data[offset + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function renderGpu3DScene(instance) {
    const device = renderer.device;
    const vertices = buildSpatialVertices(instance);
    ensureSpatialVertexBuffer(vertices.byteLength);
    ensureDepthTexture();
    device.queue.writeBuffer(renderer.spatialVertexBuffer, 0, vertices);
    device.queue.writeBuffer(renderer.spatialUniformBuffer, 0, new Float32Array(16));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderer.context.getCurrentTexture().createView(),
          clearValue: { r: 0.965, g: 0.982, b: 0.988, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: renderer.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(renderer.spatialPipeline);
    pass.setBindGroup(0, renderer.spatialBindGroup);
    pass.setVertexBuffer(0, renderer.spatialVertexBuffer);
    pass.draw(vertices.length / 6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function ensureSpatialVertexBuffer(requiredBytes) {
    if (renderer.spatialVertexBuffer && renderer.spatialVertexCapacity >= requiredBytes) return;
    renderer.spatialVertexCapacity = Math.max(requiredBytes, 1024 * 64);
    renderer.spatialVertexBuffer = renderer.device.createBuffer({
      size: renderer.spatialVertexCapacity,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  function ensureDepthTexture() {
    const width = els.fieldCanvas.width;
    const height = els.fieldCanvas.height;
    if (
      renderer.depthTexture &&
      renderer.depthSize.width === width &&
      renderer.depthSize.height === height
    ) {
      return;
    }
    renderer.depthTexture?.destroy?.();
    renderer.depthTexture = renderer.device.createTexture({
      size: { width, height },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    renderer.depthSize = { width, height };
  }

  function buildSpatialVertices(instance) {
    const out = [];
    for (const object of instance.objects || []) {
      addBoxVertices(out, instance, object);
    }
    addGroundPlane(out, instance);
    return new Float32Array(out);
  }

  function addBoxVertices(out, instance, object) {
    const sx = object.size.x / 2;
    const sy = object.size.y;
    const sz = object.size.z / 2;
    const yaw = object.yaw || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const base = object.position;
    const baseY = objectBaseY(object);
    const corners = [
      [-sx, 0, -sz],
      [sx, 0, -sz],
      [sx, 0, sz],
      [-sx, 0, sz],
      [-sx, sy, -sz],
      [sx, sy, -sz],
      [sx, sy, sz],
      [-sx, sy, sz],
    ].map(([x, y, z]) => ({
      x: base.x + x * cos - z * sin,
      y: baseY + y,
      z: base.z + x * sin + z * cos,
    }));
    const color = object.rgb || [0.45, 0.52, 0.58];
    const faces = [
      [[0, 1, 2, 3], 0.62],
      [[4, 7, 6, 5], 1.18],
      [[3, 2, 6, 7], 1.0],
      [[1, 5, 6, 2], 0.86],
      [[0, 3, 7, 4], 0.78],
      [[0, 4, 5, 1], 0.7],
    ];
    for (const [indices, shade] of faces) {
      addQuad(out, instance, indices.map((index) => corners[index]), color, shade);
    }
  }

  function addGroundPlane(out, instance) {
    const extent = instance.parameters?.gridExtent || 6;
    const y = -0.02;
    const points = [
      { x: -extent, y, z: -extent },
      { x: extent, y, z: -extent },
      { x: extent, y, z: extent },
      { x: -extent, y, z: extent },
    ];
    addQuad(out, instance, points, [0.78, 0.84, 0.86], 0.62);
  }

  function addQuad(out, instance, points, color, shade) {
    addTri(out, instance, [points[0], points[1], points[2]], color, shade);
    addTri(out, instance, [points[0], points[2], points[3]], color, shade);
  }

  function addTri(out, instance, points, color, shade) {
    for (const point of points) {
      const projected = project3DToNdc(instance, point);
      out.push(
        projected.x,
        projected.y,
        projected.z,
        Core.clamp(color[0] * shade, 0, 1),
        Core.clamp(color[1] * shade, 0, 1),
        Core.clamp(color[2] * shade, 0, 1),
      );
    }
  }

  function project3DToNdc(instance, point) {
    const extent = instance.parameters?.gridExtent || 6;
    const aspect = els.fieldCanvas.width / Math.max(els.fieldCanvas.height, 1);
    const p = rotatePointForCamera(point);
    const x = (p.x * camera.zoom) / (extent * 1.16 * aspect) + camera.panX;
    const y = (p.y * camera.zoom) / (extent * 1.02) - 0.22 + camera.panY;
    const z = Core.clamp(0.54 - p.z * 0.04, 0.03, 0.97);
    return { x, y, z };
  }

  function rotatePointForCamera(point) {
    const yawCos = Math.cos(camera.yaw);
    const yawSin = Math.sin(camera.yaw);
    const pitchCos = Math.cos(camera.pitch);
    const pitchSin = Math.sin(camera.pitch);
    const yawX = point.x * yawCos - point.z * yawSin;
    const yawZ = point.x * yawSin + point.z * yawCos;
    return {
      x: yawX,
      y: point.y * pitchCos - yawZ * pitchSin,
      z: point.y * pitchSin + yawZ * pitchCos,
    };
  }

  function objectBaseY(object) {
    if (Number.isFinite(object.baseY)) return object.baseY;
    if (object.position && object.size) return object.position.y - object.size.y / 2;
    return 0;
  }

  function project3DToScreen(instance, point) {
    const ndc = project3DToNdc(instance, point);
    return {
      x: (ndc.x * 0.5 + 0.5) * els.sceneCanvas.width,
      y: (0.5 - ndc.y * 0.5) * els.sceneCanvas.height,
      z: ndc.z,
    };
  }

  function renderCpu3DScene(instance) {
    const canvas = els.fieldCanvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#f8fbfc");
    gradient.addColorStop(1, "#edf3f5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const ordered = [...(instance.objects || [])].sort((a, b) => a.position.z - b.position.z);
    for (const object of ordered) {
      const baseY = objectBaseY(object);
      const top = project3DToScreen(instance, {
        x: object.position.x,
        y: baseY + object.size.y,
        z: object.position.z,
      });
      const base = project3DToScreen(instance, {
        x: object.position.x,
        y: baseY,
        z: object.position.z,
      });
      const width = Math.max(26, object.size.x * 42);
      const height = Math.max(34, base.y - top.y);
      const [r, g, b] = object.rgb.map((value) => Math.round(value * 255));
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.fillRect(base.x - width / 2, top.y, width, height);
      ctx.strokeRect(base.x - width / 2, top.y, width, height);
    }
  }

  function clearCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function worldToScreen(instance, point) {
    const canvas = els.sceneCanvas;
    const pad = 48;
    const extent = instance.parameters.gridExtent;
    const aspect = canvas.width / Math.max(canvas.height, 1);
    const xExtent = extent * aspect;
    const sx = pad + ((point.x + xExtent) / (xExtent * 2)) * (canvas.width - pad * 2);
    const sy = pad + ((extent - point.y) / (extent * 2)) * (canvas.height - pad * 2);
    return { x: sx, y: sy };
  }

  function screenScale(instance) {
    const pad = 48;
    return (els.sceneCanvas.height - pad * 2) / (instance.parameters.gridExtent * 2);
  }

  function renderScene(instance) {
    const canvas = els.sceneCanvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!instance) {
      ctx.fillStyle = "#51616b";
      ctx.font = "700 24px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Generate a batch to start.", canvas.width / 2, canvas.height / 2);
      return;
    }
    if (instance.family === "spatial_3d_scene") {
      draw3DOverlay(ctx, instance);
      return;
    }
    drawGrid(ctx, instance);
    drawCharges(ctx, instance);
    drawProbeAndCandidates(ctx, instance);
    if (overlay) drawSolverOverlay(ctx, instance);
  }

  function draw3DOverlay(ctx, instance) {
    draw3DGroundGrid(ctx, instance);
    for (const object of instance.objects || []) {
      draw3DObjectGuide(ctx, instance, object);
      const top = project3DToScreen(instance, {
        x: object.position.x,
        y: objectBaseY(object) + object.size.y + 0.12,
        z: object.position.z,
      });
      const base = project3DToScreen(instance, {
        x: object.position.x,
        y: objectBaseY(object),
        z: object.position.z,
      });
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.strokeStyle = instance.scene?.target === object.label ? "#172128" : "#637680";
      ctx.lineWidth = instance.scene?.target === object.label ? 4 : 2;
      ctx.beginPath();
      ctx.roundRect(top.x - 14, top.y - 14, 28, 28, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#172128";
      ctx.font = "900 15px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(object.label, top.x, top.y + 0.5);
      if (object.occluded && overlay) {
        ctx.fillStyle = "rgba(184,68,63,0.92)";
        ctx.font = "800 11px system-ui";
        ctx.fillText("hidden", base.x, base.y + 18);
      }
      ctx.restore();
    }
    if (overlay) draw3DSolverOverlay(ctx, instance);
  }

  function draw3DObjectGuide(ctx, instance, object) {
    const sx = object.size.x / 2;
    const sy = object.size.y;
    const sz = object.size.z / 2;
    const yaw = object.yaw || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const base = object.position;
    const baseY = objectBaseY(object);
    const corners = [
      [-sx, 0, -sz],
      [sx, 0, -sz],
      [sx, 0, sz],
      [-sx, 0, sz],
      [-sx, sy, -sz],
      [sx, sy, -sz],
      [sx, sy, sz],
      [-sx, sy, sz],
    ].map(([x, y, z]) =>
      project3DToScreen(instance, {
        x: base.x + x * cos - z * sin,
        y: baseY + y,
        z: base.z + x * sin + z * cos,
      }),
    );
    const [r, g, b] = (object.rgb || [0.45, 0.52, 0.58]).map((value) => Math.round(value * 255));
    ctx.save();
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.18)`;
    ctx.strokeStyle = `rgba(${Math.max(0, r - 24)}, ${Math.max(0, g - 24)}, ${Math.max(0, b - 24)}, 0.62)`;
    ctx.lineWidth = 2;
    for (const face of [
      [4, 5, 6, 7],
      [3, 2, 6, 7],
      [1, 5, 6, 2],
    ]) {
      ctx.beginPath();
      ctx.moveTo(corners[face[0]].x, corners[face[0]].y);
      for (let i = 1; i < face.length; i += 1) ctx.lineTo(corners[face[i]].x, corners[face[i]].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    for (const [a, bIndex] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ]) {
      ctx.beginPath();
      ctx.moveTo(corners[a].x, corners[a].y);
      ctx.lineTo(corners[bIndex].x, corners[bIndex].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw3DGroundGrid(ctx, instance) {
    const extent = instance.parameters?.gridExtent || 6;
    ctx.save();
    ctx.strokeStyle = "rgba(23,33,40,0.12)";
    ctx.lineWidth = 1;
    for (let i = -extent; i <= extent; i += 1) {
      const a = project3DToScreen(instance, { x: -extent, y: 0, z: i });
      const b = project3DToScreen(instance, { x: extent, y: 0, z: i });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const c = project3DToScreen(instance, { x: i, y: 0, z: -extent });
      const d = project3DToScreen(instance, { x: i, y: 0, z: extent });
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw3DSolverOverlay(ctx, instance) {
    ctx.save();
    ctx.fillStyle = "rgba(23,33,40,0.78)";
    ctx.font = "800 12px system-ui";
    ctx.textAlign = "center";
    for (const object of instance.objects || []) {
      const base = project3DToScreen(instance, {
        x: object.position.x,
        y: objectBaseY(object),
        z: object.position.z,
      });
      ctx.fillText(
        `x${object.position.x} z${object.position.z} h${object.size.y}`,
        base.x,
        base.y + 34,
      );
    }
    ctx.restore();
  }

  function drawGrid(ctx, instance) {
    const extent = instance.parameters.gridExtent;
    const scale = screenScale(instance);
    ctx.save();
    ctx.lineWidth = Math.max(1, scale * 0.012);
    for (let i = -extent; i <= extent; i += 1) {
      const a = worldToScreen(instance, { x: -extent * 2, y: i });
      const b = worldToScreen(instance, { x: extent * 2, y: i });
      ctx.strokeStyle = i === 0 ? "rgba(22,32,38,0.32)" : "rgba(22,32,38,0.08)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const aspect = ctx.canvas.width / ctx.canvas.height;
    const xExtent = Math.ceil(extent * aspect);
    for (let i = -xExtent; i <= xExtent; i += 1) {
      const a = worldToScreen(instance, { x: i, y: -extent });
      const b = worldToScreen(instance, { x: i, y: extent });
      ctx.strokeStyle = i === 0 ? "rgba(22,32,38,0.32)" : "rgba(22,32,38,0.08)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCharges(ctx, instance) {
    const scale = screenScale(instance);
    for (const charge of instance.charges) {
      const p = worldToScreen(instance, charge);
      const radius = Math.max(16, scale * 0.32 + Math.abs(charge.q) * 1.8);
      const positive = charge.q > 0;
      ctx.save();
      ctx.shadowColor = "rgba(20, 30, 36, 0.22)";
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = positive ? "#db4f45" : "#246ea8";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `900 ${Math.max(18, radius * 0.86)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(positive ? "+" : "−", p.x, p.y - 1);
      ctx.fillStyle = "#162026";
      ctx.font = `800 ${Math.max(11, radius * 0.42)}px system-ui`;
      ctx.textBaseline = "top";
      ctx.fillText(`${charge.id} ${charge.q > 0 ? "+" : ""}${charge.q}`, p.x, p.y + radius + 5);
      ctx.restore();
    }
  }

  function drawProbeAndCandidates(ctx, instance) {
    const probe = worldToScreen(instance, instance.probe);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#17242a";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(probe.x, probe.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#17242a";
    ctx.font = "900 15px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("P", probe.x, probe.y + 0.5);
    ctx.restore();

    if (!instance.type.includes("candidate")) return;
    for (const candidate of instance.candidates) {
      const p = worldToScreen(instance, candidate);
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.strokeStyle = "#7553a6";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(p.x - 13, p.y - 13, 26, 26, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#4b3470";
      ctx.font = "900 15px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(candidate.label, p.x, p.y + 0.5);
      ctx.restore();
    }
  }

  function drawSolverOverlay(ctx, instance) {
    const field = instance.solver.fieldAtProbe.field;
    const probe = worldToScreen(instance, instance.probe);
    drawArrow(ctx, probe, field, "#1f7a4d", "E(P)");
    for (const contribution of instance.solver.fieldAtProbe.contributions) {
      const charge = instance.charges.find((item) => item.id === contribution.chargeId);
      const start = worldToScreen(instance, charge);
      const end = {
        x: probe.x,
        y: probe.y,
      };
      ctx.save();
      ctx.strokeStyle = charge.q > 0 ? "rgba(180,65,59,0.24)" : "rgba(28,106,166,0.24)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.restore();
    }
    if (instance.type.includes("candidate")) {
      for (const candidate of instance.solver.candidates) {
        const point = worldToScreen(instance, candidate.point);
        ctx.save();
        ctx.fillStyle = "rgba(22,32,38,0.82)";
        ctx.font = "800 12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(`|E| ${candidate.fieldMagnitude}`, point.x, point.y + 29);
        ctx.restore();
      }
    }
  }

  function drawArrow(ctx, origin, vector, color, label) {
    const unit = Core.normalize(vector);
    const length = 86;
    const end = { x: origin.x + unit.x * length, y: origin.y - unit.y * length };
    const angle = Math.atan2(end.y - origin.y, end.x - origin.x);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - 13 * Math.cos(angle - Math.PI / 6), end.y - 13 * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(end.x - 13 * Math.cos(angle + Math.PI / 6), end.y - 13 * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.font = "900 13px system-ui";
    ctx.fillText(label, end.x + 10, end.y - 8);
    ctx.restore();
  }

  function syncUiFromInstance(instance) {
    if (!instance) {
      els.instanceId.textContent = "no-instance";
      els.promptText.textContent = "Generate a batch to start annotation.";
      els.autoAnswerText.textContent = "-";
      els.workInstruction.textContent = "정답 후보 하나를 고르고 넘기세요.";
      els.humanAnswerSelect.innerHTML = "";
      els.solverTrace.textContent = "";
      els.variablesView.textContent = "";
      return;
    }
    els.instanceId.textContent = instance.id;
    els.promptText.textContent = instance.prompt;
    renderWorkInstruction(instance);
    els.statusBadge.textContent = instance.annotation.status || "pending";
    els.statusBadge.dataset.status = instance.annotation.status || "pending";
    els.autoAnswerText.textContent = instance.answer;
    els.splitSelect.value = instance.annotation.split || "train";

    els.humanAnswerSelect.innerHTML = "";
    for (const option of instance.answerOptions) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      els.humanAnswerSelect.appendChild(el);
    }
    els.humanAnswerSelect.value = instance.annotation.humanAnswer || instance.answer;

    for (const input of document.querySelectorAll("[data-label]")) {
      const key = input.dataset.label;
      input.value = instance.annotation.labels[key] ?? input.value;
    }
    els.notesInput.value = instance.annotation.notes || "";

    for (const button of els.flagGrid.querySelectorAll("button")) {
      button.classList.toggle("active", instance.annotation.flags.includes(button.dataset.flag));
    }

    els.solverTrace.textContent = instance.solver.trace;
    els.variablesView.textContent = JSON.stringify(
      {
        family: instance.family,
        answer: instance.answer,
        type: instance.type,
        charges: instance.charges,
        probe: instance.probe,
        candidates: instance.candidates,
        objects: instance.objects,
        scene: instance.scene,
        metrics: instance.metrics,
        fieldAtProbe: instance.solver.fieldAtProbe,
        annotation: instance.annotation,
      },
      null,
      2,
    );
  }

  function renderWorkInstruction(instance) {
    els.workInstruction.replaceChildren(...workInstructionNodesFor(instance));
  }

  function workInstructionNodesFor(instance) {
    if (instance.family === "spatial_3d_scene" && instance.type === "count_occluded") {
      return [
        inlineCameraResetButton(),
        document.createTextNode(
          " 기준으로, 더 앞의 객체에 몸체가 일부 가려진 객체 수만 세세요. 모서리 접촉은 제외.",
        ),
      ];
    }
    return [document.createTextNode(workInstructionFor(instance))];
  }

  function inlineCameraResetButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inline-camera-reset";
    button.dataset.cameraReset = "true";
    button.textContent = "초기카메라";
    return button;
  }

  function workInstructionFor(instance) {
    if (instance.family === "spatial_3d_scene") {
      if (instance.type === "frontmost_object") return "가장 앞에 보이는 3D 객체 라벨을 고르세요.";
      if (instance.type === "leftmost_object") return "화면에서 가장 왼쪽에 있는 객체 라벨을 고르세요.";
      if (instance.type === "tallest_object") return "가장 높은 3D 객체 라벨을 고르세요.";
      if (instance.type === "count_color") {
        const color = instance.scene?.queryColor || "요청된 색상";
        return `${color} 객체가 몇 개인지 고르세요.`;
      }
      if (instance.type === "count_occluded") {
        return "초기카메라 기준으로, 더 앞의 객체에 몸체가 일부 가려진 객체 수만 세세요. 모서리 접촉은 제외.";
      }
      if (instance.type === "nearest_to_target") {
        const target = instance.scene?.target || "?";
        return `타겟 ${target}와 가장 가까운 객체 라벨을 고르세요. ${target} 자체는 제외.`;
      }
      return "3D 장면에서 맞는 라벨을 하나 고르세요.";
    }
    if (instance.type === "weakest_field_candidate") {
      return "가장 약한 전기장 후보를 하나 고르세요.";
    }
    if (instance.type === "highest_potential_candidate") {
      return "전위가 가장 높은 후보를 하나 고르세요.";
    }
    if (instance.type === "potential_sign") {
      return "P 지점 전위의 부호를 고르세요.";
    }
    if (instance.type === "force_negative") {
      return "음전하가 처음 밀려날 방향을 고르세요.";
    }
    if (instance.type === "force_positive") {
      return "양전하가 처음 밀려날 방향을 고르세요.";
    }
    return "P 지점의 순 전기장 방향을 고르세요.";
  }

  function renderStats() {
    const counts = statusCounts();
    els.statsGrid.innerHTML = `
      <div><strong>${counts.approved}</strong><span>approved</span></div>
      <div><strong>${counts.rejected}</strong><span>rejected</span></div>
      <div><strong>${counts.pending}</strong><span>pending</span></div>
      <div><strong>${counts.evalPicks}</strong><span>eval picks</span></div>
    `;
    els.queueCountBadge.textContent = `${state.queue.length} items`;
    els.settingsQueueBadge.textContent = `${state.queue.length} items`;
    els.carouselRange.max = Math.max(0, state.queue.length - 1);
    els.carouselRange.value = state.currentIndex;
  }

  function renderThumbs() {
    const start = Math.max(0, state.currentIndex - 12);
    const end = Math.min(state.queue.length, start + 25);
    els.thumbStrip.innerHTML = "";
    for (let i = start; i < end; i += 1) {
      const item = state.queue[i];
      const button = document.createElement("button");
      button.className = `thumb${i === state.currentIndex ? " active" : ""}`;
      button.dataset.status = item.annotation.status || "pending";
      button.innerHTML = `<strong>${i + 1}. ${item.answer}</strong><small>${item.typeLabel}</small>`;
      button.addEventListener("click", () => {
        state.currentIndex = i;
        saveState();
        renderAll();
      });
      els.thumbStrip.appendChild(button);
    }
  }

  function renderAll() {
    ensureCanvasSize();
    const instance = active();
    renderFieldTexture(instance);
    renderScene(instance);
    syncUiFromInstance(instance);
    renderStats();
    renderThumbs();
  }

  function renderReasoningAll() {
    const domain = activeReasoningDomain();
    ensureReasoningQueue(domain.id);
    const queue = activeReasoningQueue();
    const index = activeReasoningIndex();
    reasoningState.indices[domain.id] = index;
    const item = activeReasoningItem();
    els.reasoningBadge.textContent = domain.id.toUpperCase();
    els.reasoningTitle.textContent = domain.title;
    els.reasoningSubtitle.textContent = domain.subtitle;
    els.reasoningInstruction.textContent = item?.instruction || domain.instruction;
    els.reasoningCountBadge.textContent = `${index + 1} / ${queue.length}`;
    els.reasoningStatusBadge.textContent = item?.annotation.status || "pending";
    els.reasoningStatusBadge.dataset.status = item?.annotation.status || "pending";
    renderReasoningScene(domain, item);
    renderReasoningAnswerInput(item);
    els.reasoningRange.max = Math.max(0, queue.length - 1);
    els.reasoningRange.value = index;
    els.reasoningNotesInput.value = item?.annotation.notes || "";
    renderReasoningThumbs(domain);
    if (!els.schemaModal.classList.contains("hidden")) renderSchemaModal();
  }

  function renderReasoningThumbs(domain) {
    const queue = activeReasoningQueue();
    const index = activeReasoningIndex();
    const start = Math.max(0, index - 12);
    const end = Math.min(queue.length, start + 25);
    els.reasoningThumbStrip.innerHTML = "";
    for (let i = start; i < end; i += 1) {
      const item = queue[i];
      const button = document.createElement("button");
      button.className = `thumb${i === index ? " active" : ""}`;
      button.dataset.status = item.annotation.status || "pending";

      const title = document.createElement("strong");
      title.textContent = `${i + 1}. ${item.annotation.humanAnswer || item.answer}`;
      const subtitle = document.createElement("small");
      subtitle.textContent = domain.title;
      button.append(title, subtitle);

      button.addEventListener("click", () => {
        reasoningState.indices[domain.id] = i;
        saveReasoningState();
        renderReasoningAll();
      });
      els.reasoningThumbStrip.appendChild(button);
    }
  }

  function renderReasoningChipList(container, items) {
    container.replaceChildren();
    for (const item of items) {
      const chip = document.createElement("span");
      chip.textContent = item;
      container.appendChild(chip);
    }
  }

  function renderReasoningScene(domain, item) {
    els.reasoningScene.replaceChildren();
    els.reasoningScene.classList.toggle("geom-reasoning-scene", GEOMETRY_REASONING_IDS.has(domain.id));
    if (!item) {
      const empty = document.createElement("div");
      empty.className = "reasoning-prompt";
      empty.textContent = "No draft items yet.";
      els.reasoningScene.appendChild(empty);
      return;
    }

    const prompt = reasoningPromptElement(item);
    if (GEOMETRY_REASONING_IDS.has(domain.id)) {
      els.reasoningScene.append(
        prompt,
        renderGeometryFigure(domain, item),
        reasoningLegendElement([`rule: ${item.scene.rule}`, `domain: ${domain.id.toUpperCase()}`, "picture judgment"]),
      );
      return;
    }

    const tiles = document.createElement("div");
    tiles.className = "reasoning-tiles";
    for (const tile of item.scene.tiles) {
      const tileEl = document.createElement("div");
      tileEl.className = "reasoning-tile";
      tileEl.style.borderColor = reasoningHue(tile.hue);
      if (tile.active) tileEl.style.boxShadow = `inset 0 -8px 0 ${reasoningHue(tile.hue)}`;
      const label = document.createElement("mark");
      label.textContent = tile.label;
      const value = document.createElement("strong");
      value.textContent = `${tile.hue} ${tile.value}`;
      const marker = document.createElement("small");
      marker.textContent = tile.marker;
      tileEl.append(label, value, marker);
      tiles.appendChild(tileEl);
    }

    els.reasoningScene.append(
      prompt,
      tiles,
      reasoningLegendElement([
        `rule: ${item.scene.rule}`,
        `target: ${item.scene.target}`,
        ...(item.scene.sql?.candidates || []).slice(0, 4),
      ]),
    );
  }

  function reasoningPromptElement(item) {
    const prompt = document.createElement("div");
    prompt.className = "reasoning-prompt";
    const promptText = document.createElement("strong");
    promptText.textContent = item.prompt;
    const target = document.createElement("span");
    target.textContent = `target ${item.scene.target}`;
    prompt.append(promptText, target);
    return prompt;
  }

  function reasoningLegendElement(items) {
    const legend = document.createElement("div");
    legend.className = "reasoning-legend";
    for (const text of items) {
      const chip = document.createElement("span");
      chip.textContent = text;
      legend.appendChild(chip);
    }
    return legend;
  }

  function renderGeometryFigure(domain, item) {
    const figure = document.createElement("div");
    figure.className = `geom-figure geom-${domain.id}`;
    const svgRoot = svg("svg", {
      class: "geom-svg",
      viewBox: "0 0 760 420",
      role: "img",
      "aria-label": `${domain.title} visual problem`,
    });
    if (domain.id === "bi") drawBilliardsSvg(svgRoot, item);
    else if (domain.id === "mp") drawMirrorPatternSvg(svgRoot, item);
    else if (domain.id === "cc") drawCubeCountSvg(svgRoot, item);
    else if (domain.id === "mc") drawMirrorClockSvg(svgRoot, item);
    else if (domain.id === "ov") drawOverlapSvg(svgRoot, item);
    figure.appendChild(svgRoot);
    return figure;
  }

  function drawBilliardsSvg(root, item) {
    const scene = item.scene?.billiards;
    root.append(
      svg("rect", { x: 34, y: 34, width: 692, height: 338, rx: 20, fill: "#116b4f" }),
      svg("rect", { x: 58, y: 58, width: 644, height: 290, rx: 14, fill: "#1b8a63", stroke: "#0d4735", "stroke-width": 8 }),
    );
    for (const [x, y] of [
      [60, 60],
      [380, 54],
      [700, 60],
      [60, 348],
      [380, 354],
      [700, 348],
    ]) {
      root.appendChild(svg("circle", { cx: x, cy: y, r: 15, fill: "#172128" }));
    }
    if (!scene) return;
    for (const path of scene.paths) {
      root.appendChild(
        svg("polyline", {
          points: path.points.map((point) => `${point.x},${point.y}`).join(" "),
          fill: "none",
          stroke: path.color,
          "stroke-width": path.label === "Path A" ? 6 : 5,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "stroke-dasharray": path.label === "Path B" ? "12 8" : "",
        }),
      );
      const end = path.points[path.points.length - 1];
      root.appendChild(svgText(end.x - 38, end.y + 52, path.label, "geom-path-label"));
    }
    root.appendChild(
      svg("line", {
        x1: scene.cue.x,
        y1: scene.cue.y,
        x2: scene.bank.x,
        y2: scene.bank.y,
        stroke: "#ffffff",
        "stroke-width": 4,
        "stroke-dasharray": "10 8",
      }),
    );
    root.append(labeledBall(scene.cue.x, scene.cue.y, "#f8fbfc", "cue"));
    for (const ball of scene.balls) root.appendChild(labeledBall(ball.x, ball.y, ball.color, ball.label));
    root.append(
      svg("circle", { cx: scene.bank.x, cy: scene.bank.y, r: 9, fill: "#ffffff", stroke: "#172128", "stroke-width": 3 }),
      svgText(scene.bank.x + 14, scene.bank.y + 4, "bank", "geom-small-label"),
      svgText(92, 402, "Use the cue line, wall rebound, blockers, and labeled balls.", "geom-caption"),
    );
  }

  function drawMirrorPatternSvg(root, item) {
    const scene = item.scene?.mirrorPattern;
    if (!scene) return;
    const originX = 116;
    const originY = 30;
    const cellW = 66;
    const cellH = 42;
    const width = scene.cols * cellW;
    const height = scene.rows * cellH;
    const centerFor = (col, row) => ({ x: originX + col * cellW + cellW / 2, y: originY + row * cellH + cellH / 2 });
    root.appendChild(svg("rect", { x: originX, y: originY, width, height, rx: 12, fill: "#ffffff", stroke: "#b8c7cf", "stroke-width": 2 }));
    for (let col = 0; col <= scene.cols; col += 1) {
      const x = originX + col * cellW;
      root.appendChild(svg("line", { x1: x, y1: originY, x2: x, y2: originY + height, stroke: "#dfe8ec", "stroke-width": 2 }));
    }
    for (let row = 0; row <= scene.rows; row += 1) {
      const y = originY + row * cellH;
      root.appendChild(svg("line", { x1: originX, y1: y, x2: originX + width, y2: y, stroke: "#dfe8ec", "stroke-width": 2 }));
    }
    if (scene.axis === "horizontal") {
      const axisY = originY + (scene.rows / 2) * cellH;
      root.append(
        svg("line", { x1: originX - 8, y1: axisY, x2: originX + width + 8, y2: axisY, stroke: "#172128", "stroke-width": 5, "stroke-dasharray": "10 8" }),
        svgText(originX + width - 112, axisY - 12, "mirror axis", "geom-axis-label"),
      );
    } else {
      const axisX = originX + (scene.cols / 2) * cellW;
      root.append(
        svg("line", { x1: axisX, y1: originY - 8, x2: axisX, y2: originY + height + 8, stroke: "#172128", "stroke-width": 5, "stroke-dasharray": "10 8" }),
        svgText(axisX + 12, originY + 28, "mirror axis", "geom-axis-label"),
      );
    }
    for (const mark of [...scene.marks, ...scene.mirroredMarks]) {
      const center = centerFor(mark.col, mark.row);
      root.appendChild(patternMark(mark.shape, center.x, center.y, mark.color, mark.label));
    }
    const missingCenter = centerFor(scene.missing.col, scene.missing.row);
    root.append(
      svg("rect", {
        x: missingCenter.x - 28,
        y: missingCenter.y - 28,
        width: 56,
        height: 56,
        rx: 8,
        fill: "none",
        stroke: "#d438e0",
        "stroke-width": 4,
        "stroke-dasharray": "8 6",
      }),
      svgText(missingCenter.x - 8, missingCenter.y + 7, "?", "geom-question-label"),
    );
    for (const [optionIndex, option] of scene.tileOptions.entries()) {
      const x = 204 + optionIndex * 118;
      root.append(
        svg("rect", { x: x - 46, y: 310, width: 92, height: 74, rx: 8, fill: "#fff", stroke: "#b8c7cf", "stroke-width": 2 }),
        patternMark(option.shape, x, 338, option.color, option.label.replace("Tile ", "")),
        svgText(x - 28, 374, option.label, "geom-axis-label"),
      );
    }
    root.appendChild(svgText(104, 404, "Choose the tile that fills the dashed missing cell, or No match.", "geom-caption"));
  }

  function drawCubeCountSvg(root, item) {
    const scene = item.scene?.cubeCount;
    if (!scene) return;
    const baseX = 284;
    const baseY = 256;
    const size = 34;
    root.append(
      svg("rect", { x: 80, y: 44, width: 600, height: 320, rx: 18, fill: "#f8fbfc", stroke: "#d7e0e5", "stroke-width": 2 }),
      svgText(
        108,
        82,
        `Task: ${
          scene.task === "total"
            ? "total cubes"
            : scene.task === "hidden"
              ? "hidden support cubes"
              : scene.task === "layers"
                ? "stack layers"
                : `${cubeColorName(scene.queryColor)} cubes only`
        }`,
        "geom-caption",
      ),
    );
    const cubes = [];
    for (const column of scene.columns) {
      for (let level = 0; level < column.height; level += 1) {
        cubes.push({ ...column, level });
      }
    }
    cubes.sort((a, b) => a.x + a.z + a.level * 0.02 - (b.x + b.z + b.level * 0.02));
    for (const cube of cubes) {
      addIsoCube(
        root,
        baseX + (cube.x - cube.z) * size,
        baseY + (cube.x + cube.z) * size * 0.36 - cube.level * size * 0.92,
        size,
        cube.color,
      );
    }
    if (scene.task === "hidden") {
      root.append(
        svg("path", { d: "M488 244 l68 23 l-68 26 l-68 -26 z", fill: "rgba(227,67,59,0.13)", stroke: "#e3433b", "stroke-width": 3, "stroke-dasharray": "8 6" }),
        svgText(552, 264, "implied support", "geom-axis-label"),
      );
    } else if (scene.task === "color") {
      root.append(
        svg("rect", { x: 520, y: 92, width: 42, height: 28, rx: 6, fill: scene.queryColor, stroke: "#172128", "stroke-width": 2 }),
        svgText(574, 112, "count this color", "geom-axis-label"),
      );
    }
    root.append(
      svgText(120, 396, "Use the 4x3 footprint, stacked height cues, and color rule.", "geom-caption"),
    );
  }

  function drawMirrorClockSvg(root, item) {
    const scene = item.scene?.mirrorClock;
    if (!scene) return;
    root.append(
      svg("rect", { x: 72, y: 48, width: 616, height: 300, rx: 18, fill: "#ffffff", stroke: "#d7e0e5", "stroke-width": 2 }),
      svg("line", { x1: 380, y1: 60, x2: 380, y2: 336, stroke: "#172128", "stroke-width": 5, "stroke-dasharray": "12 8" }),
      svgText(394, 86, "mirror", "geom-axis-label"),
    );
    drawClock(root, 238, 200, 98, scene.shownAngles.hour, scene.shownAngles.minute, "seen in mirror");
    root.append(
      svg("rect", { x: 478, y: 116, width: 166, height: 188, rx: 16, fill: "#f8fbfc", stroke: "#b8c7cf", "stroke-width": 2 }),
      svgText(512, 146, "actual choices", "geom-axis-label"),
    );
    for (const [optionIndex, option] of item.answerOptions.slice(0, 4).entries()) {
      const y = 178 + optionIndex * 34;
      root.append(
        svg("rect", { x: 498, y: y - 23, width: 126, height: 28, rx: 8, fill: "#edf5f7", stroke: "#b8c7cf", "stroke-width": 2 }),
        svgText(520, y - 2, option.label, "geom-axis-label"),
      );
    }
    root.append(
      svg("path", { d: "M348 198 l-34 -20 m34 20 l-34 20", fill: "none", stroke: "#65737c", "stroke-width": 5, "stroke-linecap": "round" }),
      svgText(122, 390, "Choose the real time matching the reflected clock.", "geom-caption"),
    );
  }

  function drawOverlapSvg(root, item) {
    const scene = item.scene?.overlap;
    if (!scene) return;
    root.append(svg("rect", { x: 76, y: 46, width: 608, height: 310, rx: 18, fill: "#f8fbfc", stroke: "#d7e0e5", "stroke-width": 2 }));
    for (const shape of scene.shapes.slice().sort((a, b) => a.layer - b.layer)) {
      root.appendChild(overlapShapeElement(shape));
    }
    for (const shape of scene.shapes) {
      const center = shapeCenter(shape);
      root.appendChild(svgText(center.x - 8, center.y + 6, shape.label, "geom-object-label"));
    }
    root.append(
      svg("circle", { cx: scene.markedPoint.x, cy: scene.markedPoint.y, r: 13, fill: "#fff", stroke: "#172128", "stroke-width": 4 }),
      svg("line", { x1: scene.markedPoint.x, y1: scene.markedPoint.y, x2: scene.markedPoint.x, y2: 88, stroke: "#172128", "stroke-width": 3, "stroke-dasharray": "7 6" }),
      svgText(scene.markedPoint.x - 54, 82, "white dot: judge here", "geom-axis-label"),
      svgText(104, 334, "White dot only. Count task: covered objects once.", "geom-caption"),
    );
  }

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children) node.appendChild(child);
    return node;
  }

  function svgText(x, y, text, className) {
    const node = svg("text", { x, y, class: className });
    node.textContent = text;
    return node;
  }

  function labeledBall(cx, cy, color, label) {
    return svg(
      "g",
      {},
      svg("circle", { cx, cy, r: 22, fill: color, stroke: "#172128", "stroke-width": 3 }),
      svgText(cx - 11, cy + 5, label, "geom-ball-label"),
    );
  }

  function patternMark(kind, cx, cy, color, label) {
    const shape =
      kind === "rect"
        ? svg("rect", { x: cx - 24, y: cy - 24, width: 48, height: 48, rx: 8, fill: color })
        : kind === "diamond"
          ? svg("polygon", { points: `${cx},${cy - 30} ${cx + 30},${cy} ${cx},${cy + 30} ${cx - 30},${cy}`, fill: color })
          : svg("circle", { cx, cy, r: 25, fill: color });
    return svg("g", {}, shape, svgText(cx - 5, cy + 6, label, "geom-shape-label"));
  }

  function overlapShapeElement(shape) {
    if (shape.kind === "circle") {
      return svg("circle", {
        cx: shape.x,
        cy: shape.y,
        r: shape.r,
        fill: shape.color,
        "fill-opacity": 0.82,
        stroke: shadeColor(shape.color, -56),
        "stroke-width": 4,
      });
    }
    if (shape.kind === "rect") {
      return svg("rect", {
        x: shape.x,
        y: shape.y,
        width: shape.w,
        height: shape.h,
        rx: 18,
        fill: shape.color,
        "fill-opacity": 0.82,
        stroke: shadeColor(shape.color, -56),
        "stroke-width": 4,
      });
    }
    return svg("polygon", {
      points: `${shape.x},${shape.y - shape.h / 2} ${shape.x + shape.w / 2},${shape.y} ${shape.x},${shape.y + shape.h / 2} ${shape.x - shape.w / 2},${shape.y}`,
      fill: shape.color,
      "fill-opacity": 0.82,
      stroke: shadeColor(shape.color, -56),
      "stroke-width": 4,
    });
  }

  function shapeCenter(shape) {
    if (shape.kind === "rect") return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
    return { x: shape.x, y: shape.y };
  }

  function addIsoCube(root, x, y, size, color) {
    const top = `${x},${y} ${x + size},${y - size * 0.34} ${x + size * 2},${y} ${x + size},${y + size * 0.34}`;
    const left = `${x},${y} ${x + size},${y + size * 0.34} ${x + size},${y + size * 1.22} ${x},${y + size * 0.86}`;
    const right = `${x + size * 2},${y} ${x + size},${y + size * 0.34} ${x + size},${y + size * 1.22} ${x + size * 2},${y + size * 0.86}`;
    root.append(
      svg("polygon", { points: top, fill: color, stroke: "#ffffff", "stroke-width": 2 }),
      svg("polygon", { points: left, fill: shadeColor(color, -24), stroke: "#ffffff", "stroke-width": 2 }),
      svg("polygon", { points: right, fill: shadeColor(color, -42), stroke: "#ffffff", "stroke-width": 2 }),
    );
  }

  function drawClock(root, cx, cy, r, hourAngle, minuteAngle, label) {
    root.append(svg("circle", { cx, cy, r, fill: "#f8fbfc", stroke: "#172128", "stroke-width": 5 }));
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * (r - 12);
      const y1 = cy + Math.sin(angle) * (r - 12);
      const x2 = cx + Math.cos(angle) * (r - 4);
      const y2 = cy + Math.sin(angle) * (r - 4);
      root.appendChild(svg("line", { x1, y1, x2, y2, stroke: "#172128", "stroke-width": i % 3 === 0 ? 4 : 2 }));
    }
    addClockHand(root, cx, cy, r * 0.5, hourAngle, "#e3433b", 7);
    addClockHand(root, cx, cy, r * 0.78, minuteAngle, "#246df0", 5);
    root.append(svg("circle", { cx, cy, r: 7, fill: "#172128" }), svgText(cx - 48, cy + r + 34, label, "geom-caption"));
  }

  function addClockHand(root, cx, cy, length, degrees, color, width) {
    const angle = (degrees - 90) * (Math.PI / 180);
    root.appendChild(
      svg("line", {
        x1: cx,
        y1: cy,
        x2: cx + Math.cos(angle) * length,
        y2: cy + Math.sin(angle) * length,
        stroke: color,
        "stroke-width": width,
        "stroke-linecap": "round",
      }),
    );
  }

  function shadeColor(color, delta) {
    const hex = color.replace("#", "");
    const parts = [0, 2, 4].map((start) => Core.clamp(parseInt(hex.slice(start, start + 2), 16) + delta, 0, 255));
    return `rgb(${parts.join(",")})`;
  }

  function reasoningHue(hue) {
    const colors = {
      red: "#e3433b",
      blue: "#246df0",
      green: "#10a052",
      yellow: "#f0bf18",
      cyan: "#11a5bf",
      magenta: "#d438e0",
      orange: "#f07124",
      black: "#172128",
    };
    return colors[hue] || "#637680";
  }

  function renderReasoningAnswerInput(item) {
    els.reasoningAnswerSelect.innerHTML = "";
    if (!item) return;
    for (const option of item.answerOptions) {
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = option.label;
      els.reasoningAnswerSelect.appendChild(optionEl);
    }
    els.reasoningAnswerSelect.value = item.annotation.humanAnswer || item.answer;
  }

  function showSchemaModal() {
    renderSchemaModal();
    els.schemaModal.classList.remove("hidden");
    els.reasoningNotesInput.focus();
  }

  function hideSchemaModal() {
    els.schemaModal.classList.add("hidden");
    els.reasoningSchemaBtn.focus();
  }

  function renderSchemaModal() {
    const domain = activeReasoningDomain();
    const item = activeReasoningItem();
    els.schemaTitle.textContent = `${domain.id.toUpperCase()} Label Schema`;
    els.reasoningNotesInput.value = item?.annotation.notes || "";
    els.schemaMeta.replaceChildren();
    for (const group of [
      ["difficulty", domain.difficulty],
      ["goal", domain.goal],
      ...domain.levers.map((lever) => ["lever", lever]),
      ...domain.schema.map((field) => ["field", field]),
    ]) {
      const chip = document.createElement("span");
      chip.textContent = `${group[0]}: ${group[1]}`;
      els.schemaMeta.appendChild(chip);
    }
  }

  function markMobileOs() {
    const ua = navigator.userAgent || "";
    const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || touchMac;
    document.body.classList.toggle("mobile-os", mobile);
  }

  function updateAnnotation(mutator, advance = false) {
    const instance = active();
    if (!instance) return;
    mutator(instance.annotation, instance);
    instance.annotation.reviewedAt = new Date().toISOString();
    saveState();
    if (advance) move(1);
    else renderAll();
  }

  function move(delta) {
    if (!state.queue.length) return;
    state.currentIndex = Core.clamp(state.currentIndex + delta, 0, state.queue.length - 1);
    saveState();
    renderAll();
  }

  function updateReasoningAnnotation(mutator, advance = false) {
    const item = activeReasoningItem();
    if (!item) return;
    mutator(item.annotation, item);
    item.annotation.reviewedAt = new Date().toISOString();
    saveReasoningState();
    if (advance) moveReasoning(1);
    else renderReasoningAll();
  }

  function submitReasoningAnswer() {
    updateReasoningAnnotation((annotation, item) => {
      annotation.humanAnswer = els.reasoningAnswerSelect.value;
      annotation.status = annotation.humanAnswer === item.answer ? "approved" : "fixed";
    }, true);
  }

  function moveReasoning(delta) {
    const queue = activeReasoningQueue();
    if (!queue.length) return;
    reasoningState.indices[activeReasoningId] = Core.clamp(activeReasoningIndex() + delta, 0, queue.length - 1);
    saveReasoningState();
    renderReasoningAll();
  }

  function exportJsonl() {
    const lines = state.queue.map((instance) => JSON.stringify(toExportRecord(instance))).join("\n");
    downloadBlob(lines + (lines ? "\n" : ""), "spatial-foundry-dataset.jsonl", "application/jsonl");
  }

  function exportReasoningJsonl() {
    const domain = activeReasoningDomain();
    const lines = activeReasoningQueue()
      .map((item) => JSON.stringify(toReasoningExportRecord(domain, item)))
      .join("\n");
    downloadBlob(lines + (lines ? "\n" : ""), `${domain.id}-reasoning-drafts.jsonl`, "application/jsonl");
  }

  function toReasoningExportRecord(domain, item) {
    return {
      id: item.id,
      generator_version: item.generatorVersion || REASONING_GENERATOR_VERSION,
      family: "reasoning_scaffold",
      domain: domain.id,
      domain_title: domain.title,
      task: item.task,
      prompt: item.prompt,
      instruction: item.instruction,
      answer: item.annotation.humanAnswer || item.answer,
      auto_answer: item.answer,
      answer_options: item.answerOptions,
      scene: item.scene,
      solver: item.solver,
      domain_spec: {
        goal: domain.goal,
        difficulty: domain.difficulty,
        levers: domain.levers,
        schema: domain.schema,
      },
      annotation: item.annotation,
      createdAt: item.createdAt,
    };
  }

  function extractApprovedJsonl() {
    const approved = state.queue.filter((instance) =>
      ["approved", "fixed"].includes(instance.annotation.status),
    );
    const lines = approved.map((instance) => JSON.stringify(toExportRecord(instance))).join("\n");
    downloadBlob(lines + (lines ? "\n" : ""), "spatial-foundry-approved.jsonl", "application/jsonl");
  }

  function toExportRecord(instance) {
    return {
      id: instance.id,
      family: instance.family,
      type: instance.type,
      prompt: instance.prompt,
      answer: instance.annotation.humanAnswer || instance.answer,
      auto_answer: instance.answer,
      answer_options: instance.answerOptions,
      seed: instance.seed,
      parameters: instance.parameters,
      charges: instance.charges,
      probe: instance.probe,
      candidates: instance.candidates,
      objects: instance.objects,
      scene: instance.scene,
      solver: instance.solver,
      metrics: instance.metrics,
      annotation: instance.annotation,
    };
  }

  function exportPng() {
    const instance = active();
    if (!instance) return;
    const merged = document.createElement("canvas");
    merged.width = els.sceneCanvas.width;
    merged.height = els.sceneCanvas.height;
    const ctx = merged.getContext("2d");
    ctx.drawImage(els.fieldCanvas, 0, 0);
    ctx.drawImage(els.sceneCanvas, 0, 0);
    merged.toBlob((blob) => {
      downloadBlob(blob, `${instance.id}.png`, "image/png");
    });
  }

  function downloadBlob(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importJsonlFile(file) {
    if (!file) return;
    const text = await file.text();
    const records = parseImportText(text);
    const imported = records
      .map((record, index) => normalizeImportedRecord(record, state.queue.length + index))
      .filter(Boolean);
    state.queue.push(...imported);
    if (imported.length) {
      state.currentIndex = state.queue.length - imported.length;
    }
    saveState();
    renderAll();
    els.importJsonlInput.value = "";
  }

  function parseImportText(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    }
    return trimmed
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function normalizeImportedRecord(record, fallbackIndex) {
    if (!record || !["electric_charge_field", "spatial_3d_scene"].includes(record.family)) return null;
    if (record.family === "spatial_3d_scene") return normalizeImported3DRecord(record, fallbackIndex);
    const type = record.type || "field_direction";
    const answerOptions = record.answerOptions || record.answer_options || [];
    const answer = record.auto_answer || record.answer;
    const annotation = record.annotation || {};
    return {
      id: record.id || `${type}_imported_${fallbackIndex}`,
      family: "electric_charge_field",
      type,
      typeLabel: Core.TYPE_LABELS[type] || type,
      seed: record.seed || record.parameters?.seed || "imported",
      index: Number(record.index ?? fallbackIndex),
      prompt: record.prompt || "Imported electric charge field instance.",
      answer,
      answerOptions,
      charges: record.charges || [],
      probe: record.probe || { x: 0, y: 0 },
      candidates: record.candidates || [],
      solver: record.solver || {
        fieldAtProbe: Core.computeFieldAt(record.probe || { x: 0, y: 0 }, record.charges || []),
        candidates: [],
        trace: "Imported without solver trace.",
      },
      parameters: record.parameters || {
        seed: record.seed || "imported",
        difficulty: 7,
        chargeCount: record.charges?.length || 0,
        candidateCount: record.candidates?.length || 0,
        gridExtent: 6,
        problemType: type,
        nearCancellation: true,
        symmetryTraps: true,
        hardDistractors: true,
      },
      metrics: record.metrics || {
        visualComplexity: 3,
        spatialComplexity: 3,
        cancellationIndex: 0,
        dominanceRatio: 0,
        answerConfidence: 0.5,
        candidateGap: null,
        positiveCharges: (record.charges || []).filter((charge) => charge.q > 0).length,
        negativeCharges: (record.charges || []).filter((charge) => charge.q < 0).length,
        netCharge: (record.charges || []).reduce((sum, charge) => sum + charge.q, 0),
      },
      annotation: {
        status: annotation.status || "pending",
        split: annotation.split || "train",
        humanAnswer: annotation.humanAnswer || record.answer || answer,
        flags: Array.isArray(annotation.flags) ? annotation.flags : [],
        labels: {
          visualClarity: annotation.labels?.visualClarity ?? 4,
          mathDepth: annotation.labels?.mathDepth ?? 4,
          ambiguityRisk: annotation.labels?.ambiguityRisk ?? 2,
          novelty: annotation.labels?.novelty ?? 3,
          pedagogicalValue: annotation.labels?.pedagogicalValue ?? 4,
        },
        notes: annotation.notes || "",
        reviewedAt: annotation.reviewedAt || null,
      },
      createdAt: record.createdAt || new Date().toISOString(),
    };
  }

  function normalizeImported3DRecord(record, fallbackIndex) {
    const type = record.type || "frontmost_object";
    const answerOptions =
      record.answerOptions ||
      record.answer_options ||
      (record.objects || []).map((object) => ({
        value: object.label,
        label: `${object.label} (${object.colorLabel || object.color || "object"})`,
      }));
    const answer = record.auto_answer || record.answer;
    const annotation = record.annotation || {};
    return {
      id: record.id || `${type}_imported_${fallbackIndex}`,
      family: "spatial_3d_scene",
      type,
      typeLabel: Core.SPATIAL_3D_TYPE_LABELS[type] || type,
      seed: record.seed || record.parameters?.seed || "imported",
      index: Number(record.index ?? fallbackIndex),
      prompt: record.prompt || "Imported 3D spatial labeling instance.",
      answer,
      answerOptions,
      objects: record.objects || [],
      scene: record.scene || { camera: "isometric_webgpu" },
      solver: record.solver || { trace: "Imported without solver trace." },
      parameters: record.parameters || {
        seed: record.seed || "imported",
        family: "spatial_3d_scene",
        difficulty: 7,
        chargeCount: record.objects?.length || 0,
        objectCount: record.objects?.length || 0,
        candidateCount: 4,
        gridExtent: 6,
        problemType: type,
      },
      metrics: record.metrics || {
        visualComplexity: 3,
        spatialComplexity: 3,
        occludedCount: (record.objects || []).filter((object) => object.occluded).length,
        objectCount: record.objects?.length || 0,
        answerConfidence: 0.5,
      },
      annotation: {
        status: annotation.status || "pending",
        split: annotation.split || "train",
        humanAnswer: annotation.humanAnswer || record.answer || answer,
        flags: Array.isArray(annotation.flags) ? annotation.flags : [],
        labels: {
          visualClarity: annotation.labels?.visualClarity ?? 4,
          mathDepth: annotation.labels?.mathDepth ?? 4,
          ambiguityRisk: annotation.labels?.ambiguityRisk ?? 2,
          novelty: annotation.labels?.novelty ?? 4,
          pedagogicalValue: annotation.labels?.pedagogicalValue ?? 4,
        },
        notes: annotation.notes || "",
        reviewedAt: annotation.reviewedAt || null,
      },
      createdAt: record.createdAt || new Date().toISOString(),
    };
  }

  function clearReviewed() {
    state.queue = state.queue.filter((item) => item.annotation.status === "pending");
    state.currentIndex = Core.clamp(state.currentIndex, 0, Math.max(state.queue.length - 1, 0));
    saveState();
    renderAll();
  }

  function submitMainAnswer() {
    updateAnnotation((annotation, instance) => {
      annotation.humanAnswer = els.humanAnswerSelect.value;
      annotation.status = annotation.humanAnswer === instance.answer ? "approved" : "fixed";
    }, true);
  }

  function currentRoute() {
    const raw = (location.hash || "#tree").replace(/^#/, "").toLowerCase();
    if (!raw || raw === "tree") return { kind: "tree", hash: "#tree" };
    if (raw === "belt" || raw === "saf" || raw === "saf/belt") {
      return { kind: "saf", safView: "belt", hash: "#saf" };
    }
    if (raw === "settings" || raw === "saf/settings") {
      return { kind: "saf", safView: "settings", hash: "#saf/settings" };
    }
    const domain = REASONING_DOMAINS.find((item) => item.id === raw);
    if (domain) return { kind: "reasoning", domainId: domain.id, hash: `#${domain.id}` };
    return { kind: "tree", hash: "#tree" };
  }

  function applyRoute() {
    const route = currentRoute();
    if (location.hash !== route.hash) {
      history.replaceState(null, "", route.hash);
    }
    const showTree = route.kind === "tree";
    const showSaf = route.kind === "saf";
    const showReasoning = route.kind === "reasoning";
    els.treeDomain.classList.toggle("hidden", !showTree);
    els.safLocalNav.classList.add("hidden");
    els.beltDomain.classList.toggle("hidden", !(showSaf && route.safView === "belt"));
    els.settingsDomain.classList.toggle("hidden", !(showSaf && route.safView === "settings"));
    els.reasoningDomain.classList.toggle("hidden", !showReasoning);
    els.treeNavLink.classList.toggle("active", showTree);

    if (showTree) {
      setAppHeader("RF", "Reasoning Foundry", "TREE domain: choose one working subdomain");
      return;
    }

    if (showSaf) {
      setAppHeader("SAF", "Spatial Annotation Foundry", renderer.statusText);
      els.beltTab.classList.toggle("active", route.safView === "belt");
      els.settingsTab.classList.toggle("active", route.safView === "settings");
      requestAnimationFrame(renderAll);
      return;
    }

    const domain = REASONING_DOMAINS.find((item) => item.id === route.domainId) || REASONING_DOMAINS[0];
    activeReasoningId = domain.id;
    setAppHeader(domain.id.toUpperCase(), domain.title, `${domain.subtitle} · local HITL scaffold`);
    renderReasoningAll();
  }

  function setAppHeader(mark, title, status) {
    els.brandMark.textContent = mark;
    els.appTitle.textContent = title;
    els.rendererStatus.textContent = status;
  }

  function isSafVisible() {
    return !els.beltDomain.classList.contains("hidden") || !els.settingsDomain.classList.contains("hidden");
  }

  function startCameraDrag(event) {
    if (event.button !== 0) return;
    camera.dragging = true;
    camera.lastX = event.clientX;
    camera.lastY = event.clientY;
    els.canvasWrap.classList.add("dragging");
    els.sceneCanvas.setPointerCapture?.(event.pointerId);
  }

  function dragCamera(event) {
    if (!camera.dragging) return;
    const dx = event.clientX - camera.lastX;
    const dy = event.clientY - camera.lastY;
    camera.lastX = event.clientX;
    camera.lastY = event.clientY;
    camera.yaw += dx * 0.009;
    camera.pitch = Core.clamp(camera.pitch + dy * 0.006, 0.25, 1.24);
    renderAll();
  }

  function stopCameraDrag(event) {
    camera.dragging = false;
    els.canvasWrap.classList.remove("dragging");
    if (event?.pointerId !== undefined) {
      els.sceneCanvas.releasePointerCapture?.(event.pointerId);
    }
  }

  function zoomCamera(event) {
    const instance = active();
    if (!instance || instance.family !== "spatial_3d_scene") return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    camera.zoom = Core.clamp(camera.zoom * factor, 0.58, 2.2);
    renderAll();
  }

  function resetCamera() {
    camera.yaw = -0.78;
    camera.pitch = 0.72;
    camera.zoom = 1.03;
    camera.panX = 0;
    camera.panY = -0.04;
    renderAll();
  }

  function bindEvents() {
    els.beltTab.addEventListener("click", () => {
      location.hash = "#saf";
    });
    els.settingsTab.addEventListener("click", () => {
      location.hash = "#saf/settings";
    });
    els.familySelect.addEventListener("change", () => {
      if (els.familySelect.value === "spatial_3d_scene") {
        if (!Core.SPATIAL_3D_TYPES.includes(els.problemTypeSelect.value)) {
          els.problemTypeSelect.value = "mixed";
        }
      } else if (!Core.PROBLEM_TYPES.includes(els.problemTypeSelect.value)) {
        els.problemTypeSelect.value = "mixed";
      }
    });
    els.generateBtn.addEventListener("click", () => regenerateBatch(Number(els.batchCountInput.value)));
    els.cycleBatchBtn.addEventListener("click", exportJsonl);
    els.safNewBtn.addEventListener("click", () => regenerateBatch(100));
    els.resetBatchBtn.addEventListener("click", showResetConfirm);
    els.safSettingsBtn.addEventListener("click", () => {
      location.hash = "#saf/settings";
    });
    els.safBeltBtn.addEventListener("click", () => {
      location.hash = "#saf";
    });
    els.confirmYesBtn.addEventListener("click", runConfirmedAction);
    els.confirmNoBtn.addEventListener("click", hideConfirmDialog);
    els.confirmModal.addEventListener("click", (event) => {
      if (event.target === els.confirmModal) hideConfirmDialog();
    });
    els.schemaCloseBtn.addEventListener("click", hideSchemaModal);
    els.schemaDoneBtn.addEventListener("click", () => {
      updateReasoningAnnotation((annotation) => {
        annotation.notes = els.reasoningNotesInput.value;
      });
      hideSchemaModal();
    });
    els.schemaModal.addEventListener("click", (event) => {
      if (event.target === els.schemaModal) hideSchemaModal();
    });
    els.submitNextBtn.addEventListener("click", submitMainAnswer);
    els.skipBtn.addEventListener("click", () => move(1));
    els.workInstruction.addEventListener("click", (event) => {
      if (event.target.closest("[data-camera-reset]")) resetCamera();
    });
    els.sceneCanvas.addEventListener("pointerdown", startCameraDrag);
    els.sceneCanvas.addEventListener("pointermove", dragCamera);
    els.sceneCanvas.addEventListener("pointerup", stopCameraDrag);
    els.sceneCanvas.addEventListener("pointercancel", stopCameraDrag);
    els.sceneCanvas.addEventListener("wheel", zoomCamera, { passive: false });
    els.sceneCanvas.addEventListener("dblclick", resetCamera);
    els.prevBtn.addEventListener("click", () => move(-1));
    els.nextBtn.addEventListener("click", () => move(1));
    els.reasoningSubmitNextBtn.addEventListener("click", submitReasoningAnswer);
    els.reasoningSkipBtn.addEventListener("click", () => moveReasoning(1));
    els.reasoningPrevBtn.addEventListener("click", () => moveReasoning(-1));
    els.reasoningNextBtn.addEventListener("click", () => moveReasoning(1));
    els.reasoningRange.addEventListener("input", () => {
      reasoningState.indices[activeReasoningId] = Number(els.reasoningRange.value);
      saveReasoningState();
      renderReasoningAll();
    });
    els.reasoningExportBtn.addEventListener("click", exportReasoningJsonl);
    els.reasoningNewBtn.addEventListener("click", () => {
      regenerateReasoningQueue(activeReasoningId, 100);
      renderReasoningAll();
    });
    els.reasoningSchemaBtn.addEventListener("click", showSchemaModal);
    els.randomSeedBtn.addEventListener("click", () => {
      els.seedInput.value = `seed-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
    });
    els.difficultyRange.addEventListener("input", () => {
      els.difficultyOut.textContent = els.difficultyRange.value;
    });
    els.carouselRange.addEventListener("input", () => {
      state.currentIndex = Number(els.carouselRange.value);
      saveState();
      renderAll();
    });
    els.overlayBtn.addEventListener("click", () => {
      overlay = !overlay;
      els.overlayBtn.textContent = overlay ? "Puzzle Image" : "Solver Overlay";
      renderAll();
    });
    els.exportJsonlBtn.addEventListener("click", exportJsonl);
    els.extractApprovedBtn.addEventListener("click", extractApprovedJsonl);
    els.exportPngBtn.addEventListener("click", exportPng);
    els.importJsonlInput.addEventListener("change", () => {
      importJsonlFile(els.importJsonlInput.files[0]).catch((error) => {
        console.error(error);
        els.importJsonlInput.value = "";
      });
    });
    els.clearReviewedBtn.addEventListener("click", clearReviewed);

    for (const button of document.querySelectorAll("[data-status]")) {
      button.addEventListener("click", () => {
        updateAnnotation((annotation) => {
          annotation.status = button.dataset.status;
          annotation.humanAnswer = els.humanAnswerSelect.value;
        }, true);
      });
    }

    for (const button of document.querySelectorAll("[data-rf-status]")) {
      button.addEventListener("click", () => {
        updateReasoningAnnotation((annotation) => {
          annotation.status = button.dataset.rfStatus;
          annotation.humanAnswer = els.reasoningAnswerSelect.value;
        }, true);
      });
    }

    els.flagGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-flag]");
      if (!button) return;
      updateAnnotation((annotation) => {
        const flag = button.dataset.flag;
        const index = annotation.flags.indexOf(flag);
        if (index >= 0) annotation.flags.splice(index, 1);
        else annotation.flags.push(flag);
      });
    });

    els.splitSelect.addEventListener("change", () => {
      updateAnnotation((annotation) => {
        annotation.split = els.splitSelect.value;
      });
    });

    els.humanAnswerSelect.addEventListener("change", () => {
      updateAnnotation((annotation) => {
        annotation.humanAnswer = els.humanAnswerSelect.value;
        if (annotation.humanAnswer !== active().answer && annotation.status === "pending") {
          annotation.status = "fixed";
        }
      });
    });

    els.reasoningAnswerSelect.addEventListener("change", () => {
      updateReasoningAnnotation((annotation, item) => {
        annotation.humanAnswer = els.reasoningAnswerSelect.value;
        if (annotation.humanAnswer !== item.answer && annotation.status === "pending") {
          annotation.status = "fixed";
        }
      });
    });

    els.notesInput.addEventListener("change", () => {
      updateAnnotation((annotation) => {
        annotation.notes = els.notesInput.value;
      });
    });

    els.reasoningNotesInput.addEventListener("change", () => {
      updateReasoningAnnotation((annotation) => {
        annotation.notes = els.reasoningNotesInput.value;
      });
    });

    for (const input of document.querySelectorAll("[data-label]")) {
      input.addEventListener("input", () => {
        updateAnnotation((annotation) => {
          annotation.labels[input.dataset.label] = Number(input.value);
        });
      });
    }

    window.addEventListener("resize", () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (isSafVisible()) renderAll();
        else if (!els.reasoningDomain.classList.contains("hidden")) renderReasoningAll();
      });
    });

    window.addEventListener("hashchange", () => {
      applyRoute();
    });

    window.addEventListener("keydown", (event) => {
      if (!els.confirmModal.classList.contains("hidden") && event.key === "Escape") {
        hideConfirmDialog();
        return;
      }
      if (!els.schemaModal.classList.contains("hidden") && event.key === "Escape") {
        hideSchemaModal();
        return;
      }
      if (!els.schemaModal.classList.contains("hidden")) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
      const reasoningVisible = !els.reasoningDomain.classList.contains("hidden");
      if (reasoningVisible) {
        if (event.key === "ArrowRight" || event.key.toLowerCase() === "j") moveReasoning(1);
        if (event.key === "ArrowLeft" || event.key.toLowerCase() === "k") moveReasoning(-1);
        if (event.key.toLowerCase() === "a") submitReasoningAnswer();
        if (event.key.toLowerCase() === "r") {
          updateReasoningAnnotation((annotation) => {
            annotation.status = "rejected";
          }, true);
        }
        if (event.key.toLowerCase() === "f") {
          updateReasoningAnnotation((annotation) => {
            annotation.status = "fixed";
            annotation.humanAnswer = els.reasoningAnswerSelect.value;
          }, true);
        }
        return;
      }
      if (isSafVisible()) {
        if (event.key === "ArrowRight" || event.key.toLowerCase() === "j") move(1);
        if (event.key === "ArrowLeft" || event.key.toLowerCase() === "k") move(-1);
        if (event.key.toLowerCase() === "a") {
          submitMainAnswer();
        }
        if (event.key.toLowerCase() === "r") {
          updateAnnotation((annotation) => {
            annotation.status = "rejected";
          }, true);
        }
        if (event.key.toLowerCase() === "f") {
          updateAnnotation((annotation) => {
            annotation.status = "fixed";
            annotation.humanAnswer = els.humanAnswerSelect.value;
          }, true);
        }
      }
    });
  }

  async function bootstrap() {
    markMobileOs();
    bindEvents();
    els.difficultyOut.textContent = els.difficultyRange.value;
    await initRenderer();
    if (!state.queue.length) {
      generate(Number(els.batchCountInput.value));
    } else {
      renderAll();
    }
    applyRoute();
  }

  bootstrap();
})();
