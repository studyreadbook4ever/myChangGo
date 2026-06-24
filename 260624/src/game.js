const KEY_ORDER = Array.from("qazwsxedcrfvtgbyhnujmikolp");
const GAME_DURATION = 30;
const NOTE_LIFETIME = 3;
const SPAWN_CUTOFF = GAME_DURATION - NOTE_LIFETIME;
const MAX_INSTANCES = 4096;

const KEY_INDEX = new Map(KEY_ORDER.map((key, index) => [key, index]));
const CODE_TO_KEY = {
  KeyQ: "q",
  KeyA: "a",
  KeyZ: "z",
  KeyW: "w",
  KeyS: "s",
  KeyX: "x",
  KeyE: "e",
  KeyD: "d",
  KeyC: "c",
  KeyR: "r",
  KeyF: "f",
  KeyV: "v",
  KeyT: "t",
  KeyG: "g",
  KeyB: "b",
  KeyY: "y",
  KeyH: "h",
  KeyN: "n",
  KeyU: "u",
  KeyJ: "j",
  KeyM: "m",
  KeyI: "i",
  KeyK: "k",
  KeyO: "o",
  KeyL: "l",
  KeyP: "p",
};

const NOTE_COLORS = [
  [0.21, 0.82, 0.72, 1],
  [1.0, 0.42, 0.42, 1],
  [1.0, 0.82, 0.4, 1],
  [0.56, 0.79, 0.9, 1],
  [0.72, 0.96, 0.4, 1],
  [0.94, 0.54, 0.97, 1],
];

const dom = {
  canvas: document.querySelector("#gpu-canvas"),
  noteLayer: document.querySelector("#note-layer"),
  menu: document.querySelector("#menu"),
  hud: document.querySelector("#hud"),
  keyStrip: document.querySelector("#key-strip"),
  startButton: document.querySelector("#start-button"),
  status: document.querySelector("#webgpu-status"),
  noteRate: document.querySelector("#note-rate"),
  rateNumber: document.querySelector("#rate-number"),
  rateOutput: document.querySelector("#rate-output"),
  lastResult: document.querySelector("#last-result"),
  score: document.querySelector("#score"),
  combo: document.querySelector("#combo"),
  timer: document.querySelector("#timer"),
  accuracy: document.querySelector("#accuracy"),
  feedback: document.querySelector("#feedback"),
};

const state = {
  phase: "boot",
  ready: false,
  rate: 4,
  notes: [],
  effects: [],
  score: 0,
  combo: 0,
  maxCombo: 0,
  hits: 0,
  misses: 0,
  wrong: 0,
  spawned: 0,
  startedAt: 0,
  elapsed: 0,
  nextSpawnAt: 0,
  lastFeedback: "READY",
  lastSpawned: [],
  nextNoteId: 1,
};

const layout = {
  width: 1,
  height: 1,
  dpr: 1,
  laneWidth: 1,
  topY: 72,
  strikeY: 400,
  noteW: 24,
  noteH: 38,
  noteFont: 20,
};

const keyCells = new Map();
let gpu = null;
let lastFrame = performance.now() / 1000;
let instanceData = new Float32Array(MAX_INSTANCES * 8);
let instanceCount = 0;
let uniformData = new Float32Array(4);

for (const key of KEY_ORDER) {
  const cell = document.createElement("span");
  cell.className = "key-cell";
  cell.textContent = key;
  cell.dataset.key = key;
  dom.keyStrip.append(cell);
  keyCells.set(key, cell);
}

syncRate(4);
resize();
bindEvents();
initWebGPU();
requestAnimationFrame(frame);

function bindEvents() {
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", handleKeyDown, { passive: false });
  dom.startButton.addEventListener("click", startGame);
  dom.noteRate.addEventListener("input", () => syncRate(dom.noteRate.value));
  dom.rateNumber.addEventListener("change", () => syncRate(dom.rateNumber.value));
}

