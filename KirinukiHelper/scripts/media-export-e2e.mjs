import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
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
const PROJECT_ID = "e2e-media-export";
const PROJECT_NAME = "Media Export E2E";
const CAPTION_TEXT = "사람이 확인한 내보내기 자막";
const SECOND_CAPTION_TEXT = "동시에 보이는 두 번째 자막";
const FIRST_CAPTION_COLOR = "#ff2020";
const SECOND_CAPTION_COLOR = "#20ff40";
const IMAGE_ASSET_ID = "asset-transparent-export-e2e";
const IMAGE_ASSET_NAME = "transparent-export-e2e.png";
const PREEXISTING_SIDECAR_TEXT = "do-not-overwrite-existing-sidecar\n";
const EXPECTED_DURATION_SECONDS = 4;
const EXPECTED_FRAME_RATE = 30;
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = path.resolve(process.argv[2] || path.join(root, "extension"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-kirinuki-export-e2e-"));
const profileRoot = path.join(tempRoot, "chromium-profile");
const downloadRoot = path.join(tempRoot, "downloads");
const mediaPath = path.join(tempRoot, "non-zero-pts-source.mp4");

let driver = null;
let driverPort = null;
let sessionId = "";
let cleanupPromise = null;
let driverOutput = "";
const trackedProcesses = new Set();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isExpectedLocalCaptionOffline(entry) {
  return (
    entry?.level === "SEVERE"
    && entry?.source === "network"
    && String(entry?.message || "").startsWith(
      "http://127.0.0.1:4319/v1/session - Failed to load resource:"
    )
    && String(entry.message).includes("net::ERR_CONNECTION_REFUSED")
  );
}

function appendOutput(target, chunk) {
  const next = `${target}${chunk.toString()}`;
  return next.length > 80_000 ? next.slice(-80_000) : next;
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

function spawnTracked(executable, args, options = {}) {
  const child = spawn(executable, args, {
    detached: process.platform !== "win32",
    ...options
  });
  trackedProcesses.add(child);
  child.once("exit", () => trackedProcesses.delete(child));
  return child;
}

async function runCommand(executable, args, {
  binary = false,
  timeout = 60_000
} = {}) {
  const child = spawnTracked(executable, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  let timer = null;
  const exitCode = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
        reject(new Error(`${path.basename(executable)} 실행이 ${timeout}ms를 넘었습니다.`));
      }, timeout);
    })
  ]).finally(() => clearTimeout(timer));

  const output = Buffer.concat(stdout);
  const errorOutput = Buffer.concat(stderr).toString().trim();
  assert(
    exitCode === 0,
    `${path.basename(executable)} 실패 (exit ${exitCode}): ${errorOutput || "(stderr 없음)"}`
  );
  return binary ? output : output.toString();
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
  const payload = await fetchJson(
    `http://127.0.0.1:${driverPort}${commandPath}`,
    { method, body: requestBody }
  );
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

async function cdp(command, params = {}) {
  return webdriver("POST", `/session/${sessionId}/goog/cdp/execute`, {
    cmd: command,
    params
  });
}

async function waitUntil(check, description, {
  timeout = 20_000,
  interval = 120
} = {}) {
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
      // ChromeDriver가 포트에 바인딩할 때까지 재시도한다.
    }
    await delay(100);
  }
  throw new Error(`ChromeDriver가 10초 안에 준비되지 않았습니다.\n${driverOutput.trim()}`);
}

async function waitForExtensionTarget(debuggerAddress, serviceWorkerPath) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
}

async function clearAndType(selector, text) {
  const element = await findElement(selector);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/clear`);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/value`, {
    text,
    value: Array.from(text)
  });
}

async function clickTimelineRulerAtClipFraction(clipId, fraction = 0.5) {
  const target = await executeSync(`
    const clipId = arguments[0];
    const fraction = arguments[1];
    const ruler = document.querySelector("#timeline-ruler");
    const block = document.querySelector(
      '.clip-block[data-id="' + CSS.escape(clipId) + '"]'
    );
    if (!ruler || !block) {
      return null;
    }
    const rulerRect = ruler.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    globalThis.__kirinukiE2eTimelinePointer = [];
    ruler.addEventListener("pointerdown", (event) => {
      globalThis.__kirinukiE2eTimelinePointer.push({
        clientX: event.clientX,
        clientY: event.clientY,
        isTrusted: event.isTrusted
      });
    }, { capture: true });
    return {
      x: Math.round(blockRect.left + blockRect.width * fraction),
      y: Math.round(rulerRect.top + rulerRect.height / 2),
      blockLeft: blockRect.left,
      blockWidth: blockRect.width,
      rulerLeft: rulerRect.left,
      rulerWidth: rulerRect.width
    };
  `, [clipId, fraction]);
  assert(
    target &&
      Number.isFinite(target.x) &&
      Number.isFinite(target.y) &&
      target.blockWidth > 0,
    `타임라인 포인터 목표를 계산하지 못했습니다: ${JSON.stringify(target)}`
  );
  try {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [{
        type: "pointer",
        id: "safe-playhead-pointer",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            x: target.x,
            y: target.y
          },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 }
        ]
      }]
    });
  } finally {
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => {});
  }
  return target;
}

async function clickTimelineRulerAtClipMidpoint(clipId) {
  return clickTimelineRulerAtClipFraction(clipId, 0.5);
}

async function seekTimelineAtClipFraction(clipId, fraction, expectedSeconds) {
  const pointerTarget = await clickTimelineRulerAtClipFraction(clipId, fraction);
  const playhead = await waitUntil(async () => {
    const state = await readPlayheadUiState();
    return (
      Number.isFinite(Number(state.value)) &&
      Math.abs(Number(state.value) - expectedSeconds) <= 0.05 &&
      state.paused
    ) ? state : false;
  }, `${clipId} ${fraction} 위치로 타임라인 이동`);
  return { pointerTarget, playhead };
}

async function readPlayheadUiState() {
  return executeSync(`
    const video = document.querySelector("#preview-video");
    const playhead = document.querySelector("#playhead");
    return {
      value: playhead?.getAttribute("aria-valuenow"),
      valueText: playhead?.getAttribute("aria-valuetext"),
      paused: video?.paused,
      previewCurrentTime: video?.currentTime,
      previewDuration: video?.duration,
      previewSeekable: video
        ? Array.from({ length: video.seekable.length }, (_, index) => ({
            start: video.seekable.start(index),
            end: video.seekable.end(index)
          }))
        : [],
      pointerEvents: globalThis.__kirinukiE2eTimelinePointer || []
    };
  `);
}

async function setControlValue(selector, value) {
  const result = await executeSync(`
    const element = document.querySelector(arguments[0]);
    if (!element) {
      return null;
    }
    element.value = String(arguments[1]);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      value: element.value,
      disabled: element.disabled
    };
  `, [selector, value]);
  assert(
    result && result.value === String(value) && result.disabled === false,
    `${selector} 값을 ${value}(으)로 설정하지 못했습니다: ${JSON.stringify(result)}`
  );
  return result;
}

