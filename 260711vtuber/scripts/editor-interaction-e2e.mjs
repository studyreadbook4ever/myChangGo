import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CAPTION_HARNESS_FINGERPRINT,
  CAPTION_QUALITY_PROFILE_ID
} from "../src/caption-agent/caption-quality-harness.js";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const DATABASE_NAME = "chzzk-kirinuki-studio";
const PROJECT_STORE = "projects";
const LOCAL_DRAFT_STORE = "local-drafts";
const SEED_PREFIX = "chzzkKirinukiEditorSeed:";
const STORAGE_KEY = "chzzkKirinukiProjectV1";
const WORKSPACE_META_KEY = "chzzkKirinukiWorkspaceMetaV1";
const BINDINGS_KEY = "chzzkKirinukiSourceBindingsV1";
const LEGACY_MODEL_CACHE_NAME = "transformers-cache";
const LEGACY_MODEL_CACHE_SENTINEL_TEXT = "remove-legacy-model-cache-on-reset";
const PROJECT_ID = "e2e-editor-interaction";
const EDITED_TEXT = "사람이 직접 고친 한글 자막";
const KEY = Object.freeze({
  ARROW_RIGHT: "\uE014",
  DELETE: "\uE017",
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

function formatEditorTime(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

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

async function clickAndAcceptSolarConfirmation(
  selector,
  expectedRequestCount
) {
  try {
    await clickElement(selector);
  } catch (error) {
    if (!/unexpected alert open/i.test(String(error?.message || error))) {
      throw error;
    }
  }
  const confirmationText = await webdriver(
    "GET",
    `/session/${sessionId}/alert/text`
  );
  assert(
    confirmationText.includes(
      `Solar Pro 3 요청 ${expectedRequestCount}회 · 컷당 1회`
    ) &&
      confirmationText.includes(
        `로컬 품질 보정 추가 Solar 호출 0회 · 최대 ${expectedRequestCount}회`
      ),
    `Solar 1회/clip 비용 계약 안내가 다릅니다: ${confirmationText}`
  );
  await webdriver("POST", `/session/${sessionId}/alert/accept`);
  return confirmationText;
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

async function pressKeyRepeated(value, count) {
  const repetitions = Math.max(0, Math.floor(Number(count) || 0));
  const actions = [];
  for (let index = 0; index < repetitions; index += 1) {
    actions.push(
      { type: "keyDown", value },
      { type: "keyUp", value }
    );
  }
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "key",
        id: `repeated-keyboard-${Date.now()}`,
        actions
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

async function pointerDragOnce(selector, moves) {
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
          trusted: event.isTrusted,
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
            trusted: event.isTrusted,
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
          trusted: event.isTrusted,
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

async function pointerDrag(selector, moves) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await pointerDragOnce(selector, moves);
    } catch (error) {
      const staleElement = String(error?.message || "").includes("stale element reference");
      if (!staleElement || attempt === 2) {
        throw error;
      }
      await delay(120);
    }
  }
  throw new Error(`drag 대상을 안정적으로 찾지 못했습니다: ${selector}`);
}

async function contextClickElement(selector, { x = 0, y = 0 } = {}) {
  const element = await findElement(selector);
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "pointer",
        id: `context-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: element, x, y },
          { type: "pointerDown", button: 2 },
          { type: "pointerUp", button: 2 }
        ]
      }]
    });
  } finally {
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => {});
  }
}

async function dispatchTransparentPngPaste() {
  return executeAsync(`
    const done = arguments[arguments.length - 1];
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, 24, 24);
    context.fillStyle = "rgba(30, 220, 120, 0.55)";
    context.fillRect(6, 6, 12, 12);
    canvas.toBlob((blob) => {
      if (!blob) {
        done({ error: "PNG Blob 생성 실패" });
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "transparent-e2e.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      });
      if (!event.clipboardData) {
        Object.defineProperty(event, "clipboardData", { value: transfer });
      }
      const dispatched = document.dispatchEvent(event);
      done({
        dispatched,
        defaultPrevented: event.defaultPrevented,
        size: blob.size,
        type: blob.type
      });
    }, "image/png");
  `);
}

async function readStoredProject() {
  const result = await executeAsync(`
    const projectId = arguments[0];
    const done = arguments[arguments.length - 1];
    const open = indexedDB.open(arguments[1]);
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

async function readLocalDrafts() {
  const result = await executeAsync(`
    const [databaseName, storeName, projectId] = arguments;
    const done = arguments[arguments.length - 1];
    const open = indexedDB.open(databaseName);
    open.onerror = () => done({
      error: String(open.error || "IndexedDB open failed")
    });
    open.onsuccess = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.close();
        done({ error: "local draft store missing" });
        return;
      }
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onerror = () => {
        database.close();
        done({ error: String(request.error || "local draft read failed") });
      };
      request.onsuccess = () => {
        const drafts = request.result
          .filter((draft) => String(draft.projectId) === String(projectId))
          .sort((left, right) => (
            Number(right.createdAtMs) - Number(left.createdAtMs) ||
            String(right.id).localeCompare(String(left.id))
          ));
        database.close();
        done({ drafts });
      };
    };
  `, [DATABASE_NAME, LOCAL_DRAFT_STORE, PROJECT_ID]);
  assert(!result?.error, `로컬 임시저장 읽기 실패: ${result?.error}`);
  return result?.drafts || [];
}

async function readImageAssetBlobKeys() {
  const result = await executeAsync(`
    const [databaseName, projectId] = arguments;
    const done = arguments[arguments.length - 1];
    const open = indexedDB.open(databaseName);
    open.onerror = () => done({ error: String(open.error || "IndexedDB open failed") });
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("image-assets", "readonly");
      const request = transaction.objectStore("image-assets").getAllKeys();
      request.onerror = () => {
        database.close();
        done({ error: String(request.error || "image asset key read failed") });
      };
      request.onsuccess = () => {
        const keys = request.result
          .filter((key) => Array.isArray(key) && String(key[0]) === String(projectId))
          .map((key) => String(key[1]))
          .sort();
        database.close();
        done({ keys });
      };
    };
  `, [DATABASE_NAME, PROJECT_ID]);
  assert(!result?.error, `이미지 에셋 Blob 키 읽기 실패: ${result?.error}`);
  return result?.keys || [];
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

  const previewSeekSetup = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const video = document.querySelector("#preview-video");
    const target = 3.65;
    const finish = () => done({
      currentTime: video.currentTime,
      readyState: video.readyState,
      standbyReadyState: document.querySelector("#preview-video-standby")?.readyState || 0
    });
    if (Math.abs(video.currentTime - target) <= 0.02) {
      finish();
      return;
    }
    const timeout = setTimeout(() => done({
      error: "preview transition seek timeout",
      currentTime: video.currentTime
    }), 5_000);
    video.addEventListener("seeked", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    video.currentTime = target;
  `);
  assert(
    !previewSeekSetup?.error &&
      Math.abs(previewSeekSetup.currentTime - 3.65) <= 0.02,
    `컷 경계 전환 검증 시작 시각을 맞추지 못했습니다: ${JSON.stringify(previewSeekSetup)}`
  );
  const standbyPreloadState = await waitUntil(async () => {
    const state = await executeSync(`
      const standby = document.querySelector("#preview-video-standby");
      return {
        currentTime: standby?.currentTime || 0,
        readyState: standby?.readyState || 0
      };
    `);
    return (
      Math.abs(state.currentTime - 5) <= 0.03
      && state.readyState >= 3
    ) ? state : false;
  }, "다음 컷의 재생 여유 데이터 선행 준비", { timeout: 8_000 });
  const previewTransitionSetup = await executeSync(`
    const original = document.querySelector("#preview-video");
    const trace = {
      original,
      startedAt: 0,
      lastOld: null,
      firstNew: null
    };
    globalThis.__kirinukiE2ePreviewTransition = trace;
    const tick = (now) => {
      const current = document.querySelector("#preview-video");
      if (current === original) {
        trace.lastOld = {
          wallMs: now,
          currentTime: current.currentTime,
          readyState: current.readyState
        };
        requestAnimationFrame(tick);
        return;
      }
      trace.firstNew = {
        wallMs: now,
        currentTime: current?.currentTime || 0,
        readyState: current?.readyState || 0,
        paused: current?.paused
      };
    };
    requestAnimationFrame(tick);
    return {
      currentTime: original?.currentTime || 0,
      standbyReadyState: document.querySelector("#preview-video-standby")?.readyState || 0
    };
  `);
  await clickElement("#play-toggle");
  await executeSync(`
    globalThis.__kirinukiE2ePreviewTransition.startedAt = performance.now();
    return true;
  `);
  const previewTransitionTrace = await waitUntil(async () => {
    const trace = await executeSync(`
      const value = globalThis.__kirinukiE2ePreviewTransition;
      return value?.firstNew ? {
        startedAt: value.startedAt,
        lastOld: value.lastOld,
        firstNew: value.firstNew
      } : null;
    `);
    return trace || false;
  }, "미리 준비한 다음 컷으로 실제 video layer 전환", { timeout: 4_000 });
  const previewTransitionGapMs = (
    previewTransitionTrace.firstNew.wallMs -
    previewTransitionTrace.lastOld.wallMs
  );
  assert(
    previewTransitionTrace.lastOld.currentTime >= 3.9 &&
      previewTransitionTrace.firstNew.currentTime >= 5 &&
      previewTransitionTrace.firstNew.currentTime < 5.2 &&
      previewTransitionTrace.firstNew.paused === false &&
      previewTransitionGapMs >= 0 &&
      previewTransitionGapMs < 120,
    `컷 경계 미리보기 전환이 끊김 상한을 넘었습니다: ${JSON.stringify({
      setup: previewTransitionSetup,
      trace: previewTransitionTrace,
      gapMs: previewTransitionGapMs
    })}`
  );
  await clickElement("#play-toggle");
  await waitUntil(
    () => executeSync(`return document.querySelector("#preview-video")?.paused === true;`),
    "컷 경계 전환 검증 뒤 미리보기 정지"
  );
  await clickElement("#previous-clip");
  await waitUntil(async () => {
    const state = await executeSync(`
      const video = document.querySelector("#preview-video");
      return {
        currentTime: video?.currentTime || 0,
        paused: video?.paused
      };
    `);
    return (
      state.paused === true &&
      Math.abs(state.currentTime - 0.5) <= 0.04
    ) ? state : false;
  }, "컷 경계 검증 뒤 첫 컷 정지 위치 복원");
  const previewTransitionSmoke = {
    seek: previewSeekSetup,
    preload: standbyPreloadState,
    setup: previewTransitionSetup,
    trace: previewTransitionTrace,
    layerGapMs: previewTransitionGapMs
  };

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
    globalThis.__kirinukiE2eOriginalFetch = globalThis.fetch;
    globalThis.__kirinukiE2eCaptionFetch = {
      probes: 0,
      requests: 0,
      aborted: 0
    };
    globalThis.fetch = (input, init = {}) => {
      if (String(input).startsWith("http://127.0.0.1:4319/")) {
        if (String(init.method || "GET").toUpperCase() === "GET") {
          globalThis.__kirinukiE2eCaptionFetch.probes += 1;
          return Promise.resolve(new Response(JSON.stringify({
            status: "ok"
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }));
        }
        globalThis.__kirinukiE2eCaptionFetch.requests += 1;
        return new Promise((_resolve, reject) => {
          const abort = () => {
            globalThis.__kirinukiE2eCaptionFetch.aborted += 1;
            reject(new DOMException("E2E caption request canceled", "AbortError"));
          };
          if (init.signal?.aborted) {
            abort();
          } else {
            init.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      }
      return globalThis.__kirinukiE2eOriginalFetch(input, init);
    };
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
      fetchWrapped: globalThis.fetch !== globalThis.__kirinukiE2eOriginalFetch
    };
  `);
  assert(
    aiProbeSetup.activeId === "generate-captions" && aiProbeSetup.fetchWrapped,
    `AI dialog probe 준비 실패: ${JSON.stringify(aiProbeSetup)}`
  );

  let aiDialogOpened = null;
  let aiDialogAfterTab = null;
  let aiDialogCanceled = null;
  let aiFetchProbe = null;
  try {
    await clickAndAcceptSolarConfirmation("#generate-captions", 2);

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

    await waitUntil(async () => {
      const state = await executeSync(`
        return structuredClone(globalThis.__kirinukiE2eCaptionFetch || {});
      `);
      return state.requests === 1 ? state : false;
    }, "선택 컷 외부 자막 요청 시작", { timeout: 20_000 });

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
          captionFetch: globalThis.__kirinukiE2eCaptionFetch || null,
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
    aiFetchProbe = await executeSync(`
      const result = structuredClone(globalThis.__kirinukiE2eCaptionFetch || {});
      if (globalThis.__kirinukiE2eOriginalFetch) {
        globalThis.fetch = globalThis.__kirinukiE2eOriginalFetch;
      }
      delete globalThis.__kirinukiE2eOriginalFetch;
      return result;
    `).catch(() => null);
  }
  assert(
    aiFetchProbe?.probes === 1 &&
      aiFetchProbe?.requests === 1 &&
      aiFetchProbe?.aborted === 1,
    `외부 자막 요청 취소 계약이 지켜지지 않았습니다: ${JSON.stringify(aiFetchProbe)}`
  );

  const aiSuccessBefore = await readStoredProject();
  assert(
    aiSuccessBefore?.subtitles?.length === 0 &&
      aiSuccessBefore?.ai?.status === "canceled",
    `AI 성공 경로 사전 프로젝트 상태가 올바르지 않습니다: ${JSON.stringify(aiSuccessBefore?.ai)}`
  );
  const aiSuccessSetup = await executeSync(`
    const qualityProfile = arguments[0];
    const harnessFingerprint = arguments[1];
    const stableStringify = (value) => {
      if (Array.isArray(value)) {
        return \`[\${value.map(stableStringify).join(",")}]\`;
      }
      if (
        value &&
        typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        return \`{\${Object.keys(value).sort().map(
          (key) => \`\${JSON.stringify(key)}:\${stableStringify(value[key])}\`
        ).join(",")}}\`;
      }
      return JSON.stringify(value);
    };
    const editorialContextFingerprint = (context) => {
      const bytes = new TextEncoder().encode(stableStringify(context));
      let first = 0x811C9DC5;
      let second = 0x9E3779B9;
      for (const byte of bytes) {
        first = Math.imul(first ^ byte, 0x01000193) >>> 0;
        second = Math.imul(second ^ byte, 0x85EBCA6B) >>> 0;
      }
      return \`ctx-v1-\${first.toString(16).padStart(8, "0")}\${second
        .toString(16).padStart(8, "0")}\`;
    };
    const endpointPrefix = "http://127.0.0.1:4319/";
    globalThis.__kirinukiE2eAiSuccessOriginalFetch = globalThis.fetch;
    globalThis.__kirinukiE2eAiSuccessFetch = {
      probes: 0,
      requests: [],
      unexpected: []
    };
    document.querySelector("#caption-agent-token").value = "e2e-session-token";
    document.querySelector("#caption-stt-endpoint").value = "https://stt.e2e.invalid/v1/audio/transcriptions";
    document.querySelector("#caption-stt-model").value = "e2e-timestamp-stt";
    document.querySelector("#caption-stt-api-key").value = "e2e-stt-memory-key";
    document.querySelector("#caption-upstage-api-key").value = "e2e-upstage-memory-key";
    globalThis.fetch = async (input, init = {}) => {
      if (!String(input).startsWith(endpointPrefix)) {
        return globalThis.__kirinukiE2eAiSuccessOriginalFetch(input, init);
      }
      const trace = globalThis.__kirinukiE2eAiSuccessFetch;
      const method = String(init.method || "GET").toUpperCase();
      if (method === "GET") {
        trace.probes += 1;
        return new Response(JSON.stringify({
          status: "ok"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (method !== "POST") {
        trace.unexpected.push({
          url: String(input),
          method
        });
        return new Response(JSON.stringify({ error: "unexpected method" }), {
          status: 405,
          headers: { "content-type": "application/json" }
        });
      }
      const request = JSON.parse(String(init.body || "{}"));
      const requestHeaders = new Headers(init.headers);
      const audioBinary = atob(request.audio?.data || "");
      const requestIndex = trace.requests.length;
      trace.requests.push({
        url: String(input),
        method: String(init.method || "").toUpperCase(),
        requestId: request.requestId || null,
        clipId: request.clip?.id || null,
        durationMs: request.clip?.durationMs || null,
        audioBytes: audioBinary.length,
        audioMagic: audioBinary.slice(0, 4),
        sampleRateHz: request.audio?.sampleRateHz || null,
        channels: request.audio?.channels || null,
        protocolHeader: requestHeaders.get("X-Kirinuki-Protocol"),
        authorization: requestHeaders.get("Authorization"),
        sttEndpoint: requestHeaders.get("X-Kirinuki-STT-Endpoint"),
        sttModel: requestHeaders.get("X-Kirinuki-STT-Model"),
        sttApiKey: requestHeaders.get("X-Kirinuki-STT-API-Key"),
        upstageApiKey: requestHeaders.get("X-Kirinuki-Upstage-API-Key"),
        bodyContainsProviderSecret: (
          String(init.body || "").includes("e2e-stt-memory-key")
          || String(init.body || "").includes("e2e-upstage-memory-key")
        ),
        policy: request.policy || null,
        visual: request.visual || null
      });
      const first = requestIndex === 0;
      const response = {
        schema: "chzzk-kirinuki-caption-response/v1",
        requestId: request.requestId,
        clipId: request.clip.id,
        language: "ko",
        sttModel: "e2e-stt",
        captionModel: request.model,
        model: request.model,
        resolvedModel: request.model,
        provider: "upstage",
        status: "completed",
        cues: [{
          startMs: first ? 200 : 300,
          endMs: first ? 1600 : 1900,
          text: first ? "첫 컷 AI 초안입니다." : "두 번째 컷 AI 초안?",
          speakerId: first ? "streamer" : "guest",
          reviewRequired: first,
          placement: first ? "top" : "bottom"
        }],
        warnings: first
          ? [{ code: "DROPPED_INVALID_CUE", cueIndex: 1 }]
          : [],
        qualityProfile,
        harnessFingerprint,
        editorialContextFingerprint: editorialContextFingerprint(
          request.editorialContext
        ),
        qualityReport: {
          profileId: qualityProfile,
          harnessFingerprint,
          valid: true,
          disposition: first ? "review-required" : "accepted",
          violations: [],
          cueReviews: [{
            cueIndex: 0,
            status: first ? "review-required" : "accepted",
            codes: [],
            metrics: {}
          }],
          metrics: { cueCount: 1 }
        }
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    return {
      wrapped: globalThis.fetch !== globalThis.__kirinukiE2eAiSuccessOriginalFetch,
      tokenValue: document.querySelector("#caption-agent-token")?.value || "",
      sttKeyValue: document.querySelector("#caption-stt-api-key")?.value || "",
      upstageKeyValue: document.querySelector("#caption-upstage-api-key")?.value || ""
    };
  `, [CAPTION_QUALITY_PROFILE_ID, CAPTION_HARNESS_FINGERPRINT]);
  assert(
    aiSuccessSetup.wrapped &&
      aiSuccessSetup.tokenValue === "e2e-session-token" &&
      aiSuccessSetup.sttKeyValue === "e2e-stt-memory-key" &&
      aiSuccessSetup.upstageKeyValue === "e2e-upstage-memory-key",
    `AI 성공 응답 mock 준비 실패: ${JSON.stringify(aiSuccessSetup)}`
  );

  let aiSuccessProject = null;
  let aiSuccessDom = null;
  let aiSuccessFetch = null;
  let aiSuccessRestored = null;
  try {
    await clickAndAcceptSolarConfirmation("#generate-captions", 2);
    aiSuccessProject = await waitForStoredProject(
      (candidate) => (
        candidate.ai?.status === "done" &&
        candidate.subtitles?.length === 2 &&
        candidate.ai?.warnings?.length === 1
      ),
      "mock 외부 에이전트의 전체 선택 컷 Solar 자막 저장",
      { timeout: 60_000 }
    );
    aiSuccessDom = await waitUntil(async () => {
      const state = await executeSync(`
        const warning = document.querySelector("#caption-agent-warning");
        const reviewBlock = document.querySelector(".cue-block.review-required");
        reviewBlock?.querySelector(".cue-block-body")?.click();
        return {
          dialogHidden: document.querySelector("#job-dialog")?.hidden,
          progressHidden: document.querySelector("#ai-progress")?.hidden,
          cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
          reviewMarkerCount: document.querySelectorAll(".cue-block.review-required").length,
          reviewMarkerTitle: reviewBlock?.title || "",
          warningHidden: warning?.hidden,
          warningText: warning?.textContent || "",
          reviewNoteHidden: document.querySelector("#cue-review-note")?.hidden,
          selectedCueText: document.querySelector("#cue-text")?.value || ""
        };
      `);
      return (
        state.dialogHidden === true &&
        state.cueCount === 2 &&
        state.reviewMarkerCount === 1 &&
        state.warningHidden === false &&
        state.warningText.includes("유효하지 않은 자막 제외 1건") &&
        state.reviewNoteHidden === false &&
        state.selectedCueText === "첫 컷 AI 초안입니다"
      ) ? state : false;
    }, "Solar 자막 검수 표식과 영속 gateway 경고 UI", { timeout: 20_000 });
  } finally {
    aiSuccessFetch = await executeSync(`
      const result = structuredClone(globalThis.__kirinukiE2eAiSuccessFetch || {});
      if (globalThis.__kirinukiE2eAiSuccessOriginalFetch) {
        globalThis.fetch = globalThis.__kirinukiE2eAiSuccessOriginalFetch;
      }
      document.querySelector("#caption-agent-token").value = "";
      document.querySelector("#caption-stt-api-key").value = "";
      document.querySelector("#caption-upstage-api-key").value = "";
      delete globalThis.__kirinukiE2eAiSuccessOriginalFetch;
      return result;
    `).catch(() => null);
  }
  const expectedAiClipIds = aiSuccessBefore.clips
    .filter((clip) => clip.enabled !== false)
    .map((clip) => clip.id);
  assert(
    aiSuccessFetch?.unexpected?.length === 0 &&
      aiSuccessFetch?.requests?.length === expectedAiClipIds.length &&
      aiSuccessFetch.requests.map((request) => request.clipId).join(",") === expectedAiClipIds.join(",") &&
      aiSuccessFetch.requests.every((request) => (
        request.method === "POST" &&
        request.requestId &&
        request.audioBytes > 44 &&
        request.audioMagic === "RIFF" &&
        request.sampleRateHz === 16_000 &&
        request.channels === 1 &&
        request.protocolHeader === "chzzk-kirinuki-caption-request/v1" &&
        request.authorization === "Bearer e2e-session-token" &&
        request.sttEndpoint === "https://stt.e2e.invalid/v1/audio/transcriptions" &&
        request.sttModel === "e2e-timestamp-stt" &&
        request.sttApiKey === "e2e-stt-memory-key" &&
        request.upstageApiKey === "e2e-upstage-memory-key" &&
        request.bodyContainsProviderSecret === false &&
        request.policy?.includeAllRecognizableSpeech === true &&
        request.policy?.maxCueDurationMs === 4_000 &&
        request.visual?.analysis === "local-three-band-edge-density-v1" &&
        request.visual?.framesShared === false &&
        request.visual?.samples?.length === 7 &&
        request.visual.samples.every((sample, index, samples) => (
          Number.isInteger(sample.atMs) &&
          sample.atMs >= 0 &&
          sample.atMs < request.durationMs &&
          (index === 0 || sample.atMs > samples[index - 1].atMs) &&
          ["top", "center", "bottom"].includes(sample.preferredPlacement) &&
          ["topScore", "centerScore", "bottomScore"].every((field) => (
            Number.isInteger(sample[field]) &&
            sample[field] >= 0 &&
            sample[field] <= 1_000
          ))
        ))
      )),
    `모든 활성 컷의 음성 추출/strict 응답 왕복 계약 위반: ${JSON.stringify(aiSuccessFetch)}`
  );
  assert(
    aiSuccessProject.subtitles.every((cue) => cue.origin === "ai") &&
      aiSuccessProject.subtitles.some((cue) => (
        cue.text === "첫 컷 AI 초안입니다" &&
        cue.remoteMeta?.reviewRequired === true &&
        cue.remoteMeta?.placement === "top"
      )) &&
      aiSuccessProject.subtitles.some((cue) => cue.text === "두 번째 컷 AI 초안?") &&
      aiSuccessProject.ai.warnings[0]?.clipId === expectedAiClipIds[0] &&
      aiSuccessProject.ai.warnings[0]?.code === "DROPPED_INVALID_CUE",
    `AI 자막/검수/경고 persistence 계약 위반: ${JSON.stringify({
      subtitles: aiSuccessProject.subtitles,
      ai: aiSuccessProject.ai
    })}`
  );

  await clickElement("#undo");
  aiSuccessRestored = await waitForStoredProject(
    (candidate) => (
      candidate.subtitles?.length === 0 &&
      candidate.ai?.status === aiSuccessBefore.ai?.status &&
      candidate.ai?.warnings?.length === 0
    ),
    "AI 성공 경로 undo로 후속 테스트용 clean 상태 복원"
  );
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
        warningHidden: document.querySelector("#caption-agent-warning")?.hidden,
        warningText: document.querySelector("#caption-agent-warning")?.textContent || ""
      };
    `);
    return (
      state.cueCount === 0 &&
      state.warningHidden === true &&
      state.warningText === ""
    ) ? state : false;
  }, "AI 성공 경로 undo 뒤 DOM clean 상태");
  const aiSuccessSmoke = {
    enabledClipIds: expectedAiClipIds,
    requests: aiSuccessFetch.requests,
    persisted: {
      status: aiSuccessProject.ai.status,
      cueCount: aiSuccessProject.subtitles.length,
      warningCount: aiSuccessProject.ai.warnings.length,
      cues: aiSuccessProject.subtitles.map((cue) => ({
        clipId: cue.clipId,
        text: cue.text,
        reviewRequired: cue.remoteMeta?.reviewRequired || false,
        placement: cue.remoteMeta?.placement || null
      }))
    },
    dom: aiSuccessDom,
    restored: {
      status: aiSuccessRestored.ai?.status || null,
      cueCount: aiSuccessRestored.subtitles?.length || 0,
      warningCount: aiSuccessRestored.ai?.warnings?.length || 0
    }
  };

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
    leftDrag.trace[0]?.trusted === true &&
      String(leftDrag.trace[0]?.target || "").includes("trim-handle"),
    `왼쪽 cue 손잡이가 신뢰된 pointerdown target이 아닙니다: ${JSON.stringify(leftDrag)}`
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
    rightDrag.trace[0]?.trusted === true &&
      String(rightDrag.trace[0]?.target || "").includes("trim-handle"),
    `오른쪽 cue 손잡이가 신뢰된 pointerdown target이 아닙니다: ${JSON.stringify(rightDrag)}`
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

  await clickElement('.clip-block[data-id="clip-selection-b"] .clip-block-body');
  await executeSync(`document.querySelector("#stage")?.focus();`);
  await pressKeyRepeated(KEY.ARROW_RIGHT, 30);
  await delay(180);
  await clickElement("#add-cue");
  const rangeCueProject = await waitForStoredProject(
    (project) => (
      project.subtitles.length === 2 &&
      project.subtitles.some((cue) => (
        cue.id !== cueId &&
        cue.clipId === "clip-selection-b" &&
        cue.startOffsetMs >= 2_800
      ))
    ),
    "리플 삭제 뒤 이동을 검증할 후행 자막 추가"
  );
  const rangeCue = rangeCueProject.subtitles.find((cue) => cue.id !== cueId);
  const cueTimelineStart = (candidateProject, candidateCue) => {
    const clip = candidateProject.clips.find((candidate) => candidate.id === candidateCue?.clipId);
    return clip ? clip.timelineStartMs + candidateCue.startOffsetMs : null;
  };
  const rangeCueTimelineStartBefore = cueTimelineStart(rangeCueProject, rangeCue);
  assert(
    Number.isFinite(rangeCueTimelineStartBefore),
    `후행 자막의 삭제 전 타임라인 시각을 찾지 못했습니다: ${JSON.stringify(rangeCue)}`
  );

  await clickElement('.clip-block[data-id="clip-selection-a"] .clip-block-body');
  await clickElement("#set-range-start");
  await clickElement('.clip-block[data-id="clip-selection-b"] .clip-block-body');
  await clickElement("#set-range-end");
  const toolbarRange = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        overlayHidden: document.querySelector("#timeline-range-selection")?.hidden,
        overlayValid: document.querySelector("#timeline-range-selection")?.classList.contains("valid"),
        startPressed: document.querySelector("#set-range-start")?.getAttribute("aria-pressed"),
        endPressed: document.querySelector("#set-range-end")?.getAttribute("aria-pressed"),
        deleteDisabled: document.querySelector("#delete-range")?.disabled,
        summary: document.querySelector("#timeline-range-summary")?.textContent || ""
      };
    `);
    return (
      state.overlayHidden === false &&
      state.overlayValid === true &&
      state.startPressed === "true" &&
      state.endPressed === "true" &&
      state.deleteDisabled === false &&
      state.summary.includes("삭제")
    ) ? state : false;
  }, "툴바 시작·끝점과 삭제 범위 overlay");
  await clickElement("#clear-range");
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        overlayHidden: document.querySelector("#timeline-range-selection")?.hidden,
        deleteDisabled: document.querySelector("#delete-range")?.disabled,
        clearHidden: document.querySelector("#clear-range")?.hidden
      };
    `);
    return state.overlayHidden && state.deleteDisabled && state.clearHidden ? state : false;
  }, "툴바 삭제 범위 선택 해제");

  await contextClickElement('.clip-block[data-id="clip-selection-b"]', { x: -35 });
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-set-range-start")?.hidden === false;`),
    "영상 우클릭 삭제 시작점 메뉴"
  );
  await clickElement("#context-set-range-start");
  await contextClickElement('.clip-block[data-id="clip-selection-b"]', { x: 35 });
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-set-range-end")?.hidden === false;`),
    "영상 우클릭 삭제 끝점 메뉴"
  );
  await clickElement("#context-set-range-end");
  const rangeHandleBeforeDrag = await waitUntil(async () => {
    const state = await executeSync(`
      const overlay = document.querySelector("#timeline-range-selection");
      const start = document.querySelector("#range-start-handle");
      const end = document.querySelector("#range-end-handle");
      return {
        valid: overlay?.classList.contains("valid"),
        width: Number.parseFloat(overlay?.style.width || "0"),
        startNow: Number(start?.getAttribute("aria-valuenow")),
        endNow: Number(end?.getAttribute("aria-valuenow")),
        startHidden: start?.hidden,
        endHidden: end?.hidden
      };
    `);
    return (
      state.valid &&
      state.width > 20 &&
      state.endNow - state.startNow >= 0.1 &&
      state.startHidden === false &&
      state.endHidden === false
    ) ? state : false;
  }, "영상 우클릭 구간과 접근 가능한 양끝 손잡이");
  const rangeStartDrag = await pointerDrag(
    "#range-start-handle",
    [{ x: 4, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }]
  );
  assert(
    rangeStartDrag.moves >= 3,
    `삭제 구간 시작 손잡이 drag pointermove가 부족합니다: ${JSON.stringify(rangeStartDrag)}`
  );
  const rangeEndBeforeNudge = await executeSync(`
    const handle = document.querySelector("#range-end-handle");
    handle?.focus();
    return Number(handle?.getAttribute("aria-valuenow"));
  `);
  await pressKey(KEY.ARROW_RIGHT);
  const rangeEndAfterNudge = await waitUntil(async () => {
    const value = await executeSync(
      `return Number(document.querySelector("#range-end-handle")?.getAttribute("aria-valuenow"));`
    );
    return value >= rangeEndBeforeNudge + 0.099 ? value : false;
  }, "삭제 구간 끝 손잡이 Arrow nudge");

  await executeSync(`document.querySelector("#cue-text")?.focus();`);
  await pressKey(KEY.ESCAPE);
  const inputEscapeRange = await executeSync(`
    return {
      activeId: document.activeElement?.id || null,
      valid: document.querySelector("#timeline-range-selection")?.classList.contains("valid"),
      hidden: document.querySelector("#timeline-range-selection")?.hidden
    };
  `);
  assert(
    inputEscapeRange.activeId === "cue-text" &&
      inputEscapeRange.valid &&
      inputEscapeRange.hidden === false,
    `텍스트 입력 중 Escape가 삭제 범위를 지웠습니다: ${JSON.stringify(inputEscapeRange)}`
  );
  await executeSync(`document.querySelector("#stage")?.focus();`);
  await pressKey(KEY.ESCAPE);
  await waitUntil(
    () => executeSync(`return document.querySelector("#timeline-range-selection")?.hidden === true;`),
    "Escape 삭제 범위 선택 해제"
  );

  await contextClickElement('.clip-block[data-id="clip-selection-b"]', { x: -35 });
  await clickElement("#context-set-range-start");
  await contextClickElement('.clip-block[data-id="clip-selection-b"]', { x: 35 });
  await clickElement("#context-set-range-end");
  await contextClickElement('.clip-block[data-id="clip-selection-b"]');
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-delete-range")?.hidden === false;`),
    "영상 우클릭 선택 구간 삭제 메뉴"
  );
  await pressKey(KEY.ESCAPE);
  const deleteRange = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        startMs: Math.round(Number(document.querySelector("#range-start-handle")?.getAttribute("aria-valuenow")) * 1000),
        endMs: Math.round(Number(document.querySelector("#range-end-handle")?.getAttribute("aria-valuenow")) * 1000),
        deleteDisabled: document.querySelector("#delete-range")?.disabled
      };
    `);
    return (
      state.endMs - state.startMs >= 100 &&
      state.deleteDisabled === false
    ) ? state : false;
  }, "키보드 삭제 전 유효한 범위");
  await executeSync(`document.querySelector("#range-end-handle")?.focus();`);
  await pressKey(KEY.DELETE);
  const rippleDeletedProject = await waitForStoredProject(
    (project) => {
      const movedCue = project.subtitles.find((cue) => cue.id === rangeCue.id);
      const movedStartMs = cueTimelineStart(project, movedCue);
      return (
        project.clips.length === 3 &&
        project.clips.filter((clip) => clip.selectionId === "selection-b").length === 2 &&
        Number.isFinite(movedStartMs) &&
        Math.abs(
          movedStartMs -
          (rangeCueTimelineStartBefore - (deleteRange.endMs - deleteRange.startMs))
        ) <= 1
      );
    },
    "내부 구간 리플 삭제와 후행 자막 동시 이동"
  );
  const rippleMovedCue = rippleDeletedProject.subtitles.find((cue) => cue.id === rangeCue.id);
  const rippleMovedCueTimelineStart = cueTimelineStart(rippleDeletedProject, rippleMovedCue);
  const rangeUiAfterDelete = await executeSync(`
    return {
      overlayHidden: document.querySelector("#timeline-range-selection")?.hidden,
      playheadNow: Number(document.querySelector("#playhead")?.getAttribute("aria-valuenow"))
    };
  `);
  assert(
    rangeUiAfterDelete.overlayHidden &&
      Math.abs(rangeUiAfterDelete.playheadNow * 1000 - deleteRange.startMs) <= 1,
    `리플 삭제 뒤 범위 해제·접합점 playhead 오류: ${JSON.stringify(rangeUiAfterDelete)}`
  );

  await clickElement("#undo");
  const rippleRestoredProject = await waitForStoredProject(
    (project) => {
      const restoredRangeCue = project.subtitles.find((cue) => cue.id === rangeCue.id);
      return (
        project.clips.length === rangeCueProject.clips.length &&
        project.clips.every((clip, index) => (
          clip.id === rangeCueProject.clips[index]?.id &&
          clip.sourceStartMs === rangeCueProject.clips[index]?.sourceStartMs &&
          clip.sourceEndMs === rangeCueProject.clips[index]?.sourceEndMs
        )) &&
        cueTimelineStart(project, restoredRangeCue) === rangeCueTimelineStartBefore
      );
    },
    "리플 삭제 한 번 Undo로 영상·자막 복원"
  );
  const restoredRangeCue = rippleRestoredProject.subtitles.find((cue) => cue.id === rangeCue.id);
  await contextClickElement(`.cue-block[data-id="${restoredRangeCue.id}"]`);
  await clickElement("#context-delete-cue");
  await waitForStoredProject(
    (project) => project.subtitles.length === 1 && project.subtitles[0].id === cueId,
    "리플 삭제 E2E 후행 자막 fixture 정리"
  );

  const transparentAssetPaste = await dispatchTransparentPngPaste();
  assert(
    !transparentAssetPaste?.error &&
      transparentAssetPaste.defaultPrevented === true &&
      transparentAssetPaste.size > 0 &&
      transparentAssetPaste.type === "image/png",
    `투명 PNG paste 이벤트를 처리하지 못했습니다: ${JSON.stringify(transparentAssetPaste)}`
  );
  const assetProject = await waitForStoredProject(
    (project) => (
      project.imageAssets?.length === 1 &&
      project.selectedImageAssetId === project.imageAssets[0]?.id &&
      project.imageAssets[0]?.source?.kind === "blob-key"
    ),
    "투명 PNG 붙여넣기와 프로젝트 autosave"
  );
  const imageAssetId = assetProject.imageAssets[0].id;
  const assetUi = await waitUntil(async () => {
    const state = await executeSync(`
      const overlay = document.querySelector(
        '#image-asset-overlays .image-asset-overlay[data-asset-id="' + arguments[0] + '"]'
      );
      return {
        block: Boolean(document.querySelector('.asset-block[data-id="' + arguments[0] + '"]')),
        editorHidden: document.querySelector("#asset-editor")?.hidden,
        assetTabSelected: document.querySelector("#asset-mode-tab")?.getAttribute("aria-selected"),
        overlay: Boolean(overlay),
        overlayImageLoaded: Boolean(overlay?.querySelector("img")?.complete),
        thumbnailLoaded: Boolean(document.querySelector("#asset-thumbnail")?.complete)
      };
    `, [imageAssetId]);
    return (
      state.block &&
      state.editorHidden === false &&
      state.assetTabSelected === "true" &&
      state.overlay &&
      state.overlayImageLoaded &&
      state.thumbnailLoaded
    ) ? state : false;
  }, "투명 이미지 에셋 타임라인·미리보기·속성 UI");
  const assetBlobAudit = await executeAsync(`
    const [databaseName, projectId, assetId] = arguments;
    const done = arguments[arguments.length - 1];
    const open = indexedDB.open(databaseName);
    open.onerror = () => done({ error: String(open.error || "IndexedDB open failed") });
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("image-assets", "readonly");
      const request = transaction.objectStore("image-assets").get([projectId, assetId]);
      request.onerror = () => done({ error: String(request.error || "asset Blob read failed") });
      request.onsuccess = async () => {
        try {
          const blob = request.result;
          const bitmap = await createImageBitmap(blob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d");
          context.drawImage(bitmap, 0, 0);
          const cornerAlpha = context.getImageData(0, 0, 1, 1).data[3];
          const centerAlpha = context.getImageData(12, 12, 1, 1).data[3];
          bitmap.close();
          database.close();
          done({
            isBlob: blob instanceof Blob,
            type: blob.type,
            size: blob.size,
            width: canvas.width,
            height: canvas.height,
            cornerAlpha,
            centerAlpha
          });
        } catch (error) {
          done({ error: error instanceof Error ? error.message : String(error) });
        }
      };
    };
  `, [DATABASE_NAME, PROJECT_ID, imageAssetId]);
  assert(
    !assetBlobAudit?.error &&
      assetBlobAudit.isBlob &&
      assetBlobAudit.type === "image/png" &&
      assetBlobAudit.width === 24 &&
      assetBlobAudit.height === 24 &&
      assetBlobAudit.cornerAlpha === 0 &&
      assetBlobAudit.centerAlpha > 0 &&
      assetBlobAudit.centerAlpha < 255,
    `IndexedDB 투명 PNG Blob 보존 실패: ${JSON.stringify(assetBlobAudit)}`
  );

  const overlappingAssetPaste = await dispatchTransparentPngPaste();
  assert(
    !overlappingAssetPaste?.error &&
      overlappingAssetPaste.defaultPrevented === true &&
      overlappingAssetPaste.size > 0,
    `완전 겹침 검증용 PNG paste 이벤트를 처리하지 못했습니다: ${JSON.stringify(overlappingAssetPaste)}`
  );
  const overlappingAssetProject = await waitForStoredProject(
    (project) => {
      const first = project.imageAssets?.find((asset) => asset.id === imageAssetId);
      const second = project.imageAssets?.find((asset) => asset.id !== imageAssetId);
      return (
        project.imageAssets?.length === 2 &&
        first &&
        second &&
        first.clipId === second.clipId &&
        first.startOffsetMs === second.startOffsetMs &&
        first.endOffsetMs === second.endOffsetMs
      );
    },
    "완전히 겹치는 두 이미지 에셋 autosave"
  );
  const overlappingImageAssetId = overlappingAssetProject.imageAssets.find(
    (asset) => asset.id !== imageAssetId
  ).id;
  const overlappingAssetLayout = await waitUntil(async () => {
    const state = await executeSync(`
      const first = document.querySelector(
        '.asset-block[data-id="' + arguments[0] + '"]'
      );
      const second = document.querySelector(
        '.asset-block[data-id="' + arguments[1] + '"]'
      );
      const track = document.querySelector("#asset-track");
      const label = document.querySelector(".asset-track-label");
      if (!first || !second || !track || !label) {
        return null;
      }
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      return {
        firstSubrow: Number(first.dataset.subrow),
        secondSubrow: Number(second.dataset.subrow),
        firstTop: Number.parseFloat(getComputedStyle(first).top),
        secondTop: Number.parseFloat(getComputedStyle(second).top),
        verticallySeparated:
          firstRect.bottom <= secondRect.top || secondRect.bottom <= firstRect.top,
        trackHeight: track.getBoundingClientRect().height,
        labelHeight: label.getBoundingClientRect().height,
        assetTrackHeightVariable: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--asset-track-height")
        )
      };
    `, [imageAssetId, overlappingImageAssetId]);
    return (
      state &&
      state.firstSubrow !== state.secondSubrow &&
      state.firstTop !== state.secondTop &&
      state.verticallySeparated &&
      state.trackHeight > 54 &&
      Math.abs(state.trackHeight - state.labelHeight) < 0.01 &&
      Math.abs(state.trackHeight - state.assetTrackHeightVariable) < 0.01
    ) ? state : false;
  }, "완전히 겹치는 에셋의 최소 subrow 분리와 트랙 높이 확장");

  await clickElement(`.asset-block[data-id="${imageAssetId}"] .asset-block-body`);
  await waitForStoredProject(
    (project) => project.selectedImageAssetId === imageAssetId,
    "완전 겹침 첫 번째 에셋 선택"
  );
  await clickElement(`.asset-block[data-id="${overlappingImageAssetId}"] .asset-block-body`);
  await waitForStoredProject(
    (project) => project.selectedImageAssetId === overlappingImageAssetId,
    "완전 겹침 두 번째 에셋 선택"
  );
  await contextClickElement(`.asset-block[data-id="${overlappingImageAssetId}"]`);
  await waitUntil(
    () => executeSync(`return document.querySelector("#context-delete-asset")?.hidden === false;`),
    "완전 겹침 두 번째 에셋 우클릭 메뉴"
  );
  await clickElement("#context-delete-asset");
  await waitForStoredProject(
    (project) => (
      project.imageAssets?.length === 1 &&
      project.imageAssets[0]?.id === imageAssetId
    ),
    "완전 겹침 검증용 두 번째 에셋 삭제"
  );
  const compactAssetTrack = await waitUntil(async () => {
    const state = await executeSync(`
      const track = document.querySelector("#asset-track");
      const block = document.querySelector(
        '.asset-block[data-id="' + arguments[0] + '"]'
      );
      return {
        trackHeight: track?.getBoundingClientRect().height || 0,
        subrow: Number(block?.dataset.subrow),
        top: Number.parseFloat(block ? getComputedStyle(block).top : "NaN")
      };
    `, [imageAssetId]);
    return (
      Math.abs(state.trackHeight - 54) < 0.01 &&
      state.subrow === 0 &&
      state.top === 7
    ) ? state : false;
  }, "겹침 해소 뒤 기본 에셋 트랙 높이 복원");
  await clickElement(`.asset-block[data-id="${imageAssetId}"] .asset-block-body`);
  await waitForStoredProject(
    (project) => project.selectedImageAssetId === imageAssetId,
    "겹침 검증 뒤 첫 번째 에셋 선택 복원"
  );

  const assetBeforeTrim = assetProject.imageAssets[0];
  const assetLeftDrag = await pointerDrag(
    `.asset-block[data-id="${imageAssetId}"] .trim-handle.left`,
    [{ x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }]
  );
  assert(
    assetLeftDrag.moves >= 3 &&
      assetLeftDrag.trace[0]?.trusted === true &&
      String(assetLeftDrag.trace[0]?.target || "").includes("trim-handle"),
    `에셋 왼쪽 손잡이의 신뢰된 drag가 없습니다: ${JSON.stringify(assetLeftDrag)}`
  );
  const assetAfterLeftTrimProject = await waitForStoredProject(
    (project) => project.imageAssets.some((asset) => (
      asset.id === imageAssetId && asset.startOffsetMs >= assetBeforeTrim.startOffsetMs + 50
    )),
    "에셋 왼쪽 손잡이 drag autosave"
  );
  const assetAfterLeftTrim = assetAfterLeftTrimProject.imageAssets.find(
    (asset) => asset.id === imageAssetId
  );
  const assetRightDrag = await pointerDrag(
    `.asset-block[data-id="${imageAssetId}"] .trim-handle.right`,
    [{ x: -10, y: 0 }, { x: -10, y: 0 }, { x: -10, y: 0 }]
  );
  assert(
    assetRightDrag.moves >= 3 &&
      assetRightDrag.trace[0]?.trusted === true &&
      String(assetRightDrag.trace[0]?.target || "").includes("trim-handle"),
    `에셋 오른쪽 손잡이의 신뢰된 drag가 없습니다: ${JSON.stringify(assetRightDrag)}`
  );
  await waitForStoredProject(
    (project) => project.imageAssets.some((asset) => (
      asset.id === imageAssetId &&
      asset.endOffsetMs <= assetAfterLeftTrim.endOffsetMs - 50 &&
      asset.endOffsetMs > asset.startOffsetMs
    )),
    "에셋 오른쪽 손잡이 drag autosave"
  );

  await clickElement(`.asset-block[data-id="${imageAssetId}"] .asset-block-body`);
  await waitUntil(
    () => executeSync(
      `return Boolean(document.querySelector(
        '#image-asset-overlays .image-asset-overlay[data-asset-id="' + arguments[0] + '"]'
      ));`,
      [imageAssetId]
    ),
    "트림 뒤 이미지 에셋 overlay 복원"
  );
  const assetOverlayDrag = await pointerDrag(
    `#image-asset-overlays .image-asset-overlay[data-asset-id="${imageAssetId}"]`,
    [{ x: 18, y: -12 }, { x: 18, y: -12 }, { x: 18, y: -12 }]
  );
  assert(
    assetOverlayDrag.moves >= 3 && assetOverlayDrag.trace[0]?.trusted === true,
    `이미지 에셋 overlay의 신뢰된 drag가 없습니다: ${JSON.stringify(assetOverlayDrag)}`
  );
  await executeSync(`
    const scale = document.querySelector("#asset-scale");
    const opacity = document.querySelector("#asset-opacity");
    scale.value = "135";
    scale.dispatchEvent(new Event("input", { bubbles: true }));
    scale.dispatchEvent(new Event("change", { bubbles: true }));
    opacity.value = "42";
    opacity.dispatchEvent(new Event("input", { bubbles: true }));
    opacity.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  const styledAssetProject = await waitForStoredProject(
    (project) => project.imageAssets.some((asset) => (
      asset.id === imageAssetId &&
      asset.x > 0.5 &&
      asset.y < 0.5 &&
      Math.abs(asset.scale - 1.35) < 0.001 &&
      Math.abs(asset.opacity - 0.42) < 0.001
    )),
    "에셋 위치·크기·불투명도 autosave"
  );

  await contextClickElement(`.asset-block[data-id="${imageAssetId}"]`);
  const assetContextMenu = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        menuHidden: document.querySelector("#timeline-context-menu")?.hidden,
        pasteHidden: document.querySelector("#context-paste-asset")?.hidden,
        pickHidden: document.querySelector("#context-pick-asset")?.hidden,
        deleteHidden: document.querySelector("#context-delete-asset")?.hidden
      };
    `);
    return (
      state.menuHidden === false &&
      state.pasteHidden === false &&
      state.pickHidden === false &&
      state.deleteHidden === false
    ) ? state : false;
  }, "에셋 우클릭 붙여넣기·파일·삭제 메뉴");
  await pressKey(KEY.ESCAPE);

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
  const audioClip = quietAudioProject.clips.find(
    (clip) => clip.id === quietAudioProject.audioRegions[0]?.clipId
  );
  assert(audioClip, "정밀 음성 미리보기용 clip을 찾지 못했습니다.");
  const preciseAudioStartOffsetMs = 500;
  const preciseAudioEndOffsetMs = 620;
  const preciseAudioStartMs = audioClip.timelineStartMs + preciseAudioStartOffsetMs;
  const preciseAudioEndMs = audioClip.timelineStartMs + preciseAudioEndOffsetMs;
  await executeSync(`
    const start = document.querySelector("#audio-start");
    const end = document.querySelector("#audio-end");
    start.value = arguments[0];
    start.dispatchEvent(new Event("change", { bubbles: true }));
    end.value = arguments[1];
    end.dispatchEvent(new Event("change", { bubbles: true }));
    const volume = document.querySelector("#audio-volume");
    volume.value = "0";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    volume.dispatchEvent(new Event("change", { bubbles: true }));
  `, [
    formatEditorTime(preciseAudioStartMs),
    formatEditorTime(preciseAudioEndMs)
  ]);
  const preciseAudioProject = await waitForStoredProject(
    (project) => (
      project.audioRegions[0]?.startOffsetMs === preciseAudioStartOffsetMs &&
      project.audioRegions[0]?.endOffsetMs === preciseAudioEndOffsetMs &&
      project.audioRegions[0]?.gain === 0
    ),
    "120ms 정밀 음성 구간 autosave"
  );
  const preciseAudioRegion = preciseAudioProject.audioRegions[0];
  const preciseAudioMediaOriginMs = Number(preciseAudioProject.mediaAsset?.mediaOriginMs) || 0;
  const preciseAudioPreviewStartSeconds = (
    preciseAudioMediaOriginMs +
    audioClip.sourceStartMs +
    preciseAudioRegion.startOffsetMs
  ) / 1_000;
  const preciseAudioPreviewEndSeconds = (
    preciseAudioMediaOriginMs +
    audioClip.sourceStartMs +
    preciseAudioRegion.endOffsetMs
  ) / 1_000;
  await executeAsync(`
    const video = document.querySelector("#preview-video");
    const target = arguments[0];
    const done = arguments[arguments.length - 1];
    video.pause();
    const finish = () => {
      video.removeEventListener("seeked", finish);
      video.dispatchEvent(new Event("timeupdate"));
      requestAnimationFrame(() => done({
        currentTime: video.currentTime,
        paused: video.paused,
        volume: video.volume
      }));
    };
    video.addEventListener("seeked", finish, { once: true });
    video.currentTime = target;
    if (!video.seeking) {
      finish();
    }
  `, [preciseAudioPreviewStartSeconds - 0.08]);
  const preciseAudioTraceSetup = await executeSync(`
    const video = document.querySelector("#preview-video");
    let volumePrototype = video;
    let volumeDescriptor = null;
    while (volumePrototype && !volumeDescriptor) {
      volumeDescriptor = Object.getOwnPropertyDescriptor(volumePrototype, "volume");
      volumePrototype = Object.getPrototypeOf(volumePrototype);
    }
    if (!volumeDescriptor?.get || !volumeDescriptor?.set) {
      throw new Error("HTMLMediaElement volume descriptor를 찾지 못했습니다.");
    }
    globalThis.__kirinukiPreciseAudioTrace = {
      transitions: [],
      startedAt: video.currentTime,
      lastAppliedVolume: volumeDescriptor.get.call(video)
    };
    Object.defineProperty(video, "volume", {
      configurable: true,
      get() {
        return volumeDescriptor.get.call(video);
      },
      set(value) {
        const trace = globalThis.__kirinukiPreciseAudioTrace;
        if (trace && value !== trace.lastAppliedVolume) {
          trace.lastAppliedVolume = value;
          trace.transitions.push({
            currentTime: video.currentTime,
            volume: value
          });
        }
        volumeDescriptor.set.call(video, value);
      }
    });
    return {
      currentTime: video.currentTime,
      paused: video.paused,
      volume: video.volume
    };
  `);
  assert(
    preciseAudioTraceSetup.paused &&
      preciseAudioTraceSetup.volume === 1 &&
      preciseAudioTraceSetup.currentTime < preciseAudioPreviewStartSeconds,
    `정밀 음성 미리보기 사전 상태가 잘못됐습니다: ${JSON.stringify(preciseAudioTraceSetup)}`
  );
  await clickElement("#play-toggle");
  await waitUntil(
    () => executeSync(
      `return document.querySelector("#preview-video").currentTime >= arguments[0];`,
      [preciseAudioPreviewEndSeconds + 0.08]
    ),
    "120ms 음성 구간 재생 통과",
    { timeout: 5_000 }
  );
  const preciseAudioPreviewClock = await executeSync(`
    const video = document.querySelector("#preview-video");
    video.pause();
    const trace = globalThis.__kirinukiPreciseAudioTrace;
    delete video.volume;
    delete globalThis.__kirinukiPreciseAudioTrace;
    return {
      ...trace,
      finishedAt: video.currentTime,
      finalVolume: video.volume,
      paused: video.paused
    };
  `);
  const preciseAudioEnter = preciseAudioPreviewClock.transitions.find(
    (transition) => transition.volume === 0
  );
  const preciseAudioExit = preciseAudioPreviewClock.transitions.find(
    (transition) => (
      transition.volume === 1 &&
      transition.currentTime >= preciseAudioPreviewStartSeconds
    )
  );
  assert(
    preciseAudioEnter &&
      preciseAudioEnter.currentTime >= preciseAudioPreviewStartSeconds - 0.02 &&
      preciseAudioEnter.currentTime <= preciseAudioPreviewStartSeconds + 0.05,
    `120ms 음소거 진입이 50ms 안에 적용되지 않았습니다: ${JSON.stringify({
      preciseAudioPreviewStartSeconds,
      preciseAudioPreviewClock
    })}`
  );
  assert(
    preciseAudioExit &&
      preciseAudioExit.currentTime >= preciseAudioPreviewEndSeconds - 0.02 &&
      preciseAudioExit.currentTime <= preciseAudioPreviewEndSeconds + 0.05,
    `120ms 음소거 해제가 50ms 안에 적용되지 않았습니다: ${JSON.stringify({
      preciseAudioPreviewEndSeconds,
      preciseAudioPreviewClock
    })}`
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
    audioGain: quietAudioProject.audioRegions[0]?.gain,
    preciseAudioPreviewClock: {
      region: {
        startOffsetMs: preciseAudioRegion.startOffsetMs,
        endOffsetMs: preciseAudioRegion.endOffsetMs,
        gain: preciseAudioRegion.gain
      },
      expected: {
        startSeconds: preciseAudioPreviewStartSeconds,
        endSeconds: preciseAudioPreviewEndSeconds
      },
      trace: preciseAudioPreviewClock
    },
    asset: {
      id: imageAssetId,
      ui: assetUi,
      blob: assetBlobAudit,
      style: styledAssetProject.imageAssets.find((asset) => asset.id === imageAssetId),
      contextMenu: assetContextMenu,
      overlappingLayout: {
        ...overlappingAssetLayout,
        compact: compactAssetTrack
      },
      trim: {
        left: assetLeftDrag,
        right: assetRightDrag
      }
    }
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
  const liveClipTrimProbeSetup = await executeSync(`
    const cue = document.querySelector('.cue-block[data-id="' + arguments[0] + '"]');
    globalThis.__kirinukiE2eLiveClipTrimGeometry = [];
    globalThis.__kirinukiE2eLiveClipTrimObserver?.disconnect();
    globalThis.__kirinukiE2eLiveClipTrimObserver = new MutationObserver(() => {
      globalThis.__kirinukiE2eLiveClipTrimGeometry.push({
        left: cue?.style.left || null,
        width: cue?.style.width || null,
        hidden: cue?.hidden ?? null
      });
    });
    if (cue) {
      globalThis.__kirinukiE2eLiveClipTrimObserver.observe(cue, {
        attributes: true,
        attributeFilter: ["style", "hidden"]
      });
    }
    return {
      ready: Boolean(cue),
      left: cue?.style.left || null,
      width: cue?.style.width || null,
      hidden: cue?.hidden ?? null
    };
  `, [cueId]);
  assert(
    liveClipTrimProbeSetup.ready,
    `clip trim 중 자막 geometry probe를 준비하지 못했습니다: ${JSON.stringify(liveClipTrimProbeSetup)}`
  );
  const clipTrimRoundTrip = await pointerDrag(
    '.clip-block[data-id="clip-selection-a"] .trim-handle.left',
    [{ x: 160, y: 0, duration: 180 }, { x: -160, y: 0, duration: 180 }]
  );
  await delay(50);
  const liveClipTrimGeometry = await executeSync(`
    globalThis.__kirinukiE2eLiveClipTrimObserver?.disconnect();
    delete globalThis.__kirinukiE2eLiveClipTrimObserver;
    return globalThis.__kirinukiE2eLiveClipTrimGeometry || [];
  `);
  assert(
    liveClipTrimGeometry.some((entry) => (
      entry.hidden ||
      entry.left !== liveClipTrimProbeSetup.left ||
      entry.width !== liveClipTrimProbeSetup.width
    )),
    `clip 손잡이 drag 중 자막 geometry가 영상과 함께 갱신되지 않았습니다: ${JSON.stringify({
      before: liveClipTrimProbeSetup,
      changes: liveClipTrimGeometry
    })}`
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

  await clickElement(
    '.clip-item[data-id="clip-selection-b"] .clip-select'
  );
  const clipGroupAnchorBefore = await waitForStoredProject(
    (candidate) => {
      const selected = candidate.clips.find(
        (clip) => clip.id === "clip-selection-b"
      );
      return (
        candidate.selectedClipId === selected?.id
        && candidate.playheadMs === selected.timelineStartMs
      );
    },
    "묶음 이동 전 현재 컷 재생헤드 앵커"
  );
  await clickElement(
    '.clip-item[data-id="clip-selection-b"] .clip-group-checkbox'
  );
  await clickElement(
    '.clip-item[data-id="clip-selection-a"] .clip-group-checkbox'
  );
  const clipGroupReady = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        checked: [...document.querySelectorAll(".clip-group-checkbox:checked")]
          .map((checkbox) => checkbox.closest(".clip-item")?.dataset.id),
        status: document.querySelector("#clip-group-status")?.textContent || "",
        upDisabled: document.querySelector("#move-selected-clips-up")?.disabled,
        downDisabled: document.querySelector("#move-selected-clips-down")?.disabled
      };
    `);
    return (
      state.checked.join(",") === "clip-selection-b,clip-selection-a" &&
      state.status.includes("2개") &&
      state.upDisabled === true &&
      state.downDisabled === false
    ) ? state : false;
  }, "두 컷 체크와 묶음 이동 경계 상태");

  await clickElement("#move-selected-clips-down");
  const clipGroupMovedDown = await waitForStoredProject(
    (candidate) => {
      const anchored = candidate.clips.find(
        (clip) => clip.id === "clip-selection-b"
      );
      return (
        Boolean(anchored)
        &&
        candidate.clips.map((clip) => clip.id).join(",") ===
        "clip-selection-c,clip-selection-b,clip-selection-a"
        && candidate.selectedClipId === anchored?.id
        && candidate.playheadMs === anchored.timelineStartMs
      );
    },
    "체크한 두 컷의 상대 순서 보존 아래 이동"
  );
  const clipGroupDownDom = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        order: [...document.querySelectorAll("#clip-list .clip-item")]
          .map((item) => item.dataset.id),
        checked: [...document.querySelectorAll(".clip-group-checkbox:checked")]
          .map((checkbox) => checkbox.closest(".clip-item")?.dataset.id),
        selectedId: document.querySelector(".clip-item.selected")?.dataset.id || null,
        activeId: document.activeElement?.id || null
      };
    `);
    return (
      state.order.join(",") === "clip-selection-c,clip-selection-b,clip-selection-a" &&
      state.checked.join(",") === "clip-selection-b,clip-selection-a" &&
      state.selectedId === "clip-selection-b" &&
      state.activeId === "move-selected-clips-up"
    ) ? state : false;
  }, "묶음 아래 이동 DOM·체크·focus 보존");

  await clickElement("#move-selected-clips-up");
  const clipGroupRestored = await waitForStoredProject(
    (candidate) => (
      candidate.clips.map((clip) => clip.id).join(",") ===
      "clip-selection-b,clip-selection-a,clip-selection-c"
    ),
    "체크한 두 컷 묶음 위 이동으로 원래 순서 복원"
  );
  await clickElement("#clear-clip-group-selection");
  const clipGroupCleared = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        checkedCount: document.querySelectorAll(".clip-group-checkbox:checked").length,
        status: document.querySelector("#clip-group-status")?.textContent || "",
        clearDisabled: document.querySelector("#clear-clip-group-selection")?.disabled
      };
    `);
    return (
      state.checkedCount === 0 &&
      state.status.includes("해제") &&
      state.clearDisabled === true
    ) ? state : false;
  }, "컷 묶음 선택 전체 해제");
  assert(
    !Object.hasOwn(clipGroupMovedDown, "clipGroupSelection") &&
    !Object.hasOwn(clipGroupRestored, "clipGroupSelection"),
    "컷 체크 UI 상태가 프로젝트에 저장되었습니다."
  );
  const clipGroupMoveSmoke = {
    anchorBefore: {
      selectedClipId: clipGroupAnchorBefore.selectedClipId,
      playheadMs: clipGroupAnchorBefore.playheadMs
    },
    ready: clipGroupReady,
    movedDownOrder: clipGroupMovedDown.clips.map((clip) => clip.id),
    downDom: clipGroupDownDom,
    restoredOrder: clipGroupRestored.clips.map((clip) => clip.id),
    cleared: clipGroupCleared
  };

  await clickElement("#create-local-draft");
  const manualLocalDraft = await waitUntil(async () => {
    const drafts = await readLocalDrafts();
    return (
      drafts.length === 1 &&
      drafts[0].reason === "manual" &&
      drafts[0].project?.imageAssets?.some(
        (asset) => asset.id === imageAssetId
      )
    ) ? drafts[0] : false;
  }, "수동 로컬 임시저장");
  const manualDraftStatus = await executeSync(`
    return document.querySelector("#local-draft-status")
      ?.textContent?.trim() || "";
  `);
  assert(
    !manualDraftStatus.includes("마지막 자동"),
    `자동저장 전 상태가 자동저장 완료로 표시됩니다: ${manualDraftStatus}`
  );

  const beforeRestoreProjectName = "복원 직전 E2E 상태";
  await clearAndType("#project-name", beforeRestoreProjectName);
  await clickElement(`.asset-block[data-id="${imageAssetId}"] .asset-block-body`);
  await clickElement("#delete-asset");
  const beforeRestoreProject = await waitForStoredProject(
    (candidate) => (
      candidate.name === beforeRestoreProjectName &&
      !candidate.imageAssets?.some((asset) => asset.id === imageAssetId)
    ),
    "임시저장 뒤 현재 프로젝트 변경"
  );

  await delay(3_500);
  const snapshotProtectedAssetKeys = await readImageAssetBlobKeys();
  assert(
    snapshotProtectedAssetKeys.includes(imageAssetId),
    `임시저장만 참조하는 이미지 Blob이 조기 삭제됐습니다: ${JSON.stringify(
      snapshotProtectedAssetKeys
    )}`
  );

  await executeSync(`
    const originalNow = Date.now;
    const advancedNow = originalNow() + 5 * 60 * 1000 + 1;
    Date.now = () => advancedNow;
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", {
        persisted: false
      }));
    } finally {
      Date.now = originalNow;
    }
  `);
  const autoLocalDrafts = await waitUntil(async () => {
    const drafts = await readLocalDrafts();
    return (
      drafts.length === 2 &&
      drafts.some((draft) => (
        draft.reason === "auto" &&
        draft.project?.name === beforeRestoreProjectName &&
        !draft.project?.imageAssets?.some(
          (asset) => asset.id === imageAssetId
        )
      ))
    ) ? drafts : false;
  }, "5분 경과 visibility 복귀 자동 임시저장");
  await delay(350);
  const stableAutomaticDrafts = await readLocalDrafts();
  assert(
    stableAutomaticDrafts.length === 2 &&
      stableAutomaticDrafts.filter((draft) => draft.reason === "auto").length === 1,
    `동시 lifecycle 이벤트가 자동 임시저장을 중복 생성했습니다: ${JSON.stringify(
      stableAutomaticDrafts.map((draft) => draft.reason)
    )}`
  );

  await clickElement("#open-local-drafts");
  const localDraftDialogOpened = await waitUntil(async () => {
    const state = await executeSync(`
      const dialog = document.querySelector("#local-draft-dialog");
      return {
        hidden: dialog?.hidden,
        open: dialog?.open,
        options: document.querySelectorAll(
          '#local-draft-list input[name="local-draft-choice"]'
        ).length,
        activeInside: Boolean(dialog?.contains(document.activeElement)),
        restoreDisabled: document.querySelector(
          "#restore-local-draft"
        )?.disabled
      };
    `);
    return (
      state.hidden === false &&
      state.open === true &&
      state.options === 2 &&
      state.activeInside &&
      state.restoreDisabled
    ) ? state : false;
  }, "최근 로컬 임시저장 dialog");

  await pressKey(KEY.ESCAPE);
  let localDraftDialogEscaped;
  try {
    localDraftDialogEscaped = await waitUntil(async () => {
      const state = await executeSync(`
        const dialog = document.querySelector("#local-draft-dialog");
        return {
          hidden: dialog?.hidden,
          open: dialog?.open,
          activeId: document.activeElement?.id || null
        };
      `);
      return (
        state.hidden === true &&
        state.open === false &&
        state.activeId === "open-local-drafts"
      ) ? state : false;
    }, "로컬 임시저장 dialog Escape와 focus 복원");
  } catch (error) {
    const actual = await executeSync(`
      const dialog = document.querySelector("#local-draft-dialog");
      return {
        hidden: dialog?.hidden,
        open: dialog?.open,
        activeId: document.activeElement?.id || null,
        activeTag: document.activeElement?.tagName || null,
        openerDisabled: document.querySelector("#open-local-drafts")?.disabled,
        restoreDisabled: document.querySelector("#restore-local-draft")?.disabled
      };
    `);
    throw new Error(`${error.message}: ${JSON.stringify(actual)}`);
  }

  await clickElement("#open-local-drafts");
  await waitUntil(
    () => executeSync(
      `return document.querySelector("#local-draft-dialog")?.open === true;`
    ),
    "로컬 임시저장 dialog 재개방"
  );
  await clickElement(
    `#local-draft-list input[value="${manualLocalDraft.id}"]`
  );
  await waitUntil(
    () => executeSync(
      `return document.querySelector("#restore-local-draft")?.disabled === false;`
    ),
    "임시저장 복원 선택"
  );
  await clickElement("#restore-local-draft");

  const restoredFromLocalDraft = await waitForStoredProject(
    (candidate) => (
      candidate.name === manualLocalDraft.project.name &&
      candidate.imageAssets?.some((asset) => asset.id === imageAssetId)
    ),
    "복원 직전 저장 뒤 선택 임시저장 복원"
  );
  const draftsAfterRestore = await waitUntil(async () => {
    const drafts = await readLocalDrafts();
    const preRestore = drafts.find(
      (draft) => draft.reason === "pre-restore"
    );
    return (
      drafts.length === 3 &&
      preRestore?.restoredFromDraftId === manualLocalDraft.id &&
      preRestore.project?.name === beforeRestoreProjectName &&
      !preRestore.project?.imageAssets?.some(
        (asset) => asset.id === imageAssetId
      )
    ) ? drafts : false;
  }, "불러오기 직전 현재 상태 자동 임시저장");
  const localDraftRestoreUi = await waitUntil(async () => {
    const state = await executeSync(`
      const dialog = document.querySelector("#local-draft-dialog");
      return {
        hidden: dialog?.hidden,
        open: dialog?.open,
        activeId: document.activeElement?.id || null,
        assetCount: document.querySelectorAll(
          "#asset-track .asset-block"
        ).length,
        projectName: document.querySelector("#project-name")?.value || "",
        draftStatus: document.querySelector(
          "#local-draft-status"
        )?.textContent?.trim() || ""
      };
    `);
    return (
      state.hidden === true &&
      state.open === false &&
      state.activeId === "open-local-drafts" &&
      state.assetCount === 1 &&
      state.projectName === manualLocalDraft.project.name &&
      state.draftStatus.includes("최근 3/5개")
    ) ? state : false;
  }, "임시저장 복원 DOM과 focus");
  await clickElement(`.asset-block[data-id="${imageAssetId}"] .asset-block-body`);
  const restoredDraftImage = await waitUntil(async () => {
    const state = await executeSync(`
      const overlay = document.querySelector(
        '#image-asset-overlays .image-asset-overlay[data-asset-id="${imageAssetId}"]'
      );
      const image = overlay?.querySelector("img");
      const thumbnail = document.querySelector("#asset-thumbnail");
      return {
        overlayVisible: Boolean(overlay && !overlay.hidden),
        overlayLoaded: Boolean(image?.complete && image.naturalWidth > 0),
        thumbnailLoaded: Boolean(
          thumbnail?.complete && thumbnail.naturalWidth > 0
        )
      };
    `);
    return (
      state.overlayVisible &&
      state.overlayLoaded &&
      state.thumbnailLoaded
    ) ? state : false;
  }, "임시저장 이미지 Blob 재연결");
  const localDraftSmoke = {
    manual: {
      id: manualLocalDraft.id,
      reason: manualLocalDraft.reason,
      projectName: manualLocalDraft.project.name
    },
    autoReasons: autoLocalDrafts.map((draft) => draft.reason),
    protectedAssetKeys: snapshotProtectedAssetKeys,
    dialogOpened: localDraftDialogOpened,
    dialogEscaped: localDraftDialogEscaped,
    restoredProjectName: restoredFromLocalDraft.name,
    draftsAfterRestore: draftsAfterRestore.map((draft) => ({
      id: draft.id,
      reason: draft.reason,
      restoredFromDraftId: draft.restoredFromDraftId,
      projectName: draft.project?.name
    })),
    restoreUi: localDraftRestoreUi,
    restoredImage: restoredDraftImage,
    beforeRestoreProject: {
      name: beforeRestoreProject.name,
      imageAssets: beforeRestoreProject.imageAssets?.length || 0
    }
  };

  const finalPersistedCue = hotSeedProject.subtitles.find((cue) => cue.id === cueId);
  assert(finalPersistedCue, "hot seed 저장본에서 자막을 찾지 못했습니다.");
  const finalPersistedAsset = hotSeedProject.imageAssets?.find((asset) => asset.id === imageAssetId);
  assert(finalPersistedAsset, "hot seed 저장본에서 이미지 에셋을 찾지 못했습니다.");

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
    asset: finalPersistedAsset,
    mediaName: reorderedProject.mediaAsset?.name
  };

  await delay(400);
  await webdriver("POST", `/session/${sessionId}/url`, { url: editorUrl });
  let restored;
  try {
    restored = await waitForStoredProject((project) => {
      const cue = project.subtitles.find((candidate) => candidate.id === cueId);
      const asset = project.imageAssets?.find((candidate) => candidate.id === imageAssetId);
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
        asset?.startOffsetMs === expected.asset.startOffsetMs &&
        asset?.endOffsetMs === expected.asset.endOffsetMs &&
        Math.abs(asset.x - expected.asset.x) < 0.0001 &&
        Math.abs(asset.y - expected.asset.y) < 0.0001 &&
        Math.abs(asset.scale - expected.asset.scale) < 0.0001 &&
        Math.abs(asset.opacity - expected.asset.opacity) < 0.0001 &&
        asset.source?.kind === "blob-key" &&
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
        assetCount: document.querySelectorAll("#asset-track .asset-block").length,
        mediaName: document.querySelector("#media-name")?.textContent || ""
      };
    `);
    return (
      state.clipOrder.join(",") === expected.clipOrder.join(",") &&
      state.cueText === expected.text &&
      state.cueCount === 1 &&
      state.assetCount === 1 &&
      state.mediaName === expected.mediaName
    ) ? state : false;
  }, "reload 후 editor DOM 복원");
  let prunedImageAssetBlobKeys;
  try {
    prunedImageAssetBlobKeys = await waitUntil(async () => {
      const keys = await readImageAssetBlobKeys();
      return keys.length === 1 && keys[0] === imageAssetId ? keys : false;
    }, "reload 뒤 실행 취소 이력에서 사라진 이미지 Blob 정리", {
      timeout: 12_000,
      interval: 250
    });
  } catch (error) {
    const actualKeys = await readImageAssetBlobKeys();
    const tabUrls = await executeAsync(`
      const done = arguments[arguments.length - 1];
      chrome.tabs.query({}, (tabs) => done(tabs.map((tab) => tab.url || "")));
    `);
    const logs = await webdriver("POST", `/session/${sessionId}/log`, { type: "browser" });
    throw new Error(
      `${error.message}\nactualKeys=${JSON.stringify(actualKeys)}\n` +
      `tabUrls=${JSON.stringify(tabUrls)}\nlogs=${JSON.stringify(logs)}`
    );
  }

  let primaryEditorHandle = await webdriver("GET", `/session/${sessionId}/window`);
  const recoveryPanelHandle = await openWindow(sidepanelUrl, "window");
  const recoveryPanelState = await waitUntil(async () => {
    const state = await executeSync(`
      const item = [...document.querySelectorAll(".recovery-session")]
        .find((candidate) => candidate.dataset.projectId === arguments[0]);
      if (!item) {
        return null;
      }
      return {
        projectId: item.dataset.projectId,
        title: item.querySelector(".recovery-session-title")?.textContent || "",
        time: item.querySelector(".recovery-session-time")?.textContent || "",
        counts: item.querySelector(".recovery-session-counts")?.textContent || "",
        drafts: item.querySelector(".recovery-session-drafts")?.textContent || "",
        continueDisabled: item.querySelector('[data-recovery-action="continue"]')?.disabled,
        draftsDisabled: item.querySelector('[data-recovery-action="drafts"]')?.disabled
      };
    `, [PROJECT_ID]);
    return (
      state?.projectId === PROJECT_ID &&
      state.title &&
      state.time.includes("최근 편집") &&
      state.counts.includes(`컷 ${restored.clips.length}`) &&
      state.counts.includes(`자막 ${restored.subtitles.length}`) &&
      state.counts.includes(`에셋 ${restored.imageAssets.length}`) &&
      state.drafts.includes("복구본") &&
      state.continueDisabled === false &&
      state.draftsDisabled === false
    ) ? state : false;
  }, "sidepanel 저장 세션 semantic 목록");

  await executeSync(`
    const item = [...document.querySelectorAll(".recovery-session")]
      .find((candidate) => candidate.dataset.projectId === arguments[0]);
    item?.querySelector('[data-recovery-action="drafts"]')?.click();
  `, [PROJECT_ID]);
  await switchToWindow(primaryEditorHandle);
  const recoveryDialogOpened = await waitUntil(async () => {
    return executeSync(`
      const dialog = document.querySelector("#local-draft-dialog");
      return dialog?.open === true &&
        document.querySelectorAll(
          '#local-draft-list input[name="local-draft-choice"]'
        ).length > 0;
    `);
  }, "기존 projectId 편집기의 복구본 목록 자동 열기");
  await clickElement("#close-local-draft-dialog");

  await switchToWindow(recoveryPanelHandle);
  await executeSync(`
    const item = [...document.querySelectorAll(".recovery-session")]
      .find((candidate) => candidate.dataset.projectId === arguments[0]);
    item?.querySelector('[data-recovery-action="continue"]')?.click();
  `, [PROJECT_ID]);
  await delay(350);
  const recoveryEditorTabs = await executeAsync(`
    const editorRoot = arguments[0];
    const projectId = arguments[1];
    const done = arguments[arguments.length - 1];
    chrome.tabs.query({}, (tabs) => done(tabs.filter((tab) => {
      try {
        const url = new URL(tab.url || "");
        return url.origin + url.pathname === editorRoot &&
          url.searchParams.get("project") === projectId;
      } catch {
        return false;
      }
    }).map((tab) => ({ id: tab.id, url: tab.url }))));
  `, [`chrome-extension://${extensionId}/editor.html`, PROJECT_ID]);
  assert(
    recoveryEditorTabs.length === 1,
    `계속 편집이 같은 projectId 탭을 중복 생성했습니다: ${JSON.stringify(
      recoveryEditorTabs
    )}`
  );
  await waitUntil(async () => executeSync(`
    const item = [...document.querySelectorAll(".recovery-session")]
      .find((candidate) => candidate.dataset.projectId === arguments[0]);
    return item?.querySelector('[data-recovery-action="continue"]')?.disabled === false;
  `, [PROJECT_ID]), "기존 탭 포커스 뒤 계속 편집 버튼 복구");

  await switchToWindow(primaryEditorHandle);
  const immediateCloseProjectName = "Editor Interaction E2E · 즉시 종료 직전";
  const immediateCloseCueText = "즉시 종료 직전 마지막 자막 수정";
  const immediateCloseMutation = await executeSync(`
    const projectName = document.querySelector("#project-name");
    const cueText = document.querySelector("#cue-text");
    if (!projectName || !cueText || cueText.disabled) {
      return { ok: false };
    }
    projectName.value = arguments[0];
    projectName.dispatchEvent(new Event("input", { bubbles: true }));
    cueText.value = arguments[1];
    cueText.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      ok: true,
      projectName: projectName.value,
      cueText: cueText.value
    };
  `, [immediateCloseProjectName, immediateCloseCueText]);
  assert(
    immediateCloseMutation.ok,
    `즉시 종료 직전 편집 변경을 만들지 못했습니다: ${JSON.stringify(
      immediateCloseMutation
    )}`
  );
  // Deliberately do not wait for the former 180ms debounce window.
  await webdriver("DELETE", `/session/${sessionId}/window`);
  await switchToWindow(recoveryPanelHandle);
  await waitUntil(async () => executeAsync(`
    const editorRoot = arguments[0];
    const projectId = arguments[1];
    const done = arguments[arguments.length - 1];
    chrome.tabs.query({}, (tabs) => done(!tabs.some((tab) => {
      try {
        const url = new URL(tab.url || "");
        return url.origin + url.pathname === editorRoot &&
          url.searchParams.get("project") === projectId;
      } catch {
        return false;
      }
    })));
  `, [`chrome-extension://${extensionId}/editor.html`, PROJECT_ID]),
  "닫은 editor 탭의 service-worker 목록 제거");
  const closedEditorOpenClick = await executeSync(`
    const item = [...document.querySelectorAll(".recovery-session")]
      .find((candidate) => candidate.dataset.projectId === arguments[0]);
    const button = item?.querySelector('[data-recovery-action="continue"]');
    const status = document.querySelector("#status-bar");
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
    if (!button || button.disabled) {
      return {
        clicked: false,
        exists: Boolean(button),
        disabled: button?.disabled ?? null
      };
    }
    button.click();
    return { clicked: true, exists: true, disabled: false };
  `, [PROJECT_ID]);
  assert(
    closedEditorOpenClick.clicked,
    `닫힌 편집기의 계속 편집 버튼을 누르지 못했습니다: ${JSON.stringify(
      closedEditorOpenClick
    )}`
  );
  await waitUntil(async () => executeSync(`
    const item = [...document.querySelectorAll(".recovery-session")]
      .find((candidate) => candidate.dataset.projectId === arguments[0]);
    const status = document.querySelector("#status-bar")?.textContent || "";
    return !item?.classList.contains("is-opening") &&
      status.includes("마지막 저장 상태로 편집기를 열었습니다.");
  `, [PROJECT_ID]), "닫힌 편집기의 계속 편집 요청 완료");
  const reopenedTab = await waitUntil(async () => executeAsync(`
    const editorRoot = arguments[0];
    const projectId = arguments[1];
    const done = arguments[arguments.length - 1];
    chrome.tabs.query({}, (tabs) => {
      const match = tabs.find((tab) => {
        try {
          const url = new URL(tab.url || "");
          return url.origin + url.pathname === editorRoot &&
            url.searchParams.get("project") === projectId &&
            url.searchParams.get("session") === "resume";
        } catch {
          return false;
        }
      });
      done(match ? {
        id: match.id,
        url: match.url,
        status: match.status
      } : null);
    });
  `, [`chrome-extension://${extensionId}/editor.html`, PROJECT_ID]),
  "닫힌 편집기의 resume 탭 생성");
  await executeAsync(`
    const tabId = arguments[0];
    const done = arguments[arguments.length - 1];
    chrome.tabs.remove(tabId, () => done({
      error: chrome.runtime.lastError?.message || null
    }));
  `, [reopenedTab.id]);
  const reopenedEditorHandle = await openWindow(reopenedTab.url, "window");
  const reopenedEditorState = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        ready: document.readyState === "complete",
        projectName: document.querySelector("#project-name")?.value || "",
        clipCount: document.querySelectorAll("#clip-list .clip-item").length,
        cueCount: document.querySelectorAll("#caption-tracks .cue-block").length,
        assetCount: document.querySelectorAll("#asset-track .asset-block").length,
        cueText: document.querySelector("#cue-text")?.value || "",
        upstageKey: document.querySelector("#caption-upstage-api-key")?.value || ""
      };
    `);
    return (
      state.ready &&
      state.projectName === immediateCloseProjectName &&
      state.clipCount === restored.clips.length &&
      state.cueCount === restored.subtitles.length &&
      state.assetCount === restored.imageAssets.length &&
      state.cueText === immediateCloseCueText &&
      state.upstageKey === ""
    ) ? state : false;
  }, "resume URL의 현재본 복원과 API 키 비저장");
  primaryEditorHandle = reopenedEditorHandle;
  const reopenedEditor = {
    tab: reopenedTab,
    state: reopenedEditorState
  };

  await switchToWindow(recoveryPanelHandle);
  await webdriver("DELETE", `/session/${sessionId}/window`);
  await switchToWindow(primaryEditorHandle);
  const recoveryHubSmoke = {
    panel: recoveryPanelState,
    recoveryDialogOpened,
    editorTabs: recoveryEditorTabs,
    reopenedEditor,
    immediateCloseMutation
  };

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
    "https://legacy-model-cache.invalid/chzzk-kirinuki-e2e/sentinel";
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
        const request = indexedDB.open(databaseName);
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
    LEGACY_MODEL_CACHE_NAME,
    modelCacheSentinelUrl,
    LEGACY_MODEL_CACHE_SENTINEL_TEXT,
    DATABASE_NAME
  ]);
  assert(
    resetFixture?.ok &&
      resetFixture.cacheText === LEGACY_MODEL_CACHE_SENTINEL_TEXT &&
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
      state.status.includes("임시저장·원본 파일 권한을 초기화") &&
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
      const cached = cacheNames.includes(cacheName)
        ? await (await caches.open(cacheName)).match(cacheUrl)
        : null;
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
    LEGACY_MODEL_CACHE_NAME,
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
      !resetAudit.cacheNames.includes(LEGACY_MODEL_CACHE_NAME) &&
      resetAudit.cacheText === null &&
      resetAudit.panelDom.projectName === "" &&
      resetAudit.panelDom.segmentCount === 0,
    `multi-window reset 뒤 workspace 정리/이전 모델 Cache 제거 계약 위반: ${JSON.stringify(
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
    imageAsset: restored.imageAssets?.find((asset) => asset.id === imageAssetId),
    imageAssetBlobKeysAfterPrune: prunedImageAssetBlobKeys,
    clipOrder: restored.clips.map((clip) => clip.id),
    hotSeed: {
      delivery: hotSeedDelivery,
      dom: hotSeedDom,
      preservedTrim: expected.trimmedClip,
      appendedClip: restored.clips.find((clip) => clip.id === "clip-selection-c")
    },
    semantics: {
      nativeSpaceButton,
      localDrafts: localDraftSmoke,
      recoveryHub: recoveryHubSmoke,
      multitrackUi: multitrackUiProbe,
      cueHandleNudge: {
        before: cueHandleNudgeBefore,
        after: cueHandleNudgeAfter
      },
      reorderKeyboardFocus,
      clipGroupMove: clipGroupMoveSmoke,
      rippleRange: {
        toolbar: toolbarRange,
        handleBeforeDrag: rangeHandleBeforeDrag,
        endAfterNudge: rangeEndAfterNudge,
        deletedRange: deleteRange,
        cueTimelineStartBefore: rangeCueTimelineStartBefore,
        cueTimelineStartAfter: rippleMovedCueTimelineStart,
        inputEscape: inputEscapeRange,
        uiAfterDelete: rangeUiAfterDelete
      },
      clipTrimRoundTrip: {
        moves: clipTrimRoundTrip.moves,
        down: roundTripDown,
        maxX: Math.max(...roundTripMoves.map((event) => event.x)),
        up: roundTripUp,
        cueBefore: rollbackCueBefore,
        cueAfter: rollbackCueAfter,
        liveCueGeometry: liveClipTrimGeometry
      },
      persistentErrorToast,
      aiDialog: {
        opened: aiDialogOpened,
        afterTab: aiDialogAfterTab,
        canceled: aiDialogCanceled,
        captionFetch: aiFetchProbe
      },
      aiSuccess: aiSuccessSmoke,
      previewTransition: previewTransitionSmoke
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
