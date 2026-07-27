import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const DATABASE_NAME = "chzzk-kirinuki-studio";
const PROJECT_STORE = "projects";
const SEED_PREFIX = "chzzkKirinukiEditorSeed:";
const STORAGE_KEY = "chzzkKirinukiProjectV1";
const WORKSPACE_META_KEY = "chzzkKirinukiWorkspaceMetaV1";
const BINDINGS_KEY = "chzzkKirinukiSourceBindingsV1";
const MODEL_CACHE_NAME = "transformers-cache";
const MODEL_CACHE_SENTINEL_TEXT = "keep-model-cache-across-workspace-reset";
const PROJECT_ID = "e2e-editor-interaction";
const EDITED_TEXT = "사람이 직접 고친 한글 자막";
const KEY = Object.freeze({
  ARROW_RIGHT: "\uE014",
  ESCAPE: "\uE00C",
  SPACE: "\uE00D",
  TAB: "\uE004"
});

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = path.resolve(process.argv[2] || path.join(root, "extension"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-kirinuki-editor-e2e-"));
const profileRoot = path.join(tempRoot, "chromium-profile");
const mediaPath = path.join(tempRoot, "interaction-source.mp4");
const screenshotPath = path.join(
  os.tmpdir(),
  `chzzk-kirinuki-editor-e2e-${Date.now()}-${process.pid}.png`
);

let driver = null;
let ffmpegProcess = null;
let sessionId = "";
let driverPort = null;
let cleanupPromise = null;
let driverOutput = "";
let ffmpegOutput = "";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function isExecutable(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(environmentName, candidates) {
  const configured = process.env[environmentName];
  const names = configured ? [configured, ...candidates] : candidates;
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);

  for (const name of names) {
    if (path.isAbsolute(name) || name.includes(path.sep)) {
      const candidate = path.resolve(name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
      continue;
    }
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(`${environmentName} 또는 PATH에서 실행 파일을 찾지 못했습니다: ${names.join(", ")}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert(Number.isInteger(port), "임시 ChromeDriver 포트를 할당하지 못했습니다.");
  return port;
}

function appendOutput(target, chunk) {
  const next = `${target}${chunk.toString()}`;
  return next.length > 80_000 ? next.slice(-80_000) : next;
}

async function fetchJson(url, { method = "GET", body, timeout = 30_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = payload?.value?.message || payload?.raw || response.statusText;
    throw new Error(`${method} ${url} 실패 (${response.status}): ${detail}`);
  }
  return payload;
}

async function webdriver(method, commandPath, body) {
  const requestBody = method === "POST" && body === undefined ? {} : body;
  const payload = await fetchJson(`http://127.0.0.1:${driverPort}${commandPath}`, { method, body: requestBody });
  if (payload?.value?.error) {
    throw new Error(`${payload.value.error}: ${payload.value.message || "WebDriver 명령 실패"}`);
  }
  return payload?.value;
}

async function executeSync(script, args = []) {
  return webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function executeAsync(script, args = []) {
  return webdriver("POST", `/session/${sessionId}/execute/async`, { script, args });
}

async function switchToWindow(handle) {
  await webdriver("POST", `/session/${sessionId}/window`, { handle });
}

async function openWindow(url, type = "window") {
  const created = await webdriver("POST", `/session/${sessionId}/window/new`, { type });
  const handle = created?.handle || "";
  assert(handle, `${type} window handle을 받지 못했습니다.`);
  await switchToWindow(handle);
  await webdriver("POST", `/session/${sessionId}/url`, { url });
  await waitUntil(
    () => executeSync("return document.readyState === 'complete';"),
    `${type} ${url} 초기화`
  );
  return handle;
}

async function broadcastCaptureSeedUpdate(sidepanelUrl, captureState) {
  const editorHandle = await webdriver("GET", `/session/${sessionId}/window`);
  let senderHandle = "";
  try {
    const created = await webdriver("POST", `/session/${sessionId}/window/new`, { type: "tab" });
    senderHandle = created?.handle || "";
    assert(senderHandle, "hot seed를 보낼 extension 탭 handle을 받지 못했습니다.");
    await webdriver("POST", `/session/${sessionId}/window`, { handle: senderHandle });
    await webdriver("POST", `/session/${sessionId}/url`, { url: sidepanelUrl });
    await waitUntil(
      () => executeSync("return document.readyState === 'complete';"),
      "hot seed sender sidepanel 초기화"
    );

    const result = await executeAsync(`
      const key = arguments[0];
      const projectId = arguments[1];
      const captureState = arguments[2];
      const done = arguments[arguments.length - 1];
      chrome.storage.local.set({
        [key]: {
          captureState,
          sourceTabId: null,
          updatedAt: new Date().toISOString()
        }
      }, () => {
        const storageError = chrome.runtime.lastError?.message || null;
        if (storageError) {
          done({ error: storageError });
          return;
        }
        chrome.runtime.sendMessage({
          type: "KIRINUKI_CAPTURE_SEED_UPDATED",
          projectId,
          captureState
        }, (response) => {
          const messageError = chrome.runtime.lastError?.message || null;
          setTimeout(() => done({
            ok: true,
            response: response ?? null,
            messageError
          }), 120);
        });
      });
    `, [`${SEED_PREFIX}${PROJECT_ID}`, PROJECT_ID, captureState]);
    assert(result?.ok, `hot seed runtime 전송 실패: ${result?.error || "알 수 없는 오류"}`);
    return result;
  } finally {
    if (senderHandle) {
      const currentHandle = await webdriver("GET", `/session/${sessionId}/window`).catch(() => "");
      if (currentHandle !== senderHandle) {
        await webdriver("POST", `/session/${sessionId}/window`, { handle: senderHandle }).catch(() => {});
      }
      await webdriver("DELETE", `/session/${sessionId}/window`).catch(() => {});
    }
    await webdriver("POST", `/session/${sessionId}/window`, { handle: editorHandle });
  }
}

async function waitForDriver() {
  const baseUrl = `http://127.0.0.1:${driverPort}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (driver?.exitCode !== null) {
      throw new Error(`ChromeDriver가 준비 전에 종료했습니다.\n${driverOutput.trim()}`);
    }
    try {
      const status = await fetchJson(`${baseUrl}/status`, { timeout: 1_000 });
      if (status?.value?.ready) {
        return;
      }
    } catch {
      // ChromeDriver가 포트에 바인딩할 때까지 짧게 재시도한다.
    }
    await delay(100);
  }
  throw new Error(`ChromeDriver가 10초 안에 준비되지 않았습니다.\n${driverOutput.trim()}`);
}

async function waitForExtensionTarget(debuggerAddress, serviceWorkerPath) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await fetchJson(`http://${debuggerAddress}/json/list`, { timeout: 2_000 });
    const target = targets.find((entry) => {
      if (entry?.type !== "service_worker" || typeof entry.url !== "string") {
        return false;
      }
      try {
        const url = new URL(entry.url);
        return url.protocol === "chrome-extension:" && url.pathname === `/${serviceWorkerPath}`;
      } catch {
        return false;
      }
    });
    if (target) {
      return target;
    }
    await delay(250);
  }
  throw new Error(`unpacked extension의 ${serviceWorkerPath} target을 찾지 못했습니다.`);
}

async function waitUntil(check, description, { timeout = 15_000, interval = 120 } = {}) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) {
      return lastValue;
    }
    await delay(interval);
  }
  throw new Error(`${description} 대기 시간 초과. 마지막 값: ${JSON.stringify(lastValue)}`);
}

async function findElement(selector) {
  const element = await webdriver("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector
  });
  assert(element?.[ELEMENT_KEY], `요소를 찾지 못했습니다: ${selector}`);
  return element;
}

async function clickElement(selector) {
  const element = await findElement(selector);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/click`);
  return element;
}

async function pressKey(value) {
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "key",
        id: "semantic-keyboard",
        actions: [
          { type: "keyDown", value },
          { type: "keyUp", value }
        ]
      }]
    });
  } finally {
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => {});
  }
}

async function clearAndType(selector, text) {
  const element = await findElement(selector);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/clear`);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/value`, {
    text,
    value: Array.from(text)
  });
}

async function setFileInput(selector, filePath) {
  const element = await findElement(selector);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/value`, {
    text: filePath,
    value: [filePath]
  });
}