async function initWebGPU() {
  if (!navigator.gpu) {
    dom.status.textContent = "WebGPU를 지원하는 Chrome 또는 Edge 최신 버전이 필요합니다.";
    state.phase = "menu";
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });

    if (!adapter) {
      throw new Error("No WebGPU adapter");
    }

    const device = await adapter.requestDevice();
    const context = dom.canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });

    const vertexBuffer = device.createBuffer({
      size: 6 * 2 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      vertexBuffer,
      0,
      new Float32Array([
        -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
        -0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      ]),
    );

    const instanceBuffer = device.createBuffer({
      size: instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({
      code: `
        struct Uniforms {
          resolution: vec2<f32>,
          time: f32,
          pad: f32,
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) local: vec2<f32>,
          @location(1) center: vec2<f32>,
          @location(2) size: vec2<f32>,
          @location(3) color: vec4<f32>,
        };

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) local: vec2<f32>,
          @location(1) color: vec4<f32>,
        };

        @vertex
        fn vertexMain(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          let world = input.center + input.local * input.size;
          let zeroToOne = world / uniforms.resolution;
          let clip = vec2<f32>(zeroToOne.x * 2.0 - 1.0, 1.0 - zeroToOne.y * 2.0);
          output.position = vec4<f32>(clip, 0.0, 1.0);
          output.local = input.local;
          output.color = input.color;
          return output;
        }

        @fragment
        fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
          let edge = max(abs(input.local.x), abs(input.local.y));
          let soft = 1.0 - smoothstep(0.49, 0.52, edge);
          return vec4<f32>(input.color.rgb, input.color.a * soft);
        }
      `,
    });

    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            arrayStride: 8 * Float32Array.BYTES_PER_ELEMENT,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              {
                shaderLocation: 2,
                offset: 2 * Float32Array.BYTES_PER_ELEMENT,
                format: "float32x2",
              },
              {
                shaderLocation: 3,
                offset: 4 * Float32Array.BYTES_PER_ELEMENT,
                format: "float32x4",
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    device.lost.then((info) => {
      if (info.reason === "destroyed") {
        return;
      }

      state.ready = false;
      dom.startButton.disabled = true;
      dom.status.textContent = `WebGPU 장치가 중단되었습니다: ${info.message || info.reason}`;
    });

    gpu = {
      device,
      context,
      format,
      pipeline,
      bindGroup,
      vertexBuffer,
      instanceBuffer,
      uniformBuffer,
    };

    state.ready = true;
    state.phase = "menu";
    dom.startButton.disabled = false;
    dom.status.textContent = "WebGPU 준비 완료";
    resize();
  } catch (error) {
    console.error(error);
    state.phase = "menu";
    dom.status.textContent = "현재 WebGPU를 이용할 수 없습니다";
  }
}

function resize() {
  const rect = dom.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || window.innerWidth));
  const height = Math.max(1, Math.floor(rect.height || window.innerHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.floor(width * dpr));
  const pixelHeight = Math.max(1, Math.floor(height * dpr));

  if (dom.canvas.width !== pixelWidth || dom.canvas.height !== pixelHeight) {
    dom.canvas.width = pixelWidth;
    dom.canvas.height = pixelHeight;
  }

  if (gpu) {
    gpu.context.configure({
      device: gpu.device,
      format: gpu.format,
      alphaMode: "opaque",
    });
  }

  layout.width = width;
  layout.height = height;
  layout.dpr = dpr;
  layout.laneWidth = width / KEY_ORDER.length;
  layout.topY = height < 620 ? 82 : 92;
  layout.strikeY = height - clamp(height * 0.14, 74, 122);
  layout.noteW = clamp(layout.laneWidth * 0.78, 8, 42);
  layout.noteH = clamp(layout.laneWidth * 1.18, 20, 48);
  layout.noteFont = clamp(layout.laneWidth * 0.42, 8, 22);
}

function frame(nowMs) {
  const now = nowMs / 1000;
  const dt = Math.min(0.08, now - lastFrame);
  lastFrame = now;

  if (state.phase === "playing") {
    updateGame(now, dt);
  }

  render(now);
  requestAnimationFrame(frame);
}

function syncRate(rawValue) {
  const parsed = Number.parseFloat(rawValue);
  const rounded = Math.round(clamp(Number.isFinite(parsed) ? parsed : 4, 1, 14) * 2) / 2;
  state.rate = rounded;
  dom.noteRate.value = String(rounded);
  dom.rateNumber.value = String(rounded);
  dom.rateOutput.value = rounded.toFixed(1);
  dom.rateOutput.textContent = rounded.toFixed(1);
}

function startGame() {
  if (!state.ready || state.phase === "playing") {
    return;
  }

  dom.menu.classList.add("hidden");
  dom.hud.classList.remove("hidden");
  dom.noteLayer.replaceChildren();

  Object.assign(state, {
    phase: "playing",
    notes: [],
    effects: [],
    score: 0,
    combo: 0,
    maxCombo: 0,
    hits: 0,
    misses: 0,
    wrong: 0,
    spawned: 0,
    startedAt: performance.now() / 1000,
    elapsed: 0,
    nextSpawnAt: 0.35,
    lastFeedback: "READY",
    lastSpawned: [],
    nextNoteId: 1,
  });

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  updateHud();
}

function updateGame(now, dt) {
  state.elapsed = now - state.startedAt;

  while (state.elapsed >= state.nextSpawnAt && state.nextSpawnAt <= SPAWN_CUTOFF) {
    spawnNote(state.nextSpawnAt);
    state.nextSpawnAt += 1 / state.rate;
  }

  expireNotes();
  updateEffects(dt);
  updateHud();
  syncNoteLabels();

  if (state.elapsed >= GAME_DURATION) {
    finishGame();
  }
}

function spawnNote(spawnTime) {
  let keyIndex = Math.floor(Math.random() * KEY_ORDER.length);

  for (let attempt = 0; attempt < 7 && state.lastSpawned.includes(keyIndex); attempt += 1) {
    keyIndex = Math.floor(Math.random() * KEY_ORDER.length);
  }

  state.lastSpawned.push(keyIndex);
  if (state.lastSpawned.length > 5) {
    state.lastSpawned.shift();
  }

  const char = KEY_ORDER[keyIndex];
  const note = {
    id: state.nextNoteId,
    keyIndex,
    char,
    spawnTime,
    color: NOTE_COLORS[keyIndex % NOTE_COLORS.length],
    el: document.createElement("span"),
  };

  state.nextNoteId += 1;
  state.spawned += 1;
  note.el.className = "note-label";
  note.el.textContent = char;
  dom.noteLayer.append(note.el);
  state.notes.push(note);
}

function expireNotes() {
  for (let index = state.notes.length - 1; index >= 0; index -= 1) {
    const note = state.notes[index];
    if (state.elapsed - note.spawnTime >= NOTE_LIFETIME) {
      state.misses += 1;
      state.combo = 0;
      state.lastFeedback = "MISS";
      flashKey(note.char, "wrong");
      removeNote(note);
    }
  }
}

function handleKeyDown(event) {
  const key = normalizeKey(event);

  if (state.phase === "menu" && state.ready && (event.code === "Enter" || event.code === "Space")) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLButtonElement)) {
      event.preventDefault();
      startGame();
    }
    return;
  }

  if (state.phase !== "playing" || event.repeat || !KEY_INDEX.has(key)) {
    return;
  }

  event.preventDefault();
  hitKey(key);
}