async function setFileInput(selector, filePath) {
  const element = await findElement(selector);
  await webdriver("POST", `/session/${sessionId}/element/${element[ELEMENT_KEY]}/value`, {
    text: filePath,
    value: [filePath]
  });
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

async function seedTransparentImageAssetFixture() {
  const result = await executeAsync(`
    const [databaseName, projectStoreName, projectId, assetId, assetName] = arguments;
    const done = arguments[arguments.length - 1];
    let finished = false;
    const finish = (value) => {
      if (!finished) {
        finished = true;
        done(value);
      }
    };
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255, 0, 0, 1)";
    context.fillRect(20, 20, 40, 80);
    context.fillStyle = "rgba(0, 255, 0, 0.5)";
    context.fillRect(70, 20, 30, 80);
    canvas.toBlob((blob) => {
      if (!blob) {
        finish({ error: "투명 PNG fixture Blob 생성 실패" });
        return;
      }
      const open = indexedDB.open(databaseName);
      open.onerror = () => finish({ error: String(open.error || "IndexedDB open failed") });
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(
          [projectStoreName, "image-assets"],
          "readwrite"
        );
        const projectStore = transaction.objectStore(projectStoreName);
        const imageStore = transaction.objectStore("image-assets");
        const request = projectStore.get(projectId);
        let seededAsset = null;
        request.onerror = () => transaction.abort();
        request.onsuccess = () => {
          const project = request.result;
          if (!project) {
            transaction.abort();
            return;
          }
          const now = new Date().toISOString();
          seededAsset = {
            id: assetId,
            clipId: "clip-blue",
            startOffsetMs: 200,
            endOffsetMs: 800,
            name: assetName,
            mimeType: "image/png",
            source: { kind: "blob-key", value: assetId },
            sourceUrl: "",
            x: 0.5,
            y: 0.5,
            scale: 2,
            opacity: 1,
            naturalWidth: 120,
            naturalHeight: 120,
            createdAt: now,
            updatedAt: now
          };
          projectStore.put({
            ...project,
            imageAssets: [
              ...(project.imageAssets || []).filter((asset) => asset.id !== assetId),
              seededAsset
            ],
            selectedImageAssetId: assetId,
            updatedAt: now
          });
          imageStore.put(blob, [projectId, assetId]);
        };
        transaction.oncomplete = () => {
          database.close();
          finish({
            ok: true,
            asset: seededAsset,
            blob: {
              type: blob.type,
              size: blob.size
            },
            sourcePixels: {
              transparentCorner: Array.from(context.getImageData(5, 5, 1, 1).data),
              opaqueRed: Array.from(context.getImageData(40, 60, 1, 1).data),
              semiGreen: Array.from(context.getImageData(85, 60, 1, 1).data)
            }
          });
        };
        transaction.onerror = () => {
          const error = transaction.error;
          database.close();
          finish({ error: String(error || "투명 PNG fixture 저장 실패") });
        };
        transaction.onabort = () => {
          const error = transaction.error;
          database.close();
          finish({ error: String(error || "투명 PNG fixture transaction 중단") });
        };
      };
    }, "image/png");
  `, [
    DATABASE_NAME,
    PROJECT_STORE,
    PROJECT_ID,
    IMAGE_ASSET_ID,
    IMAGE_ASSET_NAME
  ]);
  assert(
    result?.ok &&
      result.asset?.source?.kind === "blob-key" &&
      result.asset.source.value === IMAGE_ASSET_ID &&
      result.blob?.type === "image/png" &&
      result.blob.size > 0 &&
      result.sourcePixels?.transparentCorner?.[3] === 0 &&
      result.sourcePixels?.opaqueRed?.[0] === 255 &&
      result.sourcePixels?.opaqueRed?.[3] === 255 &&
      result.sourcePixels?.semiGreen?.[1] === 255 &&
      result.sourcePixels?.semiGreen?.[3] > 100 &&
      result.sourcePixels?.semiGreen?.[3] < 200,
    `투명 PNG blob-key fixture를 IndexedDB에 저장하지 못했습니다: ${JSON.stringify(result)}`
  );
  return result;
}

async function waitForStoredProject(predicate, description, options) {
  return waitUntil(async () => {
    const project = await readStoredProject();
    return project && predicate(project) ? project : false;
  }, description, options);
}

async function installMemoryDirectoryPicker(preexistingFiles = []) {
  return executeAsync(`
    const preexistingFiles = arguments[0];
    const done = arguments[arguments.length - 1];
    void (async () => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const state = {
        pickerCalls: [],
        savePickerCalls: [],
        anchorDownloads: [],
        getFileHandleCalls: [],
        files: new Map()
      };

      const asBytes = async (value) => {
        if (typeof value === "string") {
          return encoder.encode(value);
        }
        if (value instanceof Blob) {
          return new Uint8Array(await value.arrayBuffer());
        }
        if (value instanceof ArrayBuffer) {
          return new Uint8Array(value);
        }
        if (ArrayBuffer.isView(value)) {
          return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        }
        throw new TypeError("fake writable이 지원하지 않는 write data입니다.");
      };

      const validOffset = (value, label) => {
        if (!Number.isInteger(value) || value < 0) {
          throw new TypeError(label + "은 0 이상의 정수여야 합니다.");
        }
        return value;
      };

      const resize = (bytes, size) => {
        const next = new Uint8Array(size);
        next.set(bytes.subarray(0, Math.min(bytes.length, size)));
        return next;
      };

      const makeWritable = (record, { keepExistingData = false } = {}) => {
        let bytes = keepExistingData ? record.bytes.slice() : new Uint8Array();
        let position = 0;
        let settled = false;
        const operations = [];
        record.transactions.push(operations);

        const ensureOpen = () => {
          if (settled) {
            throw new DOMException("Writable is closed.", "InvalidStateError");
          }
        };
        const writeAt = async (data, requestedPosition, mode) => {
          ensureOpen();
          const targetPosition = validOffset(requestedPosition, "write position");
          const chunk = await asBytes(data);
          const end = targetPosition + chunk.byteLength;
          if (end > bytes.byteLength) {
            bytes = resize(bytes, end);
          }
          bytes.set(chunk, targetPosition);
          position = end;
          operations.push({
            type: "write",
            position: targetPosition,
            size: chunk.byteLength,
            mode
          });
        };

        return {
          async write(value) {
            ensureOpen();
            if (
              value &&
              typeof value === "object" &&
              !(value instanceof Blob) &&
              typeof value.type === "string"
            ) {
              if (value.type === "write") {
                await writeAt(value.data, value.position ?? position, "positioned");
                return;
              }
              if (value.type === "seek") {
                await this.seek(value.position);
                return;
              }
              if (value.type === "truncate") {
                await this.truncate(value.size);
                return;
              }
              throw new TypeError("알 수 없는 fake writable 명령: " + value.type);
            }
            await writeAt(value, position, "raw");
          },
          async seek(nextPosition) {
            ensureOpen();
            position = validOffset(nextPosition, "seek position");
            operations.push({ type: "seek", position });
          },
          async truncate(size) {
            ensureOpen();
            const nextSize = validOffset(size, "truncate size");
            bytes = resize(bytes, nextSize);
            if (position > nextSize) {
              position = nextSize;
            }
            operations.push({ type: "truncate", size: nextSize });
          },
          async close() {
            ensureOpen();
            settled = true;
            const jobDialog = document.querySelector("#job-dialog");
            const cancelButton = document.querySelector("#cancel-job");
            record.closeUiSnapshots.push({
              jobHidden: jobDialog?.hidden ?? null,
              jobOpen: jobDialog?.open ?? null,
              message: document.querySelector("#job-message")?.textContent || "",
              percent: document.querySelector("#job-percent")?.textContent || "",
              progressWidth: document.querySelector("#job-progress")?.style.width || "",
              cancelHidden: cancelButton?.hidden ?? null,
              cancelDisabled: cancelButton?.disabled ?? null
            });
            record.bytes = bytes.slice();
            record.committed = true;
            record.closeCount += 1;
            operations.push({ type: "close", size: bytes.byteLength });
          },
          async abort(reason) {
            if (settled) {
              return;
            }
            settled = true;
            record.abortCount += 1;
            operations.push({
              type: "abort",
              reason: reason == null ? null : String(reason)
            });
          }
        };
      };

      const createRecord = (
        name,
        initialBytes = new Uint8Array(),
        { preexisting = false } = {}
      ) => ({
        name,
        bytes: initialBytes.slice(),
        committed: initialBytes.byteLength > 0,
        preexisting,
        createWritableCalls: [],
        closeUiSnapshots: [],
        closeCount: 0,
        abortCount: 0,
        transactions: []
      });

      for (const entry of preexistingFiles) {
        const record = createRecord(
          entry.name,
          encoder.encode(entry.contents),
          { preexisting: true }
        );
        state.files.set(entry.name, record);
      }

      const contractRecord = createRecord("__contract");
      const contractWritable = makeWritable(contractRecord);
      await contractWritable.write("abcd");
      await contractWritable.write({
        type: "write",
        position: 1,
        data: "XY"
      });
      await contractWritable.seek(4);
      await contractWritable.write("!");
      await contractWritable.truncate(3);
      await contractWritable.close();

      const abortRecord = createRecord("__abort", encoder.encode("keep"));
      const abortWritable = makeWritable(abortRecord, { keepExistingData: true });
      await abortWritable.write({
        type: "write",
        position: 0,
        data: "lost"
      });
      await abortWritable.abort("rollback");

      const directoryHandle = {
        kind: "directory",
        name: "E2E memory export",
        async getFileHandle(name, options = {}) {
          const create = options?.create === true;
          state.getFileHandleCalls.push({ name, create });
          let record = state.files.get(name);
          if (!record) {
            if (!create) {
              throw new DOMException("File not found.", "NotFoundError");
            }
            record = createRecord(name);
            state.files.set(name, record);
          }
          return {
            kind: "file",
            name,
            async createWritable(writableOptions = {}) {
              record.createWritableCalls.push({
                keepExistingData: writableOptions?.keepExistingData === true
              });
              return makeWritable(record, writableOptions);
            },
            async getFile() {
              return new File([record.bytes], name);
            }
          };
        }
      };

      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async (options = {}) => {
          state.pickerCalls.push({
            id: options?.id ?? null,
            mode: options?.mode ?? null
          });
          return directoryHandle;
        }
      });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async (options = {}) => {
          state.savePickerCalls.push({
            id: options?.id ?? null,
            suggestedName: options?.suggestedName ?? null
          });
          throw new Error("showSaveFilePicker fallback을 사용하면 안 됩니다.");
        }
      });

      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      globalThis.__kirinukiE2eOriginalAnchorClick = originalAnchorClick;
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download) {
          state.anchorDownloads.push({
            download: this.download,
            href: this.href
          });
          return;
        }
        return originalAnchorClick.call(this);
      };
      globalThis.__kirinukiE2eDirectory = state;

      done({
        ok: true,
        directoryPickerType: typeof window.showDirectoryPicker,
        savePickerType: typeof window.showSaveFilePicker,
        contractProbe: {
          committedText: decoder.decode(contractRecord.bytes),
          operations: contractRecord.transactions[0],
          abortPreservedText: decoder.decode(abortRecord.bytes),
          abortOperations: abortRecord.transactions[0]
        }
      });
    })().catch((error) => done({
      error: error instanceof Error ? error.stack || error.message : String(error)
    }));
  `, [preexistingFiles]);
}

async function captureMemoryDirectoryFiles() {
  return executeAsync(`
    const done = arguments[arguments.length - 1];
    const state = globalThis.__kirinukiE2eDirectory;
    if (!state) {
      done({ error: "memory directory state가 없습니다." });
      return;
    }
    const asBase64 = (bytes) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.readAsDataURL(new Blob([bytes]));
    });
    void Promise.all([...state.files.values()].map(async (record) => ({
      name: record.name,
      size: record.bytes.byteLength,
      committed: record.committed,
      preexisting: record.preexisting,
      createWritableCalls: record.createWritableCalls,
      closeUiSnapshots: record.closeUiSnapshots,
      closeCount: record.closeCount,
      abortCount: record.abortCount,
      transactions: record.transactions,
      base64: await asBase64(record.bytes)
    }))).then((files) => done({
      files,
      pickerCalls: state.pickerCalls,
      savePickerCalls: state.savePickerCalls,
      anchorDownloads: state.anchorDownloads,
      getFileHandleCalls: state.getFileHandleCalls
    })).catch((error) => done({
      error: error instanceof Error ? error.stack || error.message : String(error)
    }));
  `);
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
        // 아래 process group 정리가 남은 Chromium도 종료한다.
      }
      sessionId = "";
    }
    await Promise.allSettled([...trackedProcesses].map((child) => stopProcess(child)));
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
  await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=red:size=640x360:rate=30:d=4",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-f", "lavfi",
    "-i", "color=c=blue:size=640x360:rate=30:d=4",
    "-f", "lavfi",
    "-i", "sine=frequency=880:sample_rate=48000:duration=4",
    "-filter_complex",
    "[0:v][2:v]concat=n=2:v=1:a=0,setpts=PTS+120/TB[v];" +
      "[1:a][3:a]concat=n=2:v=0:a=1,asetpts=PTS+120/TB[a]",
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    mediaPath
  ]);
  await access(mediaPath);
}