async function pointerDrag(selector, moves) {
  const element = await findElement(selector);
  await executeSync(`
    arguments[0].scrollIntoView({ block: "center", inline: "center" });
    globalThis.__kirinukiE2eDragMoves = 0;
    globalThis.__kirinukiE2ePointerDown = false;
    globalThis.__kirinukiE2eDragTrace = [];
    if (!globalThis.__kirinukiE2ePointerProbeInstalled) {
      globalThis.__kirinukiE2ePointerProbeInstalled = true;
      window.addEventListener("pointerdown", (event) => {
        globalThis.__kirinukiE2ePointerDown = true;
        globalThis.__kirinukiE2eDragTrace.push({
          type: "down",
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId,
          target: event.target?.className || event.target?.id || event.target?.tagName
        });
      }, true);
      window.addEventListener("pointermove", (event) => {
        if (globalThis.__kirinukiE2ePointerDown) {
          globalThis.__kirinukiE2eDragMoves += 1;
          globalThis.__kirinukiE2eDragTrace.push({
            type: "move",
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            target: event.target?.className || event.target?.id || event.target?.tagName
          });
        }
      }, true);
      window.addEventListener("pointerup", (event) => {
        globalThis.__kirinukiE2eDragTrace.push({
          type: "up",
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId,
          target: event.target?.className || event.target?.id || event.target?.tagName
        });
        globalThis.__kirinukiE2ePointerDown = false;
      }, true);
      window.addEventListener("pointercancel", () => {
        globalThis.__kirinukiE2ePointerDown = false;
      }, true);
    }
  `, [element]);
  const actions = [
    { type: "pointerMove", duration: 0, origin: element, x: 0, y: 0 },
    { type: "pointerDown", button: 0 },
    ...moves.map(({ x, y, duration = 90 }) => ({
      type: "pointerMove",
      duration,
      origin: "pointer",
      x,
      y
    })),
    { type: "pointerUp", button: 0 }
  ];
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "pointer",
        id: `pointer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        parameters: { pointerType: "mouse" },
        actions
      }]
    });
  } finally {
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => {});
  }
  return executeSync(`
    return {
      moves: globalThis.__kirinukiE2eDragMoves || 0,
      trace: globalThis.__kirinukiE2eDragTrace || []
    };
  `);
}

async function contextClickElement(selector) {
  const element = await findElement(selector);
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "pointer",
        id: `context-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: element, x: 0, y: 0 },
          { type: "pointerDown", button: 2 },
          { type: "pointerUp", button: 2 }
        ]
      }]
    });
  } finally {
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => {});
  }
}

async function readStoredProject() {
  const result = await executeAsync(`
    const projectId = arguments[0];
    const done = arguments[arguments.length - 1];
    const open = indexedDB.open(arguments[1], 1);
    open.onerror = () => done({ error: String(open.error || "IndexedDB open failed") });
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(arguments[2], "readonly");
      const request = transaction.objectStore(arguments[2]).get(projectId);
      request.onerror = () => {
        database.close();
        done({ error: String(request.error || "IndexedDB read failed") });
      };
      request.onsuccess = () => {
        const value = request.result || null;
        database.close();
        done({ value });
      };
    };
  `, [PROJECT_ID, DATABASE_NAME, PROJECT_STORE]);
  assert(!result?.error, `IndexedDB 읽기 실패: ${result?.error}`);
  return result?.value || null;
}

async function waitForStoredProject(predicate, description, options) {
  return waitUntil(async () => {
    const project = await readStoredProject();
    return project && predicate(project) ? project : false;
  }, description, options);
}

function terminateProcessGroup(child, signal) {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForExit(child, milliseconds) {
  if (!child || child.exitCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, milliseconds);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  terminateProcessGroup(child, "SIGTERM");
  if (!await waitForExit(child, 3_000)) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 3_000);
  }
}