function normalizeKey(event) {
  if (CODE_TO_KEY[event.code]) {
    return CODE_TO_KEY[event.code];
  }

  if (event.key && event.key.length === 1) {
    return event.key.toLowerCase();
  }

  return "";
}

function hitKey(key) {
  expireNotes();

  const target = state.notes.find((note) => note.char === key);
  if (!target) {
    state.combo = 0;
    state.wrong += 1;
    state.score = Math.max(0, state.score - 30);
    state.lastFeedback = "VOID";
    flashKey(key, "wrong");
    updateHud();
    return;
  }

  const age = clamp(state.elapsed - target.spawnTime, 0, NOTE_LIFETIME);
  const points = scoreForReaction(age);
  state.combo += 1;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.hits += 1;
  state.score += points.value + Math.min(220, state.combo * 4);
  state.lastFeedback = points.label;
  flashKey(key, "hit");
  createHitEffect(target);
  removeNote(target);
  updateHud();
}

function scoreForReaction(age) {
  if (age <= 0.45) {
    return { label: "SNAP", value: 330 };
  }

  if (age <= 1.15) {
    return { label: "FAST", value: 250 };
  }

  if (age <= 2.15) {
    return { label: "GOOD", value: 170 };
  }

  return { label: "LATE", value: 90 };
}