async function probeMedia(ffprobe, filePath) {
  const output = await runCommand(ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries",
    "format=format_name,start_time,duration,size:" +
      "stream=index,codec_name,codec_type,start_time,duration,avg_frame_rate,nb_frames,nb_read_frames",
    "-of", "json",
    filePath
  ]);
  return JSON.parse(output);
}

async function sampleFrameRgb(ffmpeg, filePath, timestamp) {
  const output = await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-ss", String(timestamp),
    "-frames:v", "1",
    "-vf", "crop=64:64:0:0,scale=1:1:flags=area",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1"
  ], { binary: true });
  assert(output.byteLength >= 3, `${timestamp}초 프레임 RGB를 추출하지 못했습니다.`);
  return {
    red: output[0],
    green: output[1],
    blue: output[2]
  };
}

async function sampleFrameRgbPixels(ffmpeg, filePath, timestamp) {
  const output = await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-ss", String(timestamp),
    "-frames:v", "1",
    "-vf", `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=neighbor`,
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1"
  ], { binary: true });
  const expectedBytes = FRAME_WIDTH * FRAME_HEIGHT * 3;
  assert(
    output.byteLength === expectedBytes,
    `${timestamp}초 전체 프레임 RGB 크기가 다릅니다: ${output.byteLength} (expected ${expectedBytes})`
  );
  return output;
}

function analyzeCaptionColors(pixels) {
  const result = {
    red: { count: 0, xTotal: 0, yTotal: 0 },
    green: { count: 0, xTotal: 0, yTotal: 0 }
  };
  for (let offset = 0; offset < pixels.byteLength; offset += 3) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const pixelIndex = offset / 3;
    const x = pixelIndex % FRAME_WIDTH;
    const y = Math.floor(pixelIndex / FRAME_WIDTH);
    if (red >= 150 && red >= green * 1.7 && red >= blue * 1.7) {
      result.red.count += 1;
      result.red.xTotal += x;
      result.red.yTotal += y;
    }
    if (green >= 150 && green >= red * 1.7 && green >= blue * 1.7) {
      result.green.count += 1;
      result.green.xTotal += x;
      result.green.yTotal += y;
    }
  }
  return Object.fromEntries(Object.entries(result).map(([name, sample]) => [
    name,
    {
      count: sample.count,
      centerX: sample.count > 0 ? sample.xTotal / sample.count : null,
      centerY: sample.count > 0 ? sample.yTotal / sample.count : null
    }
  ]));
}

function averageRgbRegion(pixels, {
  x,
  y,
  width = 12,
  height = 12
}) {
  const left = Math.max(0, Math.min(FRAME_WIDTH - 1, Math.round(x)));
  const top = Math.max(0, Math.min(FRAME_HEIGHT - 1, Math.round(y)));
  const right = Math.min(FRAME_WIDTH, left + Math.max(1, Math.round(width)));
  const bottom = Math.min(FRAME_HEIGHT, top + Math.max(1, Math.round(height)));
  const total = { red: 0, green: 0, blue: 0, count: 0 };
  for (let pixelY = top; pixelY < bottom; pixelY += 1) {
    for (let pixelX = left; pixelX < right; pixelX += 1) {
      const offset = (pixelY * FRAME_WIDTH + pixelX) * 3;
      total.red += pixels[offset];
      total.green += pixels[offset + 1];
      total.blue += pixels[offset + 2];
      total.count += 1;
    }
  }
  return {
    red: total.red / total.count,
    green: total.green / total.count,
    blue: total.blue / total.count,
    count: total.count,
    region: { left, top, right, bottom }
  };
}

async function sampleAudioPcm(ffmpeg, filePath, start, duration = 0.5) {
  const output = await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-ss", String(start),
    "-t", String(duration),
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "8000",
    "-f", "f32le",
    "pipe:1"
  ], { binary: true });
  assert(output.byteLength >= 4_000, `${start}초 오디오 PCM을 충분히 추출하지 못했습니다.`);
  const sampleCount = Math.floor(output.byteLength / 4);
  return Array.from({ length: sampleCount }, (_, index) => output.readFloatLE(index * 4));
}

function audioRms(samples) {
  return Math.sqrt(
    samples.reduce((total, sample) => total + sample * sample, 0) /
      Math.max(1, samples.length)
  );
}

function tonePower(samples, sampleRate, frequency) {
  let real = 0;
  let imaginary = 0;
  const denominator = Math.max(1, samples.length - 1);
  for (let index = 0; index < samples.length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / denominator);
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    const value = samples[index] * window;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return real * real + imaginary * imaginary;
}