async function cleanup() {
  if (cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = (async () => {
    if (sessionId && driver?.exitCode === null) {
      try {
        await fetchJson(`http://127.0.0.1:${driverPort}/session/${sessionId}`, {
          method: "DELETE",
          timeout: 5_000
        });
      } catch {
        // process group 종료가 남은 Chromium까지 정리한다.
      }
      sessionId = "";
    }
    await stopProcess(driver);
    await stopProcess(ffmpegProcess);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  })();
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

async function createSyntheticMedia(ffmpeg) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi",
    "-i", "sine=frequency=660:sample_rate=48000",
    "-t", "12",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "96k",
    "-movflags", "+faststart",
    mediaPath
  ];
  ffmpegProcess = spawn(ffmpeg, args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  ffmpegProcess.stdout.on("data", (chunk) => {
    ffmpegOutput = appendOutput(ffmpegOutput, chunk);
  });
  ffmpegProcess.stderr.on("data", (chunk) => {
    ffmpegOutput = appendOutput(ffmpegOutput, chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    ffmpegProcess.once("error", reject);
    ffmpegProcess.once("exit", resolve);
  });
  assert(exitCode === 0, `합성 MP4 생성 실패 (ffmpeg ${exitCode}):\n${ffmpegOutput.trim()}`);
  ffmpegProcess = null;
  await access(mediaPath);
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
  const serviceWorkerPath = manifest.background?.service_worker;
  assert(serviceWorkerPath, "manifest에 background.service_worker가 없습니다.");
  for (const requiredPath of [
    serviceWorkerPath,
    "editor.html",
    "sidepanel.html",
    "editor/editor.js"
  ]) {
    await access(path.join(extensionRoot, requiredPath));
  }

  const [chromedriver, chromium, ffmpeg, port] = await Promise.all([
    resolveExecutable("CHROMEDRIVER_BINARY", ["chromedriver"]),
    resolveExecutable("CHROMIUM_BINARY", ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]),
    resolveExecutable("FFMPEG_BINARY", ["ffmpeg"]),
    reservePort()
  ]);
  driverPort = port;
  await createSyntheticMedia(ffmpeg);

  driver = spawn(chromedriver, [`--port=${driverPort}`], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  driver.stdout.on("data", (chunk) => {
    driverOutput = appendOutput(driverOutput, chunk);
  });
  driver.stderr.on("data", (chunk) => {
    driverOutput = appendOutput(driverOutput, chunk);
  });
  await waitForDriver();

  const created = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        strictFileInteractability: false,
        "goog:loggingPrefs": { browser: "ALL" },
        "goog:chromeOptions": {
          binary: chromium,
          args: [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--window-size=1600,1100",
            `--user-data-dir=${profileRoot}`,
            `--disable-extensions-except=${extensionRoot}`,
            `--load-extension=${extensionRoot}`
          ]
        }
      }
    }
  });
  sessionId = created.sessionId;
  assert(sessionId, "ChromeDriver session ID를 받지 못했습니다.");
  await webdriver("POST", `/session/${sessionId}/window/rect`, { width: 1600, height: 1100 });

  const debuggerAddress = created.capabilities?.["goog:chromeOptions"]?.debuggerAddress;
  assert(debuggerAddress, "Chrome DevTools debugger address를 받지 못했습니다.");
  const extensionTarget = await waitForExtensionTarget(debuggerAddress, serviceWorkerPath);
  const extensionId = new URL(extensionTarget.url).host;
  assert(extensionId, "service worker target에서 extension ID를 찾지 못했습니다.");

  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await webdriver("POST", `/session/${sessionId}/url`, { url: sidepanelUrl });
  const captureState = {
    schemaVersion: 1,
    projectName: "Editor Interaction E2E",
    source: {
      platform: "CHZZK",
      url: "https://chzzk.naver.com/video/e2e-vod",
      canonicalUrl: "https://chzzk.naver.com/video/e2e-vod",
      channelId: "e2e-channel",
      contentId: "e2e-vod",
      contentType: "vod",
      streamerName: "E2E 스트리머",
      broadcastTitle: "사용자 선택 기반 편집 검증",
      broadcastStartedAt: "2026-07-27 20:00:00",
      observedAt: "2026-07-27T11:00:00.000Z"
    },
    globalInstruction: "",
    draft: {
      startText: "",
      endText: "",
      description: "",
      startCapture: null,
      endCapture: null,
      editingId: null
    },
    segments: [
      {
        id: "selection-a",
        startSeconds: 0.5,
        endSeconds: 4,
        description: "첫 번째 사용자 선택",
        startCapture: null,
        endCapture: null,
        createdAt: "2026-07-27T11:00:01.000Z",
        updatedAt: "2026-07-27T11:00:01.000Z"
      },
      {
        id: "selection-b",
        startSeconds: 5,
        endSeconds: 9,
        description: "두 번째 사용자 선택",
        startCapture: null,
        endCapture: null,
        createdAt: "2026-07-27T11:00:02.000Z",
        updatedAt: "2026-07-27T11:00:02.000Z"
      }
    ],
    updatedAt: "2026-07-27T11:00:02.000Z"
  };
  const seedResult = await executeAsync(`
    const key = arguments[0];
    const captureState = arguments[1];
    const done = arguments[arguments.length - 1];
    chrome.storage.local.set({
      [key]: {
        captureState,
        sourceTabId: null,
        updatedAt: new Date().toISOString()
      }
    }, () => {
      const error = chrome.runtime.lastError;
      done(error ? { error: error.message } : { ok: true });
    });
  `, [`${SEED_PREFIX}${PROJECT_ID}`, captureState]);
  assert(seedResult?.ok, `extension storage seed 실패: ${seedResult?.error || "알 수 없는 오류"}`);

  const editorUrl = `chrome-extension://${extensionId}/editor.html?project=${encodeURIComponent(PROJECT_ID)}`;
  await webdriver("POST", `/session/${sessionId}/url`, { url: editorUrl });
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        ready: document.readyState === "complete",
        clipCount: document.querySelectorAll("#clip-list .clip-item").length,
        title: document.querySelector("#project-name")?.value
      };
    `);
    return state.ready && state.clipCount === 2 && state.title === "Editor Interaction E2E" ? state : false;
  }, "두 사용자 선택이 있는 editor 초기화");

  await setFileInput("#media-input", mediaPath);
  const mediaState = await waitUntil(async () => {
    const state = await executeSync(`
      const video = document.querySelector("#preview-video");
      return {
        name: document.querySelector("#media-name")?.textContent,
        dialogHidden: document.querySelector("#job-dialog")?.hidden,
        videoWidth: video?.videoWidth || 0,
        duration: video?.duration || 0
      };
    `);
    return (
      state.name === path.basename(mediaPath) &&
      state.dialogHidden &&
      state.videoWidth === 640 &&
      state.duration >= 11.5
    ) ? state : false;
  }, "합성 MP4 파일 input 연결", { timeout: 25_000 });

  await clearAndType("#source-offset", "-1");
  await clickElement("#apply-source-offset");
  await delay(180);
  const persistentErrorToast = await executeSync(`
    const toast = document.querySelector("#toast");
    return {
      hidden: toast?.hidden,
      visible: Boolean(toast && !toast.hidden && getComputedStyle(toast).display !== "none"),
      role: toast?.getAttribute("role"),
      ariaLive: toast?.getAttribute("aria-live"),
      text: toast?.textContent || ""
    };
  `);
  assert(
    persistentErrorToast.visible &&
      persistentErrorToast.role === "alert" &&
      persistentErrorToast.ariaLive === "assertive" &&
      persistentErrorToast.text.includes("원본 시작보다 앞으로"),
    `timeout=0 오류 toast가 150ms 뒤 유지되지 않았습니다: ${JSON.stringify(persistentErrorToast)}`
  );
  const invalidOffsetProject = await readStoredProject();
  assert(
    invalidOffsetProject?.broadcastSession?.alignmentOffsetMs === 0,
    `실패한 음수 offset이 프로젝트를 변경했습니다: ${invalidOffsetProject?.broadcastSession?.alignmentOffsetMs}`
  );

  const aiProbeSetup = await executeSync(`
    const button = document.querySelector("#generate-captions");
    globalThis.__kirinukiE2eOriginalWorker = globalThis.Worker;
    globalThis.__kirinukiE2eWorkerConstructions = 0;
    globalThis.Worker = new Proxy(globalThis.Worker, {
      construct() {
        globalThis.__kirinukiE2eWorkerConstructions += 1;
        throw new Error("E2E: Escape 전에 AI worker가 생성되었습니다.");
      }
    });
    button.focus();
    globalThis.__kirinukiE2eDialogTrace = [];
    window.addEventListener("keydown", (event) => {
      if (event.key === "Tab" || event.key === "Escape") {
        queueMicrotask(() => {
          globalThis.__kirinukiE2eDialogTrace.push({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            dialogOpen: document.querySelector("#job-dialog")?.open,
            activeId: document.activeElement?.id || null
          });
        });
      }
    });
    document.querySelector("#job-dialog")?.addEventListener("cancel", (event) => {
      globalThis.__kirinukiE2eDialogTrace.push({
        type: "cancel",
        defaultPrevented: event.defaultPrevented
      });
    });
    document.querySelector("#job-dialog")?.addEventListener("close", () => {
      globalThis.__kirinukiE2eDialogTrace.push({ type: "close" });
    });
    return {
      activeId: document.activeElement?.id || null,
      workerWrapped: globalThis.Worker !== globalThis.__kirinukiE2eOriginalWorker
    };
  `);
  assert(
    aiProbeSetup.activeId === "generate-captions" && aiProbeSetup.workerWrapped,
    `AI dialog probe 준비 실패: ${JSON.stringify(aiProbeSetup)}`
  );

  let aiDialogOpened = null;
  let aiDialogAfterTab = null;
  let aiDialogCanceled = null;
  let aiWorkerProbe = null;
  try {
    await clickElement("#generate-captions");
    aiDialogOpened = await waitUntil(async () => {
      const state = await executeSync(`
        const dialog = document.querySelector("#job-dialog");
        return {
          hidden: dialog?.hidden,
          open: dialog?.open,
          activeId: document.activeElement?.id || null,
          activeInside: Boolean(dialog?.contains(document.activeElement))
        };
      `);
      return (
        state.hidden === false &&
        state.open === true &&
        state.activeInside &&
        state.activeId === "cancel-job"
      ) ? state : false;
    }, "AI 작업 dialog open과 초기 focus");

    await pressKey(KEY.TAB);
    aiDialogAfterTab = await waitUntil(async () => {
      const state = await executeSync(`
        const dialog = document.querySelector("#job-dialog");
        return {
          open: dialog?.open,
          activeId: document.activeElement?.id || null,
          activeInside: Boolean(dialog?.contains(document.activeElement))
        };
      `);
      return state.open && state.activeInside && state.activeId === "cancel-job" ? state : false;
    }, "AI dialog 안의 Tab focus trap");

    await pressKey(KEY.ESCAPE);
    try {
      aiDialogCanceled = await waitUntil(async () => {
        const state = await executeSync(`
          const dialog = document.querySelector("#job-dialog");
          const button = document.querySelector("#generate-captions");
          return {
            hidden: dialog?.hidden,
            open: dialog?.open,
            activeId: document.activeElement?.id || null,
            buttonDisabled: button?.disabled,
            progressHidden: document.querySelector("#ai-progress")?.hidden
          };
        `);
        return (
          state.hidden === true &&
          state.open === false &&
          state.activeId === "generate-captions" &&
          state.buttonDisabled === false &&
          state.progressHidden === true
        ) ? state : false;
      }, "AI dialog Escape 취소와 focus 복원", { timeout: 8_000 });
    } catch (error) {
      const actual = await executeSync(`
        const dialog = document.querySelector("#job-dialog");
        const button = document.querySelector("#generate-captions");
        return {
          hidden: dialog?.hidden,
          open: dialog?.open,
          activeId: document.activeElement?.id || null,
          activeTag: document.activeElement?.tagName || null,
          activeInside: Boolean(dialog?.contains(document.activeElement)),
          buttonDisabled: button?.disabled,
          progressHidden: document.querySelector("#ai-progress")?.hidden,
          workerConstructions: globalThis.__kirinukiE2eWorkerConstructions || 0,
          trace: globalThis.__kirinukiE2eDialogTrace || [],
          toast: document.querySelector("#toast")?.textContent || ""
        };
      `);
      const stored = await readStoredProject();
      throw new Error(
        `${error.message}\nactual=${JSON.stringify(actual)}\nai=${JSON.stringify(stored?.ai)}`
      );
    }
    await waitForStoredProject(
      (project) => project.ai?.status === "canceled",
      "AI dialog Escape 취소 저장",
      { timeout: 20_000 }
    );
  } finally {
    aiWorkerProbe = await executeSync(`
      const result = {
        constructions: globalThis.__kirinukiE2eWorkerConstructions || 0
      };
      if (globalThis.__kirinukiE2eOriginalWorker) {
        globalThis.Worker = globalThis.__kirinukiE2eOriginalWorker;
      }
      delete globalThis.__kirinukiE2eOriginalWorker;
      return result;
    `).catch(() => null);
  }
  assert(
    aiWorkerProbe?.constructions === 0,
    `Escape 전에 실제 AI worker가 시작됐습니다: ${JSON.stringify(aiWorkerProbe)}`
  );

  const nativeSpaceSetup = await executeSync(`
    const button = document.querySelector("#add-cue-top");
    const video = document.querySelector("#preview-video");
    video.pause();
    globalThis.__kirinukiE2eNativeSpace = {
      clicks: 0,
      trustedClicks: 0,
      playEvents: 0
    };
    button.addEventListener("click", (event) => {
      globalThis.__kirinukiE2eNativeSpace.clicks += 1;
      globalThis.__kirinukiE2eNativeSpace.trustedClicks += Number(event.isTrusted);
    });
    video.addEventListener("play", () => {
      globalThis.__kirinukiE2eNativeSpace.playEvents += 1;
    });
    button.focus();
    return {
      activeId: document.activeElement?.id || null,
      cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
      paused: video.paused
    };
  `);
  assert(
    nativeSpaceSetup.activeId === "add-cue-top" &&
      nativeSpaceSetup.cueCount === 0 &&
      nativeSpaceSetup.paused,
    `native Space 사전 상태가 올바르지 않습니다: ${JSON.stringify(nativeSpaceSetup)}`
  );
  await pressKey(KEY.SPACE);
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
        editorHidden: document.querySelector("#cue-editor")?.hidden,
        cueId: document.querySelector("#caption-tracks .cue-block")?.dataset.id || null,
        clicks: globalThis.__kirinukiE2eNativeSpace?.clicks || 0
      };
    `);
    return (
      state.cueCount === 1 &&
      state.editorHidden === false &&
      state.cueId &&
      state.clicks === 1
    ) ? state : false;
  }, "native Space로 직접 자막 추가");
  await delay(150);
  const nativeSpaceButton = await executeSync(`
    const video = document.querySelector("#preview-video");
    return {
      ...globalThis.__kirinukiE2eNativeSpace,
      cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
      paused: video.paused,
      playingClass: document.querySelector("#play-toggle")?.classList.contains("playing")
    };
  `);
  assert(
    nativeSpaceButton.clicks === 1 &&
      nativeSpaceButton.trustedClicks === 1 &&
      nativeSpaceButton.cueCount === 1 &&
      nativeSpaceButton.paused &&
      nativeSpaceButton.playEvents === 0 &&
      nativeSpaceButton.playingClass === false,
    `native button Space가 click/playback shortcut을 분리하지 못했습니다: ${JSON.stringify(nativeSpaceButton)}`
  );

  const cueId = await executeSync(`
    return document.querySelector("#caption-tracks .cue-block")?.dataset.id || null;
  `);
  assert(cueId, "추가된 자막 ID를 찾지 못했습니다.");

  const cueLeftHandleHit = await executeSync(`
    const cue = document.querySelector('.cue-block[data-id="' + arguments[0] + '"]');
    const handle = cue?.querySelector(".trim-handle.left");
    const playhead = document.querySelector("#playhead");
    if (!cue || !handle || !playhead) {
      return { ready: false };
    }
    const rect = handle.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const cueStartPx = Number.parseFloat(cue.style.left);
    const playheadPx = Number.parseFloat(playhead.style.left);
    return {
      ready: true,
      cueStartPx,
      playheadPx,
      startDeltaPx: Math.abs(cueStartPx - playheadPx),
      hitIsLeftHandle: hit?.closest(".trim-handle.left") === handle,
      hitTarget: hit?.className || hit?.id || hit?.tagName || null
    };
  `, [cueId]);
  assert(
    cueLeftHandleHit.ready &&
      cueLeftHandleHit.startDeltaPx < 0.1 &&
      cueLeftHandleHit.hitIsLeftHandle,
    `cue 시작점과 겹친 왼쪽 handle hit target 회귀: ${JSON.stringify(cueLeftHandleHit)}`
  );

  const cueHandleNudgeBefore = await executeSync(`
    const handle = document.querySelector(
      '.cue-block[data-id="' + arguments[0] + '"] .trim-handle.left'
    );
    globalThis.__kirinukiE2eOldCueHandle = handle;
    handle?.focus();
    return {
      activeIsHandle: document.activeElement === handle,
      ariaValueNow: handle?.getAttribute("aria-valuenow") || null,
      ariaValueText: handle?.getAttribute("aria-valuetext") || null
    };
  `, [cueId]);
  assert(
    cueHandleNudgeBefore.activeIsHandle &&
      Number(cueHandleNudgeBefore.ariaValueNow) === 0 &&
      cueHandleNudgeBefore.ariaValueText === "00:00:00.000",
    `cue trim handle Arrow 사전 ARIA/focus 상태 오류: ${JSON.stringify(cueHandleNudgeBefore)}`
  );
  await pressKey(KEY.ARROW_RIGHT);
  const cueHandleNudgeAfter = await waitUntil(async () => {
    const state = await executeSync(`
      const handle = document.querySelector(
        '.cue-block[data-id="' + arguments[0] + '"] .trim-handle.left'
      );
      return {
        activeIsNewHandle:
          document.activeElement === handle &&
          handle !== globalThis.__kirinukiE2eOldCueHandle,
        oldHandleConnected: globalThis.__kirinukiE2eOldCueHandle?.isConnected ?? null,
        ariaValueNow: handle?.getAttribute("aria-valuenow") || null,
        ariaValueText: handle?.getAttribute("aria-valuetext") || null
      };
    `, [cueId]);
    return (
      state.activeIsNewHandle &&
      state.oldHandleConnected === false &&
      Number(state.ariaValueNow) === 0.1 &&
      state.ariaValueText === "00:00:00.100"
    ) ? state : false;
  }, "cue trim handle Arrow nudge 뒤 focus와 ARIA 갱신");
  await waitForStoredProject(
    (project) => project.subtitles.some((cue) => cue.id === cueId && cue.startOffsetMs === 100),
    "cue trim handle Arrow nudge autosave"
  );

  await clearAndType("#cue-text", EDITED_TEXT);
  await executeSync("document.querySelector('#cue-text').blur();");
  await waitForStoredProject(
    (project) => project.subtitles.some((cue) => cue.id === cueId && cue.text === EDITED_TEXT),
    "직접 수정한 자막 텍스트 autosave"
  );

  await clickElement("#next-clip");
  await delay(200);

  const leftDrag = await pointerDrag(
    `.cue-block[data-id="${cueId}"] .trim-handle.left`,
    [{ x: 12, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 0 }]
  );
  assert(leftDrag.moves >= 3, `왼쪽 cue drag pointermove가 부족합니다: ${JSON.stringify(leftDrag)}`);
  assert(
    String(leftDrag.trace[0]?.target || "").includes("trim-handle"),
    `왼쪽 cue 손잡이가 pointerdown target이 아닙니다: ${JSON.stringify(leftDrag)}`
  );
  let afterLeftTrim;
  try {
    afterLeftTrim = await waitForStoredProject(
      (project) => project.subtitles.some((cue) => cue.id === cueId && cue.startOffsetMs >= 50),
      "자막 왼쪽 손잡이 drag autosave"
    );
  } catch (error) {
    const stored = await readStoredProject();
    const cue = stored?.subtitles?.find((candidate) => candidate.id === cueId);
    throw new Error(`${error.message}\nleft drag=${JSON.stringify(leftDrag)}\nstored cue=${JSON.stringify(cue)}`);
  }
  const leftTrimmedCue = afterLeftTrim.subtitles.find((cue) => cue.id === cueId);

  const rightDrag = await pointerDrag(
    `.cue-block[data-id="${cueId}"] .trim-handle.right`,
    [{ x: -12, y: 0 }, { x: -12, y: 0 }, { x: -12, y: 0 }]
  );
  assert(rightDrag.moves >= 3, `오른쪽 cue drag pointermove가 부족합니다: ${JSON.stringify(rightDrag)}`);
  assert(
    String(rightDrag.trace[0]?.target || "").includes("trim-handle"),
    `오른쪽 cue 손잡이가 pointerdown target이 아닙니다: ${JSON.stringify(rightDrag)}`
  );
  await waitForStoredProject(
    (project) => project.subtitles.some((cue) => {
      if (cue.id !== cueId) {
        return false;
      }
      return cue.endOffsetMs <= leftTrimmedCue.endOffsetMs - 50 && cue.endOffsetMs > cue.startOffsetMs;
    }),
    "자막 오른쪽 손잡이 drag autosave"
  );

  await executeSync(`
    document.querySelector(
      '.cue-block[data-id="' + arguments[0] + '"] .cue-block-body'
    )?.click();
  `, [cueId]);
  await waitUntil(async () => {
    const overlay = await executeSync(`
      const element = document.querySelector("#subtitle-overlays .subtitle-overlay");
      return {
        visible: Boolean(element && !element.hidden),
        cueId: element?.dataset.cueId || null
      };
    `);
    return overlay.visible && overlay.cueId === cueId ? overlay : false;
  }, "자막 overlay 표시");

  const overlayDrag = await pointerDrag(
    "#subtitle-overlays .subtitle-overlay",
    [{ x: 20, y: -16 }, { x: 20, y: -16 }, { x: 20, y: -16 }]
  );
  assert(overlayDrag.moves >= 3, `overlay drag pointermove가 부족합니다: ${JSON.stringify(overlayDrag)}`);
  let overlayDragObserved = null;
  await waitForStoredProject(
    (project) => {
      overlayDragObserved = project.subtitles.find((cue) => cue.id === cueId) || null;
      return overlayDragObserved?.x > 0.505 && overlayDragObserved?.y < 0.835;
    },
    "자막 overlay 위치 drag autosave"
  ).catch((error) => {
    throw new Error(
      `${error.message} cue=${JSON.stringify(overlayDragObserved)} drag=${JSON.stringify(overlayDrag)}`
    );
  });

  await executeSync(`
    const input = document.querySelector("#font-color");
    input.value = "#ff66aa";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  const coloredCueProject = await waitForStoredProject(
    (project) => project.subtitles.find((cue) => cue.id === cueId)?.color === "#ff66aa",
    "선택 자막별 색상 autosave"
  );

  await clickElement("#add-subtitle-lane");
  const laneUi = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        count: document.querySelectorAll("#caption-tracks .caption-track-row").length,
        label: document.querySelector("#subtitle-lane-count")?.textContent || ""
      };
    `);
    return state.count === 3 && state.label === "3" ? state : false;
  }, "자막 레인 추가 UI");
  await waitForStoredProject(
    (project) => project.subtitleLaneCount === 3,
    "자막 레인 추가 autosave"
  );

  await contextClickElement(`.cue-block[data-id="${cueId}"]`);
  const captionContextMenu = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        menuHidden: document.querySelector("#timeline-context-menu")?.hidden,
        addHidden: document.querySelector("#context-add-cue")?.hidden,
        deleteHidden: document.querySelector("#context-delete-cue")?.hidden
      };
    `);
    return (
      state.menuHidden === false &&
      state.addHidden === false &&
      state.deleteHidden === false
    ) ? state : false;
  }, "자막 우클릭 메뉴");
  await clickElement("#context-add-cue");
  const simultaneousProject = await waitForStoredProject(
    (project) => (
      project.subtitles.length === 2 &&
      project.subtitles.some((cue) => cue.id !== cueId && cue.lane !== 0)
    ),
    "다른 레인의 동시 자막 추가"
  );
  const simultaneousCue = simultaneousProject.subtitles.find((cue) => cue.id !== cueId);
  await clickElement(`.cue-block[data-id="${simultaneousCue.id}"] .cue-block-body`);
  const simultaneousOverlayCount = await waitUntil(async () => {
    const count = await executeSync(
      `return document.querySelectorAll("#subtitle-overlays .subtitle-overlay").length;`
    );
    return count === 2 ? count : false;
  }, "동시 자막 2개 미리보기");
  await contextClickElement(`.cue-block[data-id="${simultaneousCue.id}"]`);
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-delete-cue")?.hidden === false;`),
    "자막 우클릭 삭제 메뉴"
  );
  await clickElement("#context-delete-cue");
  await waitForStoredProject(
    (project) => project.subtitles.length === 1 && project.subtitles[0].id === cueId,
    "우클릭 자막 삭제"
  );

  await clickElement("#add-audio-region");
  const audioProject = await waitForStoredProject(
    (project) => project.audioRegions.length === 1 && project.selectedAudioRegionId,
    "음성 설정 구간 추가"
  );
  const audioRegionId = audioProject.audioRegions[0].id;
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        block: Boolean(document.querySelector('.audio-block[data-id="' + arguments[0] + '"]')),
        editorHidden: document.querySelector("#audio-editor")?.hidden,
        audioTabSelected: document.querySelector("#audio-mode-tab")?.getAttribute("aria-selected")
      };
    `, [audioRegionId]);
    return (
      state.block &&
      state.editorHidden === false &&
      state.audioTabSelected === "true"
    ) ? state : false;
  }, "음성 설정 선택 UI");
  await executeSync(`
    const input = document.querySelector("#audio-volume");
    input.value = "35";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  const quietAudioProject = await waitForStoredProject(
    (project) => Math.abs(project.audioRegions[0]?.gain - 0.35) < 0.0001,
    "음성 구간 음량 autosave"
  );
  await contextClickElement(`.audio-block[data-id="${audioRegionId}"]`);
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-delete-audio")?.hidden === false;`),
    "음성 우클릭 삭제 메뉴"
  );
  await clickElement("#context-delete-audio");
  await waitForStoredProject(
    (project) => project.audioRegions.length === 0,
    "우클릭 음성 설정 삭제"
  );
  await executeSync(`
    document.querySelector(
      '.cue-block[data-id="' + arguments[0] + '"] .cue-block-body'
    )?.click();
  `, [cueId]);
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        text: document.querySelector("#cue-text")?.value || "",
        captionTabSelected: document.querySelector("#caption-mode-tab")?.getAttribute("aria-selected")
      };
    `);
    return (
      state.text === EDITED_TEXT &&
      state.captionTabSelected === "true"
    ) ? state : false;
  }, "멀티트랙 검증 후 원래 자막 선택 복원");
  const multitrackUiProbe = {
    color: coloredCueProject.subtitles.find((cue) => cue.id === cueId)?.color,
    laneUi,
    captionContextMenu,
    simultaneousCueLane: simultaneousCue.lane,
    simultaneousOverlayCount,
    audioGain: quietAudioProject.audioRegions[0]?.gain
  };

  const reorderKeyboardSetup = await executeSync(`
    const control = document.querySelector(
      '.clip-item[data-id="clip-selection-b"] [data-action="up"]'
    );
    globalThis.__kirinukiE2eReorderKeyboard = {
      clicks: 0,
      trustedClicks: 0
    };
    control?.addEventListener("click", (event) => {
      globalThis.__kirinukiE2eReorderKeyboard.clicks += 1;
      globalThis.__kirinukiE2eReorderKeyboard.trustedClicks += Number(event.isTrusted);
    });
    control?.focus();
    return {
      activeClipId: document.activeElement?.closest(".clip-item")?.dataset.id || null,
      activeAction: document.activeElement?.dataset.action || null
    };
  `);
  assert(
    reorderKeyboardSetup.activeClipId === "clip-selection-b" &&
      reorderKeyboardSetup.activeAction === "up",
    `clip reorder 키보드 사전 focus 오류: ${JSON.stringify(reorderKeyboardSetup)}`
  );
  await pressKey(KEY.SPACE);
  const reorderedProject = await waitForStoredProject(
    (project) => project.clips[0]?.id === "clip-selection-b" && project.clips[1]?.id === "clip-selection-a",
    "clip reorder autosave"
  );
  const reorderKeyboardFocus = await waitUntil(async () => {
    const state = await executeSync(`
      const active = document.activeElement;
      return {
        ...globalThis.__kirinukiE2eReorderKeyboard,
        clipOrder: [...document.querySelectorAll("#clip-list .clip-item")]
          .map((item) => item.dataset.id),
        activeClipId: active?.closest(".clip-item")?.dataset.id || null,
        activeClass: active?.className || null,
        activeAction: active?.dataset.action || null
      };
    `);
    return (
      state.clicks === 1 &&
      state.trustedClicks === 1 &&
      state.clipOrder.join(",") === "clip-selection-b,clip-selection-a" &&
      state.activeClipId === "clip-selection-b" &&
      state.activeClass === "clip-select" &&
      state.activeAction === null
    ) ? state : false;
  }, "clip reorder 키보드 click 뒤 같은 clip focus 복원");
  assert(reorderedProject.subtitles.some((cue) => cue.id === cueId), "reorder 저장본에서 자막을 찾지 못했습니다.");

  const rollbackClipBefore = reorderedProject.clips.find(
    (clip) => clip.id === "clip-selection-a"
  );
  const rollbackCueBefore = reorderedProject.subtitles.find((cue) => cue.id === cueId);
  assert(
    rollbackClipBefore &&
      rollbackCueBefore?.origin === "human" &&
      rollbackCueBefore.text === EDITED_TEXT,
    "clip trim round-trip 전 human cue fixture가 없습니다."
  );
  const clipTrimRoundTrip = await pointerDrag(
    '.clip-block[data-id="clip-selection-a"] .trim-handle.left',
    [{ x: 160, y: 0, duration: 180 }, { x: -160, y: 0, duration: 180 }]
  );
  const roundTripDown = clipTrimRoundTrip.trace.find((event) => event.type === "down");
  const roundTripMoves = clipTrimRoundTrip.trace.filter((event) => event.type === "move");
  const roundTripUp = clipTrimRoundTrip.trace.find((event) => event.type === "up");
  assert(
    roundTripDown &&
      roundTripUp &&
      Math.max(...roundTripMoves.map((event) => event.x)) >= roundTripDown.x + 140 &&
      Math.abs(roundTripUp.x - roundTripDown.x) <= 2,
    `clip 왼쪽 손잡이가 cue 뒤까지 갔다가 release 전 복귀하지 않았습니다: ${JSON.stringify(
      clipTrimRoundTrip
    )}`
  );
  await delay(350);
  const roundTripProject = await waitForStoredProject(
    (project) => {
      const clip = project.clips.find((candidate) => candidate.id === "clip-selection-a");
      const cue = project.subtitles.find((candidate) => candidate.id === cueId);
      return (
        clip?.sourceStartMs === rollbackClipBefore.sourceStartMs &&
        clip?.sourceEndMs === rollbackClipBefore.sourceEndMs &&
        cue?.text === rollbackCueBefore.text &&
        cue.startOffsetMs === rollbackCueBefore.startOffsetMs &&
        cue.endOffsetMs === rollbackCueBefore.endOffsetMs &&
        cue.origin === "human"
      );
    },
    "clip trim round-trip 뒤 human cue 보존"
  );
  const rollbackCueAfter = roundTripProject.subtitles.find((cue) => cue.id === cueId);

  const clipLeftDrag = await pointerDrag(
    '.clip-block[data-id="clip-selection-a"] .trim-handle.left',
    [{ x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }]
  );
  assert(clipLeftDrag.moves >= 3, `왼쪽 clip drag pointermove가 부족합니다: ${JSON.stringify(clipLeftDrag)}`);
  assert(
    String(clipLeftDrag.trace[0]?.target || "").includes("trim-handle"),
    `왼쪽 clip 손잡이가 pointerdown target이 아닙니다: ${JSON.stringify(clipLeftDrag)}`
  );
  await delay(350);
  const afterClipLeftTrim = await waitForStoredProject(
    (project) => {
      const clip = project.clips.find((candidate) => candidate.id === "clip-selection-a");
      return clip && clip.sourceStartMs >= clip.selectionStartMs + 50;
    },
    "clip 왼쪽 손잡이 drag autosave"
  );
  const leftTrimmedClip = afterClipLeftTrim.clips.find((clip) => clip.id === "clip-selection-a");

  const clipRightDrag = await pointerDrag(
    '.clip-block[data-id="clip-selection-a"] .trim-handle.right',
    [{ x: -10, y: 0 }, { x: -10, y: 0 }, { x: -10, y: 0 }]
  );
  assert(clipRightDrag.moves >= 3, `오른쪽 clip drag pointermove가 부족합니다: ${JSON.stringify(clipRightDrag)}`);
  assert(
    String(clipRightDrag.trace[0]?.target || "").includes("trim-handle"),
    `오른쪽 clip 손잡이가 pointerdown target이 아닙니다: ${JSON.stringify(clipRightDrag)}`
  );
  await delay(350);
  let trimmedProject;
  try {
    trimmedProject = await waitForStoredProject(
      (project) => {
        const clip = project.clips.find((candidate) => candidate.id === "clip-selection-a");
        return (
          clip &&
          clip.sourceStartMs === leftTrimmedClip.sourceStartMs &&
          clip.sourceEndMs <= clip.selectionEndMs - 50
        );
      },
      "clip 오른쪽 손잡이 drag autosave"
    );
  } catch (error) {
    const actual = await readStoredProject();
    throw new Error(
      `${error.message}\n` +
      `leftTrimmed=${JSON.stringify(leftTrimmedClip)}\n` +
      `actualClip=${JSON.stringify(
        actual?.clips?.find((clip) => clip.id === "clip-selection-a")
      )}\n` +
      `actualCue=${JSON.stringify(
        actual?.subtitles?.find((cue) => cue.id === cueId)
      )}\n` +
      `roundTrip=${JSON.stringify(clipTrimRoundTrip)}\n` +
      `rightDrag=${JSON.stringify(clipRightDrag)}`
    );
  }
  const trimmedClipBeforeHotSeed = trimmedProject.clips.find((clip) => clip.id === "clip-selection-a");
  assert(trimmedClipBeforeHotSeed, "hot seed 전 trim된 clip을 찾지 못했습니다.");

  const hotCaptureState = {
    ...captureState,
    segments: [
      ...captureState.segments,
      {
        id: "selection-c",
        startSeconds: 9.5,
        endSeconds: 11.5,
        description: "hot seed로 추가된 세 번째 사용자 선택",
        startCapture: null,
        endCapture: null,
        createdAt: "2026-07-27T11:00:03.000Z",
        updatedAt: "2026-07-27T11:00:03.000Z"
      }
    ],
    updatedAt: "2026-07-27T11:00:03.000Z"
  };
  const hotSeedDelivery = await broadcastCaptureSeedUpdate(sidepanelUrl, hotCaptureState);
  const hotSeedProject = await waitForStoredProject(
    (project) => {
      const clip = project.clips.find((candidate) => candidate.id === "clip-selection-a");
      const appended = project.clips.find((candidate) => candidate.id === "clip-selection-c");
      return (
        project.clips.map((candidate) => candidate.id).join(",") ===
          "clip-selection-b,clip-selection-a,clip-selection-c" &&
        clip?.sourceStartMs === trimmedClipBeforeHotSeed.sourceStartMs &&
        clip?.sourceEndMs === trimmedClipBeforeHotSeed.sourceEndMs &&
        appended?.sourceStartMs === 9_500 &&
        appended?.sourceEndMs === 11_500 &&
        project.subtitles.some((cue) => cue.id === cueId && cue.text === EDITED_TEXT)
      );
    },
    "hot seed merge와 IndexedDB autosave"
  );

  const hotSeedDom = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        clipOrder: [...document.querySelectorAll("#clip-list .clip-item")].map((item) => item.dataset.id),
        clipTitles: [...document.querySelectorAll("#clip-list .clip-title")].map((item) => item.textContent),
        clipCount: document.querySelectorAll("#video-track .clip-block").length,
        cueText: document.querySelector("#cue-text")?.value || ""
      };
    `);
    return (
      state.clipOrder.join(",") === "clip-selection-b,clip-selection-a,clip-selection-c" &&
      state.clipTitles[2] === "hot seed로 추가된 세 번째 사용자 선택" &&
      state.clipCount === 3 &&
      state.cueText === EDITED_TEXT
    ) ? state : false;
  }, "hot seed 반영 editor DOM");

  const finalPersistedCue = hotSeedProject.subtitles.find((cue) => cue.id === cueId);
  assert(finalPersistedCue, "hot seed 저장본에서 자막을 찾지 못했습니다.");

  await clickElement(`.cue-block[data-id="${cueId}"] .cue-block-body`);
  await waitUntil(async () => {
    const visible = await executeSync(`
      const element = document.querySelector("#subtitle-overlays .subtitle-overlay");
      return Boolean(element && !element.hidden && element.dataset.cueId === arguments[0]);
    `, [cueId]);
    return visible;
  }, "reorder 후 자막 overlay 복원");

  const screenshot = await webdriver("GET", `/session/${sessionId}/screenshot`);
  await writeFile(screenshotPath, Buffer.from(screenshot, "base64"));
  await access(screenshotPath);

  const expected = {
    clipOrder: hotSeedProject.clips.map((clip) => clip.id),
    trimmedClip: {
      sourceStartMs: trimmedClipBeforeHotSeed.sourceStartMs,
      sourceEndMs: trimmedClipBeforeHotSeed.sourceEndMs
    },
    text: finalPersistedCue.text,
    startOffsetMs: finalPersistedCue.startOffsetMs,
    endOffsetMs: finalPersistedCue.endOffsetMs,
    x: finalPersistedCue.x,
    y: finalPersistedCue.y,
    color: finalPersistedCue.color,
    mediaName: reorderedProject.mediaAsset?.name
  };

  await delay(400);
  await webdriver("POST", `/session/${sessionId}/url`, { url: editorUrl });
  let restored;
  try {
    restored = await waitForStoredProject((project) => {
      const cue = project.subtitles.find((candidate) => candidate.id === cueId);
      return (
        project.clips.map((clip) => clip.id).join(",") === expected.clipOrder.join(",") &&
        project.clips.find((clip) => clip.id === "clip-selection-a")?.sourceStartMs ===
          expected.trimmedClip.sourceStartMs &&
        project.clips.find((clip) => clip.id === "clip-selection-a")?.sourceEndMs ===
          expected.trimmedClip.sourceEndMs &&
        cue?.text === expected.text &&
        cue.startOffsetMs === expected.startOffsetMs &&
        cue.endOffsetMs === expected.endOffsetMs &&
        Math.abs(cue.x - expected.x) < 0.0001 &&
        Math.abs(cue.y - expected.y) < 0.0001 &&
        cue.color === expected.color &&
        project.mediaAsset?.name === expected.mediaName
      );
    }, "reload 후 IndexedDB 프로젝트 복원");
  } catch (error) {
    const actual = await readStoredProject();
    const actualCue = actual?.subtitles?.find((candidate) => candidate.id === cueId);
    throw new Error(
      `${error.message}\nexpected=${JSON.stringify(expected)}\n` +
      `actual=${JSON.stringify({
        clipOrder: actual?.clips?.map((clip) => clip.id),
        cue: actualCue,
        mediaName: actual?.mediaAsset?.name
      })}`
    );
  }
  const restoredCue = restored.subtitles.find((cue) => cue.id === cueId);

  const restoredDom = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        clipOrder: [...document.querySelectorAll("#clip-list .clip-item")].map((item) => item.dataset.id),
        cueText: document.querySelector("#cue-text")?.value || "",
        cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
        mediaName: document.querySelector("#media-name")?.textContent || ""
      };
    `);
    return (
      state.clipOrder.join(",") === expected.clipOrder.join(",") &&
      state.cueText === expected.text &&
      state.cueCount === 1 &&
      state.mediaName === expected.mediaName
    ) ? state : false;
  }, "reload 후 editor DOM 복원");

  const primaryEditorHandle = await webdriver("GET", `/session/${sessionId}/window`);
  const staleWorkspaceState = {
    ...hotCaptureState,
    editorProjectId: PROJECT_ID,
    projectName: "Editor Interaction E2E"
  };
  const staleWorkspaceMetaSeed = {
    resetEpoch: "e2e-before-reset",
    revision: 40,
    writerId: "e2e-reset-fixture"
  };
  const modelCacheSentinelUrl =
    "https://huggingface.co/chzzk-kirinuki-e2e/model-cache-sentinel";
  const resetFixture = await executeAsync(`
    const [
      storageKey,
      workspaceMetaKey,
      bindingsKey,
      seedPrefix,
      projectId,
      workspaceState,
      workspaceMeta,
      cacheName,
      cacheUrl,
      cacheText,
      databaseName
    ] = arguments;
    const done = arguments[arguments.length - 1];
    void (async () => {
      await chrome.storage.local.set({
        [storageKey]: workspaceState,
        [workspaceMetaKey]: workspaceMeta,
        [seedPrefix + projectId]: {
          projectId,
          captureState: workspaceState,
          updatedAt: new Date().toISOString()
        },
        [seedPrefix + "e2e-extra-seed"]: {
          projectId: "e2e-extra-seed",
          captureState: workspaceState,
          updatedAt: new Date().toISOString()
        }
      });
      await chrome.storage.session.set({
        [bindingsKey]: {
          [projectId]: {
            projectId,
            sourceTabId: 999999,
            sourceIdentity: workspaceState.source,
            sourceSessionId: "e2e-stale-binding"
          }
        }
      });
      const cache = await caches.open(cacheName);
      await cache.put(cacheUrl, new Response(cacheText));
      const databaseFixture = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onerror = () => reject(
          request.error || new Error("reset fixture IndexedDB open failed")
        );
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(
            ["projects", "media-handles"],
            "readwrite"
          );
          const projects = transaction.objectStore("projects");
          const handles = transaction.objectStore("media-handles");
          const handleKey = "e2e-reset-media-handle";
          handles.put({
            kind: "file",
            name: "e2e-reset-media-handle-sentinel"
          }, handleKey);
          const projectCount = projects.count();
          const handleCount = handles.count();
          const handleValue = handles.get(handleKey);
          transaction.oncomplete = () => {
            database.close();
            resolve({
              projectCount: projectCount.result,
              handleCount: handleCount.result,
              handleValue: handleValue.result
            });
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error || new Error("reset fixture IndexedDB transaction failed"));
          };
          transaction.onabort = transaction.onerror;
        };
      });
      done({
        ok: true,
        cacheText: await (await cache.match(cacheUrl)).text(),
        databaseFixture
      });
    })().catch((error) => done({
      error: error instanceof Error ? error.stack || error.message : String(error)
    }));
  `, [
    STORAGE_KEY,
    WORKSPACE_META_KEY,
    BINDINGS_KEY,
    SEED_PREFIX,
    PROJECT_ID,
    staleWorkspaceState,
    staleWorkspaceMetaSeed,
    MODEL_CACHE_NAME,
    modelCacheSentinelUrl,
    MODEL_CACHE_SENTINEL_TEXT,
    DATABASE_NAME
  ]);
  assert(
    resetFixture?.ok &&
      resetFixture.cacheText === MODEL_CACHE_SENTINEL_TEXT &&
      resetFixture.databaseFixture?.projectCount >= 1 &&
      resetFixture.databaseFixture?.handleCount >= 1 &&
      resetFixture.databaseFixture?.handleValue?.name ===
        "e2e-reset-media-handle-sentinel",
    `reset fixture/cache sentinel 생성 실패: ${JSON.stringify(resetFixture)}`
  );

  const secondEditorHandle = await openWindow(editorUrl, "window");
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        title: document.querySelector("#project-name")?.value || "",
        clipCount: document.querySelectorAll("#clip-list .clip-item").length
      };
    `);
    return state.title === "Editor Interaction E2E" && state.clipCount === 3
      ? state
      : false;
  }, "reset 전 두 번째 editor window 복원");

  const sidepanelAHandle = await openWindow(sidepanelUrl, "window");
  const waitForResetPanelFixture = (label) => waitUntil(async () => {
    const state = await executeSync(`
      return {
        ready: document.readyState === "complete",
        projectName: document.querySelector("#project-name")?.value || "",
        segmentCount: document.querySelectorAll("#segments-list .segment-item").length
      };
    `);
    return state.ready &&
      state.projectName === "Editor Interaction E2E" &&
      state.segmentCount === 3 ? state : false;
  }, label);
  const sidepanelAFixture = await waitForResetPanelFixture("reset sidepanel A 초기화");

  const sidepanelBHandle = await openWindow(sidepanelUrl, "window");
  const sidepanelBFixture = await waitForResetPanelFixture("reset sidepanel B 초기화");

  await switchToWindow(sidepanelAHandle);
  const dirtyGateSetup = await executeSync(`
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const gate = {
      captured: null,
      released: false,
      response: null,
      release: null
    };
    const wrappedSendMessage = (message, ...args) => {
      if (message?.type !== "KIRINUKI_PERSIST_STATE" || gate.captured) {
        return originalSendMessage(message, ...args);
      }
      gate.captured = structuredClone(message);
      return new Promise((resolve, reject) => {
        gate.release = async () => {
          if (gate.released) {
            return gate.response;
          }
          gate.released = true;
          try {
            gate.response = await originalSendMessage(message, ...args);
            resolve(gate.response);
            return gate.response;
          } catch (error) {
            reject(error);
            throw error;
          }
        };
      });
    };
    chrome.runtime.sendMessage = wrappedSendMessage;
    globalThis.__kirinukiE2eDirtyGate = gate;
    const input = document.querySelector("#project-name");
    input.value = "A DIRTY INPUT PRESERVED";
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "A DIRTY INPUT PRESERVED"
    }));
    return {
      wrapped: chrome.runtime.sendMessage === wrappedSendMessage,
      projectName: input.value
    };
  `);
  assert(
    dirtyGateSetup.wrapped &&
      dirtyGateSetup.projectName === "A DIRTY INPUT PRESERVED",
    `sidepanel A dirty persist gate 설치 실패: ${JSON.stringify(dirtyGateSetup)}`
  );
  const dirtyGateCaptured = await waitUntil(async () => {
    const gate = await executeSync(`
      const gate = globalThis.__kirinukiE2eDirtyGate;
      return {
        captured: gate?.captured || null,
        released: gate?.released || false
      };
    `);
    return gate.captured && !gate.released ? gate : false;
  }, "sidepanel A dirty PERSIST 보류");

  await switchToWindow(sidepanelBHandle);
  await executeSync(`
    const input = document.querySelector("#global-instruction");
    input.value = "B REMOTE REVISION";
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "B REMOTE REVISION"
    }));
  `);
  const dirtyRemotePersisted = await waitUntil(async () => {
    const snapshot = await executeAsync(`
      const storageKey = arguments[0];
      const workspaceMetaKey = arguments[1];
      const done = arguments[arguments.length - 1];
      chrome.storage.local.get([storageKey, workspaceMetaKey], (stored) => {
        const error = chrome.runtime.lastError?.message || null;
        done(error ? { error } : {
          state: stored[storageKey] || null,
          workspaceMeta: stored[workspaceMetaKey] || null
        });
      });
    `, [STORAGE_KEY, WORKSPACE_META_KEY]);
    return (
      !snapshot.error &&
      snapshot.state?.globalInstruction === "B REMOTE REVISION" &&
      snapshot.workspaceMeta?.revision > staleWorkspaceMetaSeed.revision
    ) ? snapshot : false;
  }, "sidepanel B remote revision 저장");

  await switchToWindow(sidepanelAHandle);
  const dirtyInputPreserved = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        projectName: document.querySelector("#project-name")?.value || "",
        globalInstruction: document.querySelector("#global-instruction")?.value || "",
        status: document.querySelector("#status-bar")?.textContent || ""
      };
    `);
    return (
      state.projectName === "A DIRTY INPUT PRESERVED" &&
      state.globalInstruction === "B REMOTE REVISION" &&
      state.status.includes("현재 입력은 보존")
    ) ? state : false;
  }, "sidepanel A dirty input + B revision 병합");
  const dirtyGateRelease = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const gate = globalThis.__kirinukiE2eDirtyGate;
    if (!gate?.release) {
      done({ error: "dirty persist gate release가 없습니다." });
      return;
    }
    void gate.release()
      .then((response) => done({ response }))
      .catch((error) => done({
        error: error instanceof Error ? error.stack || error.message : String(error)
      }));
  `);
  assert(
    !dirtyGateRelease?.error &&
      dirtyGateRelease.response?.ok === false &&
      dirtyGateRelease.response?.workspaceMeta?.revision ===
        dirtyRemotePersisted.workspaceMeta.revision,
    `sidepanel A stale dirty PERSIST가 CAS 충돌로 끝나지 않았습니다: ${JSON.stringify(
      dirtyGateRelease
    )}`
  );
  const dirtyMergedPersisted = await waitUntil(async () => {
    const snapshot = await executeAsync(`
      const storageKey = arguments[0];
      const workspaceMetaKey = arguments[1];
      const done = arguments[arguments.length - 1];
      chrome.storage.local.get([storageKey, workspaceMetaKey], (stored) => {
        const error = chrome.runtime.lastError?.message || null;
        done(error ? { error } : {
          state: stored[storageKey] || null,
          workspaceMeta: stored[workspaceMetaKey] || null
        });
      });
    `, [STORAGE_KEY, WORKSPACE_META_KEY]);
    return (
      !snapshot.error &&
      snapshot.state?.projectName === "A DIRTY INPUT PRESERVED" &&
      snapshot.state?.globalInstruction === "B REMOTE REVISION" &&
      snapshot.workspaceMeta?.revision > dirtyRemotePersisted.workspaceMeta.revision
    ) ? snapshot : false;
  }, "sidepanel A dirty input 재저장");
  await switchToWindow(sidepanelBHandle);
  const dirtyMergedDom = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        projectName: document.querySelector("#project-name")?.value || "",
        globalInstruction: document.querySelector("#global-instruction")?.value || ""
      };
    `);
    return (
      state.projectName === "A DIRTY INPUT PRESERVED" &&
      state.globalInstruction === "B REMOTE REVISION"
    ) ? state : false;
  }, "sidepanel B dirty merge 결과 동기화");
  const dirtyMergeSmoke = {
    gateCaptured: dirtyGateCaptured,
    remotePersisted: dirtyRemotePersisted,
    inputPreserved: dirtyInputPreserved,
    gateRelease: dirtyGateRelease,
    mergedPersisted: dirtyMergedPersisted,
    mergedDom: dirtyMergedDom
  };

  await executeSync(`
    const input = document.querySelector("#project-name");
    input.value = "STALE PANEL B SHOULD NOT RETURN";
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "STALE PANEL B SHOULD NOT RETURN"
    }));
  `);
  const stalePersisted = await waitUntil(async () => {
    const snapshot = await executeAsync(`
      const storageKey = arguments[0];
      const workspaceMetaKey = arguments[1];
      const done = arguments[arguments.length - 1];
      chrome.storage.local.get([storageKey, workspaceMetaKey], (stored) => {
        const error = chrome.runtime.lastError?.message || null;
        done(error ? { error } : {
          state: stored[storageKey] || null,
          workspaceMeta: stored[workspaceMetaKey] || null
        });
      });
    `, [STORAGE_KEY, WORKSPACE_META_KEY]);
    return (
      !snapshot.error &&
      snapshot.state?.projectName === "STALE PANEL B SHOULD NOT RETURN" &&
      snapshot.workspaceMeta?.resetEpoch === staleWorkspaceMetaSeed.resetEpoch &&
      snapshot.workspaceMeta?.revision > staleWorkspaceMetaSeed.revision
    ) ? snapshot : false;
  }, "sidepanel B stale state CAS 저장");

  await switchToWindow(sidepanelAHandle);
  let resetClickError = null;
  const resetProbe = await executeSync(`
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__kirinukiE2eResetResponse = null;
    const wrappedSendMessage = async (message, ...args) => {
      const response = await originalSendMessage(message, ...args);
      if (message?.type === "KIRINUKI_RESET_BINDINGS") {
        globalThis.__kirinukiE2eResetResponse = response;
      }
      return response;
    };
    chrome.runtime.sendMessage = wrappedSendMessage;
    const status = document.querySelector("#status-bar");
    if (status) {
      status.hidden = true;
    }
    const button = document.querySelector("#reset-project");
    button?.scrollIntoView({ block: "center", inline: "center" });
    return {
      sendMessageWrapped: chrome.runtime.sendMessage === wrappedSendMessage,
      resetButtonVisible: Boolean(button && !button.hidden)
    };
  `);
  assert(
    resetProbe.sendMessageWrapped && resetProbe.resetButtonVisible,
    `reset response probe 설치 실패: ${JSON.stringify(resetProbe)}`
  );
  try {
    await clickElement("#reset-project");
  } catch (error) {
    resetClickError = error;
    if (!/unexpected alert open/i.test(String(error?.message || error))) {
      throw error;
    }
  }
  await webdriver("POST", `/session/${sessionId}/alert/accept`);
  const resetUi = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        inert: document.body.inert,
        projectName: document.querySelector("#project-name")?.value || "",
        segmentCount: document.querySelectorAll("#segments-list .segment-item").length,
        statusHidden: document.querySelector("#status-bar")?.hidden,
        status: document.querySelector("#status-bar")?.textContent || "",
        resetDisabled: document.querySelector("#reset-project")?.disabled,
        resetResponse: globalThis.__kirinukiE2eResetResponse
      };
    `);
    return !state.inert &&
      state.projectName === "" &&
      state.segmentCount === 0 &&
      !state.statusHidden &&
      state.status.includes("모델 캐시는 유지") &&
      !state.resetDisabled &&
      state.resetResponse?.ok === true &&
      Array.isArray(state.resetResponse?.cleanupErrors) &&
      state.resetResponse.cleanupErrors.length === 0 ? state : false;
  }, "sidepanel A 전체 workspace reset 완료", { timeout: 25_000 });

  const handlesAfterReset = await webdriver("GET", `/session/${sessionId}/window/handles`);
  assert(
    !handlesAfterReset.includes(primaryEditorHandle) &&
      !handlesAfterReset.includes(secondEditorHandle) &&
      handlesAfterReset.includes(sidepanelAHandle) &&
      handlesAfterReset.includes(sidepanelBHandle),
    `reset이 모든 editor window만 닫지 못했습니다: ${JSON.stringify({
      primaryEditorHandle,
      secondEditorHandle,
      sidepanelAHandle,
      sidepanelBHandle,
      handlesAfterReset
    })}`
  );

  await switchToWindow(sidepanelBHandle);
  const sidepanelBSynced = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        projectName: document.querySelector("#project-name")?.value || "",
        segmentCount: document.querySelectorAll("#segments-list .segment-item").length,
        status: document.querySelector("#status-bar")?.textContent || ""
      };
    `);
    return state.projectName === "" && state.segmentCount === 0 ? state : false;
  }, "sidepanel B reset epoch 동기화");

  const staleCasResponses = await executeAsync(`
    const [
      staleState,
      staleMeta,
      projectId,
      workspaceMetaKey
    ] = arguments;
    const done = arguments[arguments.length - 1];
    void (async () => {
      const before = (await chrome.storage.local.get(workspaceMetaKey))[workspaceMetaKey];
      const [persist, open] = await Promise.all([
        chrome.runtime.sendMessage({
          type: "KIRINUKI_PERSIST_STATE",
          state: staleState,
          writerId: "e2e-stale-panel-b",
          expectedResetEpoch: staleMeta.resetEpoch,
          expectedRevision: staleMeta.revision
        }),
        chrome.runtime.sendMessage({
          type: "KIRINUKI_OPEN_EDITOR",
          projectId,
          sourceTabId: 999999,
          captureState: staleState,
          expectedResetEpoch: staleMeta.resetEpoch,
          expectedRevision: staleMeta.revision
        })
      ]);
      const after = (await chrome.storage.local.get(workspaceMetaKey))[workspaceMetaKey];
      done({ persist, open, before, after });
    })().catch((error) => done({
        error: error instanceof Error ? error.stack || error.message : String(error)
      }));
  `, [
    stalePersisted.state,
    stalePersisted.workspaceMeta,
    PROJECT_ID,
    WORKSPACE_META_KEY
  ]);
  assert(
    !staleCasResponses?.error &&
      staleCasResponses.persist?.ok === false &&
      staleCasResponses.open?.ok === false &&
      staleCasResponses.persist?.workspaceMeta?.resetEpoch !==
        stalePersisted.workspaceMeta.resetEpoch &&
      staleCasResponses.open?.workspaceMeta?.resetEpoch ===
        staleCasResponses.persist.workspaceMeta.resetEpoch &&
      staleCasResponses.before?.resetEpoch === staleCasResponses.after?.resetEpoch &&
      staleCasResponses.before?.revision === staleCasResponses.after?.revision &&
      staleCasResponses.before?.writerId === staleCasResponses.after?.writerId,
    `reset 뒤 stale PERSIST/OPEN CAS가 거절되지 않았습니다: ${JSON.stringify(
      staleCasResponses
    )}`
  );

  await delay(4_600);
  const resetAudit = await executeAsync(`
    const [
      storageKey,
      workspaceMetaKey,
      bindingsKey,
      seedPrefix,
      databaseName,
      cacheName,
      cacheUrl,
      editorRoot
    ] = arguments;
    const done = arguments[arguments.length - 1];
    void (async () => {
      const [stored, session, databases, cacheNames, tabs] = await Promise.all([
        chrome.storage.local.get(null),
        chrome.storage.session.get(bindingsKey),
        indexedDB.databases(),
        caches.keys(),
        chrome.tabs.query({})
      ]);
      const cache = await caches.open(cacheName);
      const cached = await cache.match(cacheUrl);
      done({
        state: stored[storageKey] || null,
        workspaceMeta: stored[workspaceMetaKey] || null,
        seedKeys: Object.keys(stored).filter((key) => key.startsWith(seedPrefix)),
        bindings: session[bindingsKey] || {},
        databaseNames: databases.map((entry) => entry.name),
        cacheNames,
        cacheText: cached ? await cached.text() : null,
        editorTabs: tabs
          .filter((tab) => tab.url?.startsWith(editorRoot))
          .map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })),
        panelDom: {
          projectName: document.querySelector("#project-name")?.value || "",
          segmentCount: document.querySelectorAll("#segments-list .segment-item").length
        }
      });
    })().catch((error) => done({
      error: error instanceof Error ? error.stack || error.message : String(error)
    }));
  `, [
    STORAGE_KEY,
    WORKSPACE_META_KEY,
    BINDINGS_KEY,
    SEED_PREFIX,
    DATABASE_NAME,
    MODEL_CACHE_NAME,
    modelCacheSentinelUrl,
    `chrome-extension://${extensionId}/editor.html`
  ]);
  assert(
    !resetAudit?.error &&
      resetAudit.state?.editorProjectId === "" &&
      resetAudit.state?.projectName === "" &&
      resetAudit.state?.segments?.length === 0 &&
      resetAudit.workspaceMeta?.resetEpoch !== stalePersisted.workspaceMeta.resetEpoch &&
      resetAudit.workspaceMeta?.revision > stalePersisted.workspaceMeta.revision &&
      resetAudit.seedKeys.length === 0 &&
      Object.keys(resetAudit.bindings).length === 0 &&
      !resetAudit.databaseNames.includes(DATABASE_NAME) &&
      resetAudit.editorTabs.length === 0 &&
      resetAudit.cacheNames.includes(MODEL_CACHE_NAME) &&
      resetAudit.cacheText === MODEL_CACHE_SENTINEL_TEXT &&
      resetAudit.panelDom.projectName === "" &&
      resetAudit.panelDom.segmentCount === 0,
    `multi-window reset 뒤 workspace 정리/Cache 보존 계약 위반: ${JSON.stringify(
      resetAudit
    )}`
  );
  const resetSmoke = {
    fixture: {
      sidepanelA: sidepanelAFixture,
      sidepanelB: sidepanelBFixture,
      dirtyMerge: dirtyMergeSmoke,
      stalePersisted,
      resetClickError: resetClickError?.message || null
    },
    resetUi,
    sidepanelBSynced,
    staleCasResponses,
    handlesAfterReset,
    audit: resetAudit
  };

  const browserLogs = await webdriver("POST", `/session/${sessionId}/log`, { type: "browser" });
  const severeLogs = browserLogs.filter((entry) => entry.level === "SEVERE");
  assert(severeLogs.length === 0, `브라우저 SEVERE 로그가 있습니다:\n${JSON.stringify(severeLogs, null, 2)}`);

  console.log(JSON.stringify({
    ok: true,
    chromium,
    chromedriver,
    ffmpeg,
    extensionId,
    projectId: PROJECT_ID,
    media: mediaState,
    cue: {
      id: cueId,
      text: restoredCue.text,
      startOffsetMs: restoredCue.startOffsetMs,
      endOffsetMs: restoredCue.endOffsetMs,
      x: restoredCue.x,
      y: restoredCue.y,
      color: restoredCue.color,
      leftHandleHitAtCueStart: cueLeftHandleHit
    },
    clipOrder: restored.clips.map((clip) => clip.id),
    hotSeed: {
      delivery: hotSeedDelivery,
      dom: hotSeedDom,
      preservedTrim: expected.trimmedClip,
      appendedClip: restored.clips.find((clip) => clip.id === "clip-selection-c")
    },
    semantics: {
      nativeSpaceButton,
      multitrackUi: multitrackUiProbe,
      cueHandleNudge: {
        before: cueHandleNudgeBefore,
        after: cueHandleNudgeAfter
      },
      reorderKeyboardFocus,
      clipTrimRoundTrip: {
        moves: clipTrimRoundTrip.moves,
        down: roundTripDown,
        maxX: Math.max(...roundTripMoves.map((event) => event.x)),
        up: roundTripUp,
        cueBefore: rollbackCueBefore,
        cueAfter: rollbackCueAfter
      },
      persistentErrorToast,
      aiDialog: {
        opened: aiDialogOpened,
        afterTab: aiDialogAfterTab,
        canceled: aiDialogCanceled,
        worker: aiWorkerProbe
      }
    },
    restoredDom,
    resetSmoke,
    browserSevereLogs: severeLogs.length,
    screenshot: screenshotPath
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  if (driverOutput.trim()) {
    console.error("\nChromeDriver output:\n" + driverOutput.trim());
  }
  if (ffmpegOutput.trim()) {
    console.error("\nFFmpeg output:\n" + ffmpegOutput.trim());
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