function createHitEffect(note) {
  const { x, y } = notePosition(note);
  const color = note.color;

  for (let index = 0; index < 9; index += 1) {
    const angle = (Math.PI * 2 * index) / 9 + Math.random() * 0.35;
    const speed = 42 + Math.random() * 78;
    state.effects.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 7 + Math.random() * 8,
      life: 0.42 + Math.random() * 0.16,
      age: 0,
      color,
    });
  }
}

function updateEffects(dt) {
  for (const effect of state.effects) {
    effect.age += dt;
    effect.x += effect.vx * dt;
    effect.y += effect.vy * dt;
    effect.vy += 150 * dt;
  }

  state.effects = state.effects.filter((effect) => effect.age < effect.life);
}

function removeNote(note) {
  const index = state.notes.indexOf(note);
  if (index >= 0) {
    state.notes.splice(index, 1);
  }

  note.el.remove();
}

function finishGame() {
  for (const note of [...state.notes]) {
    state.misses += 1;
    removeNote(note);
  }

  const result = {
    score: state.score,
    hits: state.hits,
    misses: state.misses,
    wrong: state.wrong,
    maxCombo: state.maxCombo,
    accuracy: calculateAccuracy(),
    rate: state.rate,
  };

  state.phase = "menu";
  state.effects = [];
  state.elapsed = 0;
  state.combo = 0;
  dom.hud.classList.add("hidden");
  dom.menu.classList.remove("hidden");
  renderResult(result);
}

function renderResult(result) {
  dom.lastResult.innerHTML = `
    <div class="result-tile"><span>점수</span><strong>${result.score}</strong></div>
    <div class="result-tile"><span>정확도</span><strong>${result.accuracy}%</strong></div>
    <div class="result-tile"><span>최대 콤보</span><strong>${result.maxCombo}</strong></div>
  `;
  dom.lastResult.classList.remove("hidden");
  dom.status.textContent = `${result.rate.toFixed(1)} 노트/초 결과`;
}

function updateHud() {
  dom.score.textContent = String(state.score);
  dom.combo.textContent = String(state.combo);
  dom.timer.textContent = Math.max(0, GAME_DURATION - state.elapsed).toFixed(1);
  dom.accuracy.textContent = `${calculateAccuracy()}%`;
  dom.feedback.textContent = state.lastFeedback;
}

function calculateAccuracy() {
  const total = state.hits + state.misses + state.wrong;
  if (total === 0) {
    return 100;
  }
  return Math.round((state.hits / total) * 100);
}

function syncNoteLabels() {
  for (const note of state.notes) {
    const { x, y, progress } = notePosition(note);
    note.el.style.left = `${x}px`;
    note.el.style.top = `${y}px`;
    note.el.style.opacity = String(clamp(1.1 - progress * 0.34, 0.62, 1));
    note.el.style.setProperty("--note-w", `${layout.noteW}px`);
    note.el.style.setProperty("--note-h", `${layout.noteH}px`);
    note.el.style.setProperty("--note-font", `${layout.noteFont}px`);
  }
}

function notePosition(note) {
  const progress = clamp((state.elapsed - note.spawnTime) / NOTE_LIFETIME, 0, 1);
  return {
    x: (note.keyIndex + 0.5) * layout.laneWidth,
    y: layout.topY + (layout.strikeY - layout.topY) * progress,
    progress,
  };
}

function flashKey(key, className) {
  const cell = keyCells.get(key);
  if (!cell) {
    return;
  }

  cell.classList.remove("hit", "wrong");
  void cell.offsetWidth;
  cell.classList.add(className);
  window.setTimeout(() => cell.classList.remove(className), 110);
}