function formatSrtTime(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},` +
    String(millis).padStart(3, "0")
  );
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

  const [chromedriver, chromium, ffmpeg, ffprobe, port] = await Promise.all([
    resolveExecutable("CHROMEDRIVER_BINARY", ["chromedriver"]),
    resolveExecutable("CHROMIUM_BINARY", [
      "chromium",
      "chromium-browser",
      "google-chrome",
      "google-chrome-stable"
    ]),
    resolveExecutable("FFMPEG_BINARY", ["ffmpeg"]),
    resolveExecutable("FFPROBE_BINARY", ["ffprobe"]),
    reservePort()
  ]);
  driverPort = port;
  await createSyntheticMedia(ffmpeg);
  const fixtureProbe = await probeMedia(ffprobe, mediaPath);
  assert(
    Number(fixtureProbe.format?.start_time) > 100,
    `합성 fixture가 non-zero PTS로 만들어지지 않았습니다: ${fixtureProbe.format?.start_time}`
  );

  driver = spawnTracked(chromedriver, [`--port=${driverPort}`], {
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
          prefs: {
            "download.default_directory": downloadRoot,
            "download.prompt_for_download": false,
            "download.directory_upgrade": true,
            "profile.default_content_setting_values.automatic_downloads": 1,
            "safebrowsing.enabled": true
          },
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
  await webdriver("POST", `/session/${sessionId}/window/rect`, {
    width: 1600,
    height: 1100
  });
  await cdp("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadRoot,
    eventsEnabled: true
  });

  const debuggerAddress = created.capabilities?.["goog:chromeOptions"]?.debuggerAddress;
  assert(debuggerAddress, "Chrome DevTools debugger address를 받지 못했습니다.");
  const extensionTarget = await waitForExtensionTarget(debuggerAddress, serviceWorkerPath);
  const extensionId = new URL(extensionTarget.url).host;
  assert(extensionId, "service worker target에서 extension ID를 찾지 못했습니다.");

  const captureState = {
    schemaVersion: 1,
    projectName: PROJECT_NAME,
    source: {
      platform: "CHZZK",
      url: "https://chzzk.naver.com/video/export-e2e",
      canonicalUrl: "https://chzzk.naver.com/video/export-e2e",
      channelId: "export-e2e-channel",
      contentId: "export-e2e-vod",
      contentType: "vod",
      streamerName: "E2E 스트리머",
      broadcastTitle: "실제 미디어 내보내기 검증",
      broadcastStartedAt: "2026-07-27 21:00:00",
      observedAt: "2026-07-27T12:00:00.000Z"
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
        id: "red",
        startSeconds: 0.5,
        endSeconds: 2.5,
        description: "빨강 440Hz",
        startCapture: null,
        endCapture: null,
        createdAt: "2026-07-27T12:00:01.000Z",
        updatedAt: "2026-07-27T12:00:01.000Z"
      },
      {
        id: "blue",
        startSeconds: 4.5,
        endSeconds: 6.5,
        description: "파랑 880Hz",
        startCapture: null,
        endCapture: null,
        createdAt: "2026-07-27T12:00:02.000Z",
        updatedAt: "2026-07-27T12:00:02.000Z"
      }
    ],
    updatedAt: "2026-07-27T12:00:02.000Z"
  };

  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await webdriver("POST", `/session/${sessionId}/url`, { url: sidepanelUrl });
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
    return state.ready && state.clipCount === 2 && state.title === PROJECT_NAME ? state : false;
  }, "두 컷이 있는 editor 초기화");

  await setFileInput("#media-input", mediaPath);
  const attachedProject = await waitForStoredProject((project) => (
    project.mediaAsset?.name === path.basename(mediaPath)
      && project.mediaAsset.mediaOriginMs > 100_000
      && project.mediaAsset.durationMs > 7_900
      && project.mediaAsset.durationMs < 8_100
  ), "non-zero PTS 미디어 연결", { timeout: 30_000 });
  const attachedPreviewMedia = await waitUntil(async () => {
    const state = await executeSync(`
      const video = document.querySelector("#preview-video");
      return {
        currentTime: video?.currentTime,
        duration: video?.duration,
        paused: video?.paused,
        seekable: video
          ? Array.from({ length: video.seekable.length }, (_, index) => ({
              start: video.seekable.start(index),
              end: video.seekable.end(index)
            }))
          : []
      };
    `);
    return Number.isFinite(state.duration) && state.seekable.length > 0 ? state : false;
  }, "preview media PTS/seekable 진단");

  await clickElement('.clip-item[data-id="clip-blue"] [data-action="up"]');
  const reorderedProject = await waitForStoredProject((project) => (
    project.clips.map((clip) => clip.id).join(",") === "clip-blue,clip-red"
      && project.clips[0].timelineStartMs === 0
      && project.clips[1].timelineStartMs === 2_000
  ), "파랑→빨강 컷 순서 저장");

  await webdriver("POST", `/session/${sessionId}/url`, { url: sidepanelUrl });
  await waitUntil(
    () => executeSync("return document.readyState === 'complete';"),
    "에셋 fixture 저장 전 editor flush"
  );
  const transparentAssetFixture = await seedTransparentImageAssetFixture();
  await webdriver("POST", `/session/${sessionId}/url`, { url: editorUrl });
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        ready: document.readyState === "complete",
        clipOrder: [...document.querySelectorAll("#video-track .clip-block")]
          .map((block) => block.dataset.id),
        assetIds: [...document.querySelectorAll("#asset-track .asset-block")]
          .map((block) => block.dataset.id)
      };
    `);
    return (
      state.ready &&
      state.clipOrder.join(",") === "clip-blue,clip-red" &&
      state.assetIds.join(",") === IMAGE_ASSET_ID
    ) ? state : false;
  }, "blob-key 투명 PNG 에셋 editor 복원");
  await setFileInput("#media-input", mediaPath);
  const imageAssetProject = await waitForStoredProject((project) => {
    const asset = project.imageAssets?.find((candidate) => candidate.id === IMAGE_ASSET_ID);
    return (
      project.mediaAsset?.name === path.basename(mediaPath) &&
      project.clips.map((clip) => clip.id).join(",") === "clip-blue,clip-red" &&
      project.selectedImageAssetId === IMAGE_ASSET_ID &&
      asset?.clipId === "clip-blue" &&
      asset.startOffsetMs === 200 &&
      asset.endOffsetMs === 800 &&
      asset.source?.kind === "blob-key" &&
      asset.source.value === IMAGE_ASSET_ID &&
      asset.mimeType === "image/png" &&
      asset.naturalWidth === 120 &&
      asset.naturalHeight === 120 &&
      asset.scale === 2 &&
      asset.opacity === 1
    );
  }, "투명 PNG 에셋·원본 재연결", { timeout: 30_000 });
  const imageAsset = imageAssetProject.imageAssets.find(
    (candidate) => candidate.id === IMAGE_ASSET_ID
  );

  const previewPaused = await executeSync(
    'return document.querySelector("#preview-video")?.paused === true;'
  );
  if (!previewPaused) {
    await clickElement("#play-toggle");
    await waitUntil(
      () => executeSync('return document.querySelector("#preview-video")?.paused === true;'),
      "미리보기 UI 일시정지"
    );
  }
  const reorderedTimeline = await waitUntil(async () => {
    const state = await executeSync(`
      const blue = document.querySelector('.clip-block[data-id="clip-blue"]')?.getBoundingClientRect();
      const red = document.querySelector('.clip-block[data-id="clip-red"]')?.getBoundingClientRect();
      return {
        blueLeft: blue?.left,
        blueWidth: blue?.width,
        redLeft: red?.left,
        redWidth: red?.width
      };
    `);
    return (
      Number.isFinite(state.blueLeft) &&
      Number.isFinite(state.redLeft) &&
      state.blueLeft < state.redLeft &&
      state.blueWidth > 0 &&
      state.redWidth > 0
    ) ? state : false;
  }, "재정렬된 파랑→빨강 타임라인 UI");
  await executeSync(`
    const video = document.querySelector("#preview-video");
    globalThis.__kirinukiE2eSeekEvents = [];
    const snapshot = (type) => {
      const playhead = document.querySelector("#playhead");
      const entry = {
        type,
        currentTime: video.currentTime,
        duration: video.duration,
        seekable: Array.from({ length: video.seekable.length }, (_, index) => ({
          start: video.seekable.start(index),
          end: video.seekable.end(index)
        })),
        playhead: playhead?.getAttribute("aria-valuenow"),
        at: Math.round(performance.now())
      };
      const previous = globalThis.__kirinukiE2eSeekEvents.at(-1);
      if (
        type === "durationchange" &&
        previous?.type === type &&
        previous.currentTime === entry.currentTime &&
        previous.duration === entry.duration
      ) {
        previous.count = (previous.count || 1) + 1;
        previous.at = entry.at;
        return;
      }
      globalThis.__kirinukiE2eSeekEvents.push(entry);
      if (globalThis.__kirinukiE2eSeekEvents.length > 80) {
        globalThis.__kirinukiE2eSeekEvents.shift();
      }
    };
    for (const type of ["durationchange", "seeking", "seeked", "timeupdate"]) {
      video.addEventListener(type, () => snapshot(type));
    }
    globalThis.__kirinukiE2eMarkSeekAttempt = snapshot;
  `);
  const safePointerTargets = [];
  await executeSync('globalThis.__kirinukiE2eMarkSeekAttempt?.("attempt-1");');
  safePointerTargets.push(await clickTimelineRulerAtClipMidpoint("clip-blue"));
  await delay(350);
  const firstSeekPlayhead = await readPlayheadUiState();
  let safePlayheadObserved = null;
  const safePlayhead = await waitUntil(async () => {
    const state = await readPlayheadUiState();
    safePlayheadObserved = state;
    return state.value === "1" &&
      state.valueText === "00:00:01.000" &&
      state.paused &&
      state.pointerEvents.some((event) => event.isTrusted) ? state : false;
  }, "trusted 타임라인 UI seek가 첫 컷 1초에 안정").catch((error) => {
    throw new Error(`${error.message} 관측값: ${JSON.stringify(safePlayheadObserved)}`);
  });
  const seekEventLog = await executeSync(
    "return globalThis.__kirinukiE2eSeekEvents || [];"
  );

  await clickElement("#add-cue-top");
  await waitUntil(() => executeSync(`
    return document.querySelector("#cue-editor")?.hidden === false
      && document.querySelectorAll("#caption-tracks .cue-block").length === 1;
  `), "사람 자막 추가");
  await clearAndType("#cue-text", CAPTION_TEXT);
  await executeSync("document.querySelector('#cue-text').blur();");
  await setControlValue("#font-color", FIRST_CAPTION_COLOR);
  const firstCaptionProject = await waitForStoredProject((project) => (
    project.subtitles.length === 1
      && project.subtitles[0].text === CAPTION_TEXT
      && project.subtitles[0].color === FIRST_CAPTION_COLOR
      && project.subtitles[0].origin === "human"
  ), "첫 자막 텍스트·색상 autosave");
  const captionCue = firstCaptionProject.subtitles[0];
  const captionClip = firstCaptionProject.clips.find((clip) => clip.id === captionCue.clipId);
  const captionTimelineStartMs =
    Number(captionClip?.timelineStartMs) + Number(captionCue.startOffsetMs);
  assert(
    captionCue.clipId === "clip-blue" &&
      captionCue.lane === 0 &&
      Math.abs(captionCue.startOffsetMs - 1_000) <= 2 &&
      Math.abs(captionTimelineStartMs - Number(safePlayhead.value) * 1_000) <= 2 &&
      captionCue.endOffsetMs - captionCue.startOffsetMs >= 100,
    `UI 재생 헤드와 생성된 자막 위치가 다릅니다: ${JSON.stringify({
      safePlayhead,
      cue: captionCue
    })}`
  );

  await clickElement("#add-cue-top");
  await waitUntil(() => executeSync(`
    return document.querySelector("#cue-editor")?.hidden === false
      && document.querySelectorAll("#caption-tracks .cue-block").length === 2;
  `), "동시 두 번째 레인 자막 추가");
  await clearAndType("#cue-text", SECOND_CAPTION_TEXT);
  await executeSync("document.querySelector('#cue-text').blur();");
  await setControlValue("#font-color", SECOND_CAPTION_COLOR);
  const captionProject = await waitForStoredProject((project) => (
    project.subtitles.length === 2
      && project.subtitles.some((cue) => (
        cue.text === CAPTION_TEXT &&
        cue.color === FIRST_CAPTION_COLOR &&
        cue.lane === 0
      ))
      && project.subtitles.some((cue) => (
        cue.text === SECOND_CAPTION_TEXT &&
        cue.color === SECOND_CAPTION_COLOR &&
        cue.lane === 1
      ))
  ), "서로 다른 색의 동시 2레인 자막 autosave");
  const captionCues = [...captionProject.subtitles].sort((a, b) => a.lane - b.lane);
  assert(
    captionCues[0].clipId === captionCues[1].clipId &&
      captionCues[0].startOffsetMs === captionCues[1].startOffsetMs &&
      captionCues[0].endOffsetMs === captionCues[1].endOffsetMs &&
      captionCues[0].lane === 0 &&
      captionCues[1].lane === 1,
    `두 자막이 서로 다른 레인에서 동시에 겹치지 않습니다: ${JSON.stringify(captionCues)}`
  );

  const audioUiActions = {};
  audioUiActions.muteSeek = await seekTimelineAtClipFraction("clip-blue", 0.4, 0.8);
  await clickElement("#add-audio-region");
  await waitUntil(() => executeSync(`
    return document.querySelector("#audio-editor")?.hidden === false
      && document.querySelectorAll("#audio-track .audio-block").length === 1;
  `), "음소거 구간 추가");
  await setControlValue("#audio-end", "00:01.200");
  await clickElement("#audio-mute");
  const mutedRegionProject = await waitForStoredProject((project) => (
    project.audioRegions.length === 1
      && project.audioRegions[0].clipId === "clip-blue"
      && project.audioRegions[0].muted === true
      && Math.abs(project.audioRegions[0].startOffsetMs - 800) <= 50
      && Math.abs(project.audioRegions[0].endOffsetMs - 1_200) <= 2
  ), "음소거 구간 autosave");

  audioUiActions.gainSeek = await seekTimelineAtClipFraction("clip-blue", 0.05, 0.1);
  await clickElement("#add-audio-region");
  await waitUntil(() => executeSync(`
    return document.querySelector("#audio-editor")?.hidden === false
      && document.querySelectorAll("#audio-track .audio-block").length === 2;
  `), "저음량 구간 추가");
  await setControlValue("#audio-volume", "25");
  const gainRegionProject = await waitForStoredProject((project) => (
    project.audioRegions.length === 2
      && project.audioRegions.some((region) => (
        region.clipId === "clip-blue" &&
        region.muted === false &&
        Math.abs(region.gain - 0.25) < 0.001 &&
        Math.abs(region.startOffsetMs - 100) <= 50 &&
        Math.abs(region.endOffsetMs - mutedRegionProject.audioRegions[0].startOffsetMs) <= 2
      ))
  ), "25% 음량 구간 autosave");

  audioUiActions.fadeSeek = await seekTimelineAtClipFraction("clip-red", 0.05, 2.1);
  await clickElement("#add-audio-region");
  await waitUntil(() => executeSync(`
    return document.querySelector("#audio-editor")?.hidden === false
      && document.querySelectorAll("#audio-track .audio-block").length === 3;
  `), "페이드 구간 추가");
  await setControlValue("#audio-volume", "20");
  await setControlValue("#audio-fade-in", "500");
  await setControlValue("#audio-fade-out", "500");
  const audioProject = await waitForStoredProject((project) => (
    project.audioRegions.length === 3
      && project.audioRegions.some((region) => (
        region.clipId === "clip-red" &&
        Math.abs(region.gain - 0.2) < 0.001 &&
        region.muted === false &&
        region.fadeInMs === 500 &&
        region.fadeOutMs === 500 &&
        Math.abs(region.startOffsetMs - 100) <= 50 &&
        Math.abs(region.endOffsetMs - 2_000) <= 2
      ))
  ), "20% 페이드 인·아웃 구간 autosave");
  const gainRegion = audioProject.audioRegions.find((region) => (
    region.clipId === "clip-blue" && Math.abs(region.gain - 0.25) < 0.001
  ));
  const mutedRegion = audioProject.audioRegions.find((region) => (
    region.clipId === "clip-blue" && region.muted
  ));
  const fadeRegion = audioProject.audioRegions.find((region) => (
    region.clipId === "clip-red" && region.fadeInMs === 500 && region.fadeOutMs === 500
  ));
  assert(
    gainRegion && mutedRegion && fadeRegion &&
      gainRegion.endOffsetMs <= mutedRegion.startOffsetMs &&
      mutedRegion.endOffsetMs < 2_000,
    `gain·mute·fade 음성 구간 구성이 잘못됐습니다: ${JSON.stringify(audioProject.audioRegions)}`
  );

  const pickerOverride = await installMemoryDirectoryPicker([{
    name: `${PROJECT_NAME}.kirinuki.json`,
    contents: PREEXISTING_SIDECAR_TEXT
  }]);
  assert(
    pickerOverride?.ok &&
      pickerOverride.directoryPickerType === "function" &&
      pickerOverride.savePickerType === "function" &&
      pickerOverride.contractProbe?.committedText === "aXY" &&
      pickerOverride.contractProbe?.abortPreservedText === "keep" &&
      pickerOverride.contractProbe?.operations?.map((operation) => operation.type).join(",") ===
        "write,write,seek,write,truncate,close" &&
      pickerOverride.contractProbe?.abortOperations?.at(-1)?.type === "abort",
    `memory directory picker/fake writable 계약 검증 실패: ${JSON.stringify(pickerOverride)}`
  );

  const encoderDiagnostics = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const videoConfigs = [
      {
        name: "avc",
        config: {
          codec: "avc1.640016",
          width: 640,
          height: 360,
          bitrate: 2500000,
          alpha: "discard",
          hardwareAcceleration: "prefer-hardware",
          latencyMode: "quality",
          avc: { format: "avc" }
        }
      },
      {
        name: "avc-default",
        config: {
          codec: "avc1.640016",
          width: 640,
          height: 360,
          bitrate: 2500000,
          alpha: "discard",
          hardwareAcceleration: "no-preference",
          latencyMode: "quality",
          avc: { format: "avc" }
        }
      },
      {
        name: "vp9",
        config: {
          codec: "vp09.00.21.08",
          width: 640,
          height: 360,
          bitrate: 2500000,
          alpha: "discard",
          hardwareAcceleration: "prefer-hardware",
          latencyMode: "quality"
        }
      },
      {
        name: "vp9-software",
        config: {
          codec: "vp09.00.21.08",
          width: 640,
          height: 360,
          bitrate: 2500000,
          alpha: "discard",
          hardwareAcceleration: "prefer-software",
          latencyMode: "quality"
        }
      },
      {
        name: "vp9-default",
        config: {
          codec: "vp09.00.21.08",
          width: 640,
          height: 360,
          bitrate: 2500000,
          alpha: "discard",
          hardwareAcceleration: "no-preference",
          latencyMode: "quality"
        }
      }
    ];
    const audioConfigs = [
      {
        name: "aac",
        config: {
          codec: "mp4a.40.2",
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 160000
        }
      },
      {
        name: "opus",
        config: {
          codec: "opus",
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 160000
        }
      }
    ];
    Promise.all([
      ...videoConfigs.map(async ({ name, config }) => {
        try {
          const result = await VideoEncoder.isConfigSupported(config);
          return { name, supported: result.supported, config: result.config };
        } catch (error) {
          return { name, error: String(error) };
        }
      }),
      ...audioConfigs.map(async ({ name, config }) => {
        try {
          const result = await AudioEncoder.isConfigSupported(config);
          return { name, supported: result.supported, config: result.config };
        } catch (error) {
          return { name, error: String(error) };
        }
      })
    ]).then((results) => done({
      videoEncoder: typeof VideoEncoder,
      audioEncoder: typeof AudioEncoder,
      results
    }));
  `);
  const encoderSupport = Object.fromEntries(
    encoderDiagnostics.results.map((result) => [result.name, result.supported === true])
  );
  const productProfileAvailable = (
    ((encoderSupport.avc || encoderSupport["avc-default"]) && encoderSupport.aac)
    || (
      (encoderSupport.vp9 || encoderSupport["vp9-default"] || encoderSupport["vp9-software"])
      && encoderSupport.opus
    )
  );
  assert(
    productProfileAvailable,
    "제품이 선택할 수 있는 H.264/AAC 또는 VP9/Opus 프로필이 없습니다.\n" +
      `encoder diagnostics=${JSON.stringify(encoderDiagnostics)}`
  );

  await clickElement("#export-video");
  await waitUntil(async () => {
    const state = await executeSync(`
      return {
        jobVisible: !document.querySelector("#job-dialog")?.hidden,
        exportDisabled: Boolean(document.querySelector("#export-video")?.disabled),
        toast: document.querySelector("#toast")?.textContent || ""
      };
    `);
    if (/내보내기 실패|인코더를 준비하지 못했습니다/.test(state.toast)) {
      throw new Error(
        `UI 내보내기 실패: ${state.toast}\n` +
        `encoder diagnostics=${JSON.stringify(encoderDiagnostics)}`
      );
    }
    return state.jobVisible || state.exportDisabled ? state : false;
  }, "실제 영상 렌더 시작", { timeout: 30_000 });

  const exportUi = await waitUntil(async () => {
    const state = await executeSync(`
      return {
        jobHidden: Boolean(document.querySelector("#job-dialog")?.hidden),
        exportDisabled: Boolean(document.querySelector("#export-video")?.disabled),
        toast: document.querySelector("#toast")?.textContent || ""
      };
    `);
    if (/내보내기 실패|저장에 실패/.test(state.toast)) {
      throw new Error(`UI 내보내기 실패: ${state.toast}`);
    }
    return state.jobHidden && !state.exportDisabled ? state : false;
  }, "실제 영상과 sidecar 폴더 저장 완료", { timeout: 120_000 });
  assert(
    /선택한 폴더에 저장했습니다/.test(exportUi.toast),
    `directory export 성공 toast가 아닙니다: ${exportUi.toast}`
  );

  const memoryDirectory = await captureMemoryDirectoryFiles();
  assert(
    !memoryDirectory?.error,
    `memory directory 파일 회수 실패: ${memoryDirectory?.error || "알 수 없는 오류"}`
  );
  const sortedFiles = [...memoryDirectory.files].sort((a, b) => a.name.localeCompare(b.name));
  const exportBaseName = `${PROJECT_NAME} (2)`;
  const preexistingFile = sortedFiles.find((file) => file.preexisting);
  const exportedFiles = sortedFiles.filter((file) => !file.preexisting);
  const videoFile = exportedFiles.find((file) => /\.(mp4|webm)$/i.test(file.name));
  const jsonFile = exportedFiles.find(
    (file) => file.name === `${exportBaseName}.kirinuki.json`
  );
  const srtFile = exportedFiles.find((file) => file.name === `${exportBaseName}.ko.srt`);
  assert(
    sortedFiles.length === 4 &&
      exportedFiles.length === 3 &&
      preexistingFile?.name === `${PROJECT_NAME}.kirinuki.json` &&
      videoFile &&
      jsonFile &&
      srtFile,
    `기존 파일을 보존한 채 (2) 영상·JSON·SRT 세 파일이 생성되지 않았습니다: ${JSON.stringify(
      sortedFiles.map(({ name, size, committed, preexisting }) => ({
        name,
        size,
        committed,
        preexisting
      }))
    )}`
  );
  const preexistingText = Buffer.from(preexistingFile.base64, "base64").toString("utf8");
  assert(
    preexistingText === PREEXISTING_SIDECAR_TEXT &&
      preexistingFile.createWritableCalls.length === 0 &&
      preexistingFile.closeUiSnapshots.length === 0 &&
      preexistingFile.closeCount === 0 &&
      preexistingFile.abortCount === 0 &&
      preexistingFile.transactions.length === 0,
    `기존 basename 충돌 파일이 덮어써졌습니다: ${JSON.stringify({
      name: preexistingFile.name,
      text: preexistingText,
      createWritableCalls: preexistingFile.createWritableCalls,
      closeUiSnapshots: preexistingFile.closeUiSnapshots,
      closeCount: preexistingFile.closeCount,
      abortCount: preexistingFile.abortCount,
      transactions: preexistingFile.transactions
    })}`
  );
  assert(
    videoFile.name === `${exportBaseName}.${videoFile.name.split(".").at(-1)}`,
    `충돌 시 영상 파일명이 (2) basename 기반이 아닙니다: ${videoFile.name}`
  );
  for (const file of exportedFiles) {
    assert(
      file.committed &&
        file.createWritableCalls.length === 1 &&
        file.closeCount === 1 &&
        file.abortCount === 0 &&
        file.transactions.length === 1 &&
        file.transactions[0].at(-1)?.type === "close",
      `파일 writable이 정상 commit되지 않았습니다: ${JSON.stringify({
        name: file.name,
        committed: file.committed,
        createWritableCalls: file.createWritableCalls,
        closeCount: file.closeCount,
        abortCount: file.abortCount,
        transactions: file.transactions
      })}`
    );
  }
  assert(
    videoFile.size > 10_000 &&
      videoFile.transactions[0].some(
        (operation) => operation.type === "write" && operation.mode === "positioned"
      ),
    `영상이 positioned write로 저장되지 않았습니다: ${JSON.stringify({
      name: videoFile.name,
      size: videoFile.size,
      operations: videoFile.transactions[0]
    })}`
  );
  const finalizeUi = videoFile.closeUiSnapshots[0];
  assert(
    videoFile.closeUiSnapshots.length === 1 &&
      finalizeUi.jobHidden === false &&
      finalizeUi.jobOpen === true &&
      /마무리/.test(finalizeUi.message) &&
      finalizeUi.percent === "100%" &&
      finalizeUi.progressWidth === "100%" &&
      finalizeUi.cancelHidden === true &&
      finalizeUi.cancelDisabled === true,
    `영상 writable close 시 최종화 UI/취소 잠금 상태가 아닙니다: ${JSON.stringify(
      videoFile.closeUiSnapshots
    )}`
  );
  assert(
    jsonFile.transactions[0].some(
      (operation) => operation.type === "write" && operation.mode === "raw"
    ) &&
      srtFile.transactions[0].some(
        (operation) => operation.type === "write" && operation.mode === "raw"
      ),
    "JSON/SRT가 Blob raw write 경로를 사용하지 않았습니다."
  );
  assert(
    memoryDirectory.pickerCalls.length === 1 &&
      memoryDirectory.pickerCalls[0].id === "chzzk-kirinuki-export" &&
      memoryDirectory.pickerCalls[0].mode === "readwrite" &&
      memoryDirectory.savePickerCalls.length === 0 &&
      memoryDirectory.anchorDownloads.length === 0,
    `directory picker 우선/fallback 미사용 계약 위반: ${JSON.stringify({
      pickerCalls: memoryDirectory.pickerCalls,
      savePickerCalls: memoryDirectory.savePickerCalls,
      anchorDownloads: memoryDirectory.anchorDownloads
    })}`
  );
  assert(
    (() => {
      const extension = videoFile.name.split(".").at(-1);
      const lookupCalls = memoryDirectory.getFileHandleCalls.filter((call) => !call.create);
      const createCalls = memoryDirectory.getFileHandleCalls.filter((call) => call.create);
      const expectedLookups = [
        `${PROJECT_NAME}.${extension}`,
        `${PROJECT_NAME}.kirinuki.json`,
        `${PROJECT_NAME}.ko.srt`,
        `${exportBaseName}.${extension}`,
        `${exportBaseName}.kirinuki.json`,
        `${exportBaseName}.ko.srt`
      ];
      const expectedCreates = [
        `${exportBaseName}.${extension}`,
        `${exportBaseName}.kirinuki.json`,
        `${exportBaseName}.ko.srt`
      ];
      return lookupCalls.length === expectedLookups.length &&
        createCalls.length === expectedCreates.length &&
        lookupCalls.map((call) => call.name).join(",") === expectedLookups.join(",") &&
        createCalls.map((call) => call.name).join(",") === expectedCreates.join(",");
    })(),
    `unique basename 조회/생성 순서가 다릅니다: ${JSON.stringify(
      memoryDirectory.getFileHandleCalls
    )}`
  );

  const jsonText = Buffer.from(jsonFile.base64, "base64").toString("utf8");
  const srtText = Buffer.from(srtFile.base64, "base64").toString("utf8");
  assert(jsonText.endsWith("\n"), "kirinuki JSON sidecar가 trailing newline 없이 저장됐습니다.");
  const exportedProject = JSON.parse(jsonText);
  assert(
    exportedProject.id === PROJECT_ID &&
      exportedProject.name === PROJECT_NAME &&
      exportedProject.clips?.map((clip) => clip.id).join(",") === "clip-blue,clip-red" &&
      exportedProject.subtitles?.length === 2 &&
      exportedProject.subtitles[0].text === CAPTION_TEXT &&
      exportedProject.subtitles[0].lane === 0 &&
      exportedProject.subtitles[0].color === FIRST_CAPTION_COLOR &&
      exportedProject.subtitles[1].text === SECOND_CAPTION_TEXT &&
      exportedProject.subtitles[1].lane === 1 &&
      exportedProject.subtitles[1].color === SECOND_CAPTION_COLOR &&
      exportedProject.subtitles.every((cue) => cue.origin === "human") &&
      exportedProject.imageAssets?.length === 1 &&
      exportedProject.imageAssets[0].id === IMAGE_ASSET_ID &&
      exportedProject.imageAssets[0].clipId === "clip-blue" &&
      exportedProject.imageAssets[0].startOffsetMs === 200 &&
      exportedProject.imageAssets[0].endOffsetMs === 800 &&
      exportedProject.imageAssets[0].source?.kind === "blob-key" &&
      exportedProject.imageAssets[0].source.value === IMAGE_ASSET_ID &&
      exportedProject.imageAssets[0].naturalWidth === 120 &&
      exportedProject.imageAssets[0].naturalHeight === 120 &&
      exportedProject.imageAssets[0].scale === 2 &&
      exportedProject.imageAssets[0].opacity === 1 &&
      exportedProject.audioRegions?.length === 3 &&
      exportedProject.audioRegions.some((region) => (
        region.id === gainRegion.id && Math.abs(region.gain - 0.25) < 0.001
      )) &&
      exportedProject.audioRegions.some((region) => (
        region.id === mutedRegion.id && region.muted === true
      )) &&
      exportedProject.audioRegions.some((region) => (
        region.id === fadeRegion.id &&
        Math.abs(region.gain - 0.2) < 0.001 &&
        region.fadeInMs === 500 &&
        region.fadeOutMs === 500
      )),
    `kirinuki JSON 내용이 editor 프로젝트와 다릅니다: ${jsonText.slice(0, 2_000)}`
  );
  const expectedSrt = captionCues.map((cue, index) => {
    const clip = captionProject.clips.find((candidate) => candidate.id === cue.clipId);
    return [
      index + 1,
      `${formatSrtTime(clip.timelineStartMs + cue.startOffsetMs)} --> ` +
        formatSrtTime(clip.timelineStartMs + cue.endOffsetMs),
      cue.text,
      ""
    ].join("\n");
  }).join("\n");
  assert(
    srtText === expectedSrt,
    `SRT 파일 내용이 autosave 프로젝트와 다릅니다:\nexpected=${expectedSrt}\nactual=${srtText}`
  );

  const downloadedVideo = path.join(tempRoot, videoFile.name);
  await writeFile(downloadedVideo, Buffer.from(videoFile.base64, "base64"));

  const outputProbe = await probeMedia(ffprobe, downloadedVideo);
  const videoStream = outputProbe.streams.find((stream) => stream.codec_type === "video");
  const audioStream = outputProbe.streams.find((stream) => stream.codec_type === "audio");
  assert(videoStream, `내보낸 파일에 video stream이 없습니다: ${JSON.stringify(outputProbe)}`);
  assert(audioStream, `내보낸 파일에 audio stream이 없습니다: ${JSON.stringify(outputProbe)}`);

  const outputDuration = Number(outputProbe.format?.duration);
  const frameTolerance = 1 / EXPECTED_FRAME_RATE + 0.002;
  assert(
    Number.isFinite(outputDuration)
      && Math.abs(outputDuration - EXPECTED_DURATION_SECONDS) <= frameTolerance,
    `내보낸 길이가 예상 타임라인과 다릅니다: ${outputDuration}s (expected ${EXPECTED_DURATION_SECONDS}s)`
  );
  const readFrames = Number(videoStream.nb_read_frames || videoStream.nb_frames);
  if (Number.isFinite(readFrames) && readFrames > 0) {
    assert(
      Math.abs(readFrames - EXPECTED_DURATION_SECONDS * EXPECTED_FRAME_RATE) <= 1,
      `내보낸 video frame 수가 예상과 다릅니다: ${readFrames}`
    );
  }

  const gainTimelineStart = (
    audioProject.clips.find((clip) => clip.id === gainRegion.clipId).timelineStartMs +
    gainRegion.startOffsetMs
  ) / 1_000;
  const mutedTimelineStart = (
    audioProject.clips.find((clip) => clip.id === mutedRegion.clipId).timelineStartMs +
    mutedRegion.startOffsetMs
  ) / 1_000;
  const mutedTimelineEnd = (
    audioProject.clips.find((clip) => clip.id === mutedRegion.clipId).timelineStartMs +
    mutedRegion.endOffsetMs
  ) / 1_000;
  const fadeTimelineStart = (
    audioProject.clips.find((clip) => clip.id === fadeRegion.clipId).timelineStartMs +
    fadeRegion.startOffsetMs
  ) / 1_000;
  const fadeTimelineEnd = (
    audioProject.clips.find((clip) => clip.id === fadeRegion.clipId).timelineStartMs +
    fadeRegion.endOffsetMs
  ) / 1_000;
  const [
    firstColor,
    secondColor,
    firstAudio,
    secondAudio,
    assetPixels,
    captionPixels,
    gainAudio,
    mutedAudio,
    baselineAudio,
    fadeInAudio,
    fadeCenterAudio,
    fadeOutAudio
  ] = await Promise.all([
    sampleFrameRgb(ffmpeg, downloadedVideo, 0.75),
    sampleFrameRgb(ffmpeg, downloadedVideo, 2.75),
    sampleAudioPcm(ffmpeg, downloadedVideo, 0.5),
    sampleAudioPcm(ffmpeg, downloadedVideo, 2.5),
    sampleFrameRgbPixels(ffmpeg, downloadedVideo, 0.5),
    sampleFrameRgbPixels(ffmpeg, downloadedVideo, 1.5),
    sampleAudioPcm(ffmpeg, downloadedVideo, gainTimelineStart + 0.2, 0.25),
    sampleAudioPcm(
      ffmpeg,
      downloadedVideo,
      (mutedTimelineStart + mutedTimelineEnd) / 2 - 0.1,
      0.2
    ),
    sampleAudioPcm(ffmpeg, downloadedVideo, mutedTimelineEnd + 0.2, 0.25),
    sampleAudioPcm(ffmpeg, downloadedVideo, fadeTimelineStart + 0.05, 0.15),
    sampleAudioPcm(
      ffmpeg,
      downloadedVideo,
      (fadeTimelineStart + fadeTimelineEnd) / 2 - 0.075,
      0.15
    ),
    sampleAudioPcm(ffmpeg, downloadedVideo, fadeTimelineEnd - 0.2, 0.15)
  ]);
  assert(
    firstColor.blue > firstColor.red + 100,
    `첫 컷이 파랑이 아닙니다: ${JSON.stringify(firstColor)}`
  );
  assert(
    secondColor.red > secondColor.blue + 100,
    `둘째 컷이 빨강이 아닙니다: ${JSON.stringify(secondColor)}`
  );

  const assetBaseFit = Math.min(
    1,
    FRAME_WIDTH * 0.35 / imageAsset.naturalWidth,
    FRAME_HEIGHT * 0.35 / imageAsset.naturalHeight
  );
  const assetRenderWidth = imageAsset.naturalWidth * assetBaseFit * imageAsset.scale;
  const assetRenderHeight = imageAsset.naturalHeight * assetBaseFit * imageAsset.scale;
  const assetRenderLeft = FRAME_WIDTH * imageAsset.x - assetRenderWidth / 2;
  const assetRenderTop = FRAME_HEIGHT * imageAsset.y - assetRenderHeight / 2;
  const assetComposite = {
    background: averageRgbRegion(assetPixels, { x: 40, y: 40 }),
    transparentCorner: averageRgbRegion(assetPixels, {
      x: assetRenderLeft + 8,
      y: assetRenderTop + 8
    }),
    opaqueRed: averageRgbRegion(assetPixels, {
      x: assetRenderLeft + 65,
      y: assetRenderTop + 105,
      width: 16,
      height: 16
    }),
    semiGreenOverBlue: averageRgbRegion(assetPixels, {
      x: assetRenderLeft + 165,
      y: assetRenderTop + 105,
      width: 16,
      height: 16
    }),
    geometry: {
      baseFit: assetBaseFit,
      left: assetRenderLeft,
      top: assetRenderTop,
      width: assetRenderWidth,
      height: assetRenderHeight
    }
  };
  const transparentBackgroundDelta = (
    Math.abs(assetComposite.transparentCorner.red - assetComposite.background.red) +
    Math.abs(assetComposite.transparentCorner.green - assetComposite.background.green) +
    Math.abs(assetComposite.transparentCorner.blue - assetComposite.background.blue)
  );
  assert(
    assetComposite.background.blue >= 150 &&
      assetComposite.background.blue >= assetComposite.background.red + 100 &&
      assetComposite.background.blue >= assetComposite.background.green + 100,
    `에셋 합성 기준 배경이 파랑이 아닙니다: ${JSON.stringify(assetComposite)}`
  );
  assert(
    assetComposite.opaqueRed.red >= 150 &&
      assetComposite.opaqueRed.red >= assetComposite.opaqueRed.green + 90 &&
      assetComposite.opaqueRed.red >= assetComposite.opaqueRed.blue + 90,
    `투명 PNG의 불투명 빨강 픽셀이 영상에 합성되지 않았습니다: ${JSON.stringify(assetComposite)}`
  );
  assert(
    assetComposite.semiGreenOverBlue.green >= 70 &&
      assetComposite.semiGreenOverBlue.blue >= 70 &&
      assetComposite.semiGreenOverBlue.red <= 60 &&
      assetComposite.semiGreenOverBlue.green >= assetComposite.background.green + 60 &&
      assetComposite.semiGreenOverBlue.blue <= assetComposite.background.blue - 40,
    `투명 PNG의 반투명 초록이 파랑 배경과 혼합되지 않았습니다: ${JSON.stringify(assetComposite)}`
  );
  assert(
    transparentBackgroundDelta <= 45 &&
      assetComposite.transparentCorner.blue >= 150 &&
      assetComposite.transparentCorner.blue >= assetComposite.transparentCorner.red + 100,
    `투명 PNG 모서리에서 원본 파랑 배경이 드러나지 않습니다: delta=${transparentBackgroundDelta} ` +
      JSON.stringify(assetComposite)
  );
  assetComposite.transparentBackgroundDelta = transparentBackgroundDelta;

  const captionColorAnalysis = analyzeCaptionColors(captionPixels);
  assert(
    captionColorAnalysis.red.count >= 40 &&
      captionColorAnalysis.green.count >= 40 &&
      captionColorAnalysis.green.centerY < captionColorAnalysis.red.centerY - 12,
    "렌더 프레임에서 서로 다른 위치의 빨강·초록 동시 자막을 확인하지 못했습니다: " +
      JSON.stringify(captionColorAnalysis)
  );

  const firstTone = {
    hz440: tonePower(firstAudio, 8_000, 440),
    hz880: tonePower(firstAudio, 8_000, 880)
  };
  const secondTone = {
    hz440: tonePower(secondAudio, 8_000, 440),
    hz880: tonePower(secondAudio, 8_000, 880)
  };
  assert(
    firstTone.hz880 > firstTone.hz440 * 4,
    `첫 컷 오디오가 880Hz 우세가 아닙니다: ${JSON.stringify(firstTone)}`
  );
  assert(
    secondTone.hz440 > secondTone.hz880 * 4,
    `둘째 컷 오디오가 440Hz 우세가 아닙니다: ${JSON.stringify(secondTone)}`
  );

  const audioLevels = {
    gain25: audioRms(gainAudio),
    muted: audioRms(mutedAudio),
    unaffected: audioRms(baselineAudio),
    fadeInEdge: audioRms(fadeInAudio),
    fadeCenter20: audioRms(fadeCenterAudio),
    fadeOutEdge: audioRms(fadeOutAudio)
  };
  assert(
    audioLevels.gain25 < audioLevels.unaffected * 0.4 &&
      audioLevels.gain25 > audioLevels.unaffected * 0.12,
    `25% gain이 실제 PCM 진폭에 반영되지 않았습니다: ${JSON.stringify(audioLevels)}`
  );
  assert(
    audioLevels.muted < audioLevels.unaffected * 0.03,
    `mute가 실제 PCM을 충분히 무음으로 만들지 않았습니다: ${JSON.stringify(audioLevels)}`
  );
  assert(
    audioLevels.fadeInEdge > audioLevels.fadeCenter20 * 2.3 &&
      audioLevels.fadeOutEdge > audioLevels.fadeCenter20 * 2.3,
    `fade in/out이 실제 PCM 가장자리→중앙 곡선에 반영되지 않았습니다: ${JSON.stringify(audioLevels)}`
  );

  const browserLogs = await webdriver("POST", `/session/${sessionId}/log`, { type: "browser" });
  const severeLogs = browserLogs.filter((entry) => entry.level === "SEVERE");
  const expectedLocalCaptionOffline = severeLogs.filter(
    isExpectedLocalCaptionOffline
  );
  const unexpectedSevereLogs = severeLogs.filter(
    (entry) => !isExpectedLocalCaptionOffline(entry)
  );
  assert(
    expectedLocalCaptionOffline.length <= 2,
    "로컬 Whisper startup offline probe가 예상보다 많이 반복됐습니다.\n"
      + JSON.stringify(expectedLocalCaptionOffline, null, 2)
  );
  assert(
    unexpectedSevereLogs.length === 0,
    `브라우저 SEVERE 로그가 있습니다:\n${JSON.stringify(unexpectedSevereLogs, null, 2)}`
  );

  const downloads = await readdir(downloadRoot).catch(() => []);
  assert(
    downloads.length === 0,
    `directory export 중 browser download fallback 파일이 생겼습니다: ${JSON.stringify(downloads)}`
  );
  console.log(JSON.stringify({
    ok: true,
    chromium,
    chromedriver,
    ffmpeg,
    ffprobe,
    extensionId,
    projectId: PROJECT_ID,
    fixture: {
      startTime: Number(fixtureProbe.format.start_time),
      duration: Number(fixtureProbe.format.duration),
      mediaOriginMs: attachedProject.mediaAsset.mediaOriginMs,
      editorDurationMs: attachedProject.mediaAsset.durationMs,
      attachedPreviewMedia,
      transparentImageAsset: transparentAssetFixture
    },
    project: {
      clipOrder: reorderedProject.clips.map((clip) => clip.id),
      durationMs: reorderedProject.clips.reduce(
        (total, clip) => total + clip.sourceEndMs - clip.sourceStartMs,
        0
      ),
      timelineUi: {
        reorderedTimeline,
        safePointerTargets,
        firstSeekPlayhead,
        safePlayhead,
        seekEventLog
      },
      captions: captionCues.map((cue) => ({
        text: cue.text,
        lane: cue.lane,
        color: cue.color,
        startOffsetMs: cue.startOffsetMs,
        endOffsetMs: cue.endOffsetMs
      })),
      imageAssets: imageAssetProject.imageAssets,
      audioRegions: audioProject.audioRegions,
      audioUiActions
    },
    output: {
      fileName: path.basename(downloadedVideo),
      downloads,
      directory: {
        fakeWritableContract: pickerOverride.contractProbe,
        pickerCalls: memoryDirectory.pickerCalls,
        savePickerCalls: memoryDirectory.savePickerCalls,
        anchorDownloads: memoryDirectory.anchorDownloads,
        files: sortedFiles.map((file) => ({
          name: file.name,
          size: file.size,
          preexisting: file.preexisting,
          closeCount: file.closeCount,
          abortCount: file.abortCount,
          closeUiSnapshots: file.closeUiSnapshots,
          operations: file.transactions[0]
        }))
      },
      sidecars: {
        jsonName: jsonFile.name,
        srtName: srtFile.name,
        jsonProjectId: exportedProject.id,
        jsonClipOrder: exportedProject.clips.map((clip) => clip.id),
        jsonCaptions: exportedProject.subtitles.map((cue) => ({
          text: cue.text,
          lane: cue.lane,
          color: cue.color
        })),
        jsonImageAssets: exportedProject.imageAssets,
        jsonAudioRegions: exportedProject.audioRegions,
        srt: srtText
      },
      format: outputProbe.format,
      video: videoStream,
      audio: audioStream,
      firstColor,
      secondColor,
      assetComposite,
      captionColorAnalysis,
      firstTone,
      secondTone,
      audioLevels
    },
    encoderEnvironment: {
      productProfileAvailable,
      diagnostics: encoderDiagnostics
    },
    exportUi,
    browserSevereLogs: unexpectedSevereLogs.length,
    expectedLocalCaptionOffline: expectedLocalCaptionOffline.length
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  if (driverOutput.trim()) {
    console.error("\nChromeDriver output:\n" + driverOutput.trim());
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