function render(now) {
  if (!gpu) {
    return;
  }

  buildInstances(now);

  uniformData[0] = layout.width;
  uniformData[1] = layout.height;
  uniformData[2] = now;
  uniformData[3] = 0;

  gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, uniformData);

  if (instanceCount > 0) {
    gpu.device.queue.writeBuffer(
      gpu.instanceBuffer,
      0,
      instanceData.subarray(0, instanceCount * 8),
    );
  }

  const commandEncoder = gpu.device.createCommandEncoder();
  const pass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: gpu.context.getCurrentTexture().createView(),
        clearValue: { r: 0.045, g: 0.048, b: 0.044, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, gpu.bindGroup);
  pass.setVertexBuffer(0, gpu.vertexBuffer);
  pass.setVertexBuffer(1, gpu.instanceBuffer);
  pass.draw(6, instanceCount);
  pass.end();

  gpu.device.queue.submit([commandEncoder.finish()]);
}

function buildInstances(now) {
  instanceCount = 0;

  pushRect(
    layout.width / 2,
    layout.height / 2,
    layout.width,
    layout.height,
    [0.045, 0.048, 0.044, 1],
  );

  drawLanes();
  drawIdlePreview(now);
  drawNotes();
  drawEffects();
  drawStrikeZone(now);
}

function drawLanes() {
  const playHeight = layout.strikeY - layout.topY + layout.noteH;

  for (let index = 0; index < KEY_ORDER.length; index += 1) {
    const x = (index + 0.5) * layout.laneWidth;
    const shade = index % 3 === 0 ? 0.068 : 0.045;
    pushRect(x, layout.topY + playHeight / 2, Math.max(1, layout.laneWidth - 1), playHeight, [
      shade,
      shade * 1.03,
      shade * 0.96,
      state.phase === "playing" ? 0.42 : 0.28,
    ]);

    if (index % 3 === 0) {
      pushRect(x - layout.laneWidth / 2, layout.topY + playHeight / 2, 1.4, playHeight, [
        0.94,
        0.9,
        0.82,
        0.11,
      ]);
    }
  }
}

function drawIdlePreview(now) {
  if (state.phase === "playing") {
    return;
  }

  for (let index = 0; index < 16; index += 1) {
    const keyIndex = (index * 5 + 2) % KEY_ORDER.length;
    const progress = (now * 0.12 + index * 0.09) % 1;
    const x = (keyIndex + 0.5) * layout.laneWidth;
    const y = layout.topY + (layout.strikeY - layout.topY) * progress;
    const color = NOTE_COLORS[keyIndex % NOTE_COLORS.length];
    pushRect(x, y, layout.noteW, layout.noteH, [color[0], color[1], color[2], 0.18]);
  }
}

function drawNotes() {
  for (const note of state.notes) {
    const { x, y, progress } = notePosition(note);
    const warning = progress > 0.76;
    const color = warning ? [1.0, 0.42, 0.42, 1] : note.color;
    pushRect(x, y, layout.noteW, layout.noteH, [color[0], color[1], color[2], 0.95]);
    pushRect(x, y + layout.noteH * 0.56, layout.noteW * 0.86, 4, [1, 1, 1, 0.16]);
  }
}

function drawEffects() {
  for (const effect of state.effects) {
    const lifeProgress = effect.age / effect.life;
    const alpha = 1 - lifeProgress;
    pushRect(effect.x, effect.y, effect.size, effect.size, [
      effect.color[0],
      effect.color[1],
      effect.color[2],
      alpha * 0.82,
    ]);
  }
}

function drawStrikeZone(now) {
  const pulse = 0.5 + Math.sin(now * 8) * 0.5;
  pushRect(layout.width / 2, layout.strikeY, layout.width - 20, 4, [1, 0.82, 0.4, 0.78]);
  pushRect(layout.width / 2, layout.strikeY + 13, layout.width - 20, 20, [
    0.21,
    0.82,
    0.72,
    0.08 + pulse * 0.04,
  ]);
}

function pushRect(x, y, width, height, color) {
  if (instanceCount >= MAX_INSTANCES) {
    return;
  }

  const offset = instanceCount * 8;
  instanceData[offset] = x;
  instanceData[offset + 1] = y;
  instanceData[offset + 2] = width;
  instanceData[offset + 3] = height;
  instanceData[offset + 4] = color[0];
  instanceData[offset + 5] = color[1];
  instanceData[offset + 6] = color[2];
  instanceData[offset + 7] = color[3];
  instanceCount += 1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
