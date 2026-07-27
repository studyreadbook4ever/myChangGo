import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = path.resolve(process.argv[2] || path.join(root, "extension"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-kirinuki-browser-smoke-"));
const profileRoot = path.join(tempRoot, "chromium-profile");
const asrPcmPath = process.env.KIRINUKI_ASR_PCM
  ? path.resolve(process.env.KIRINUKI_ASR_PCM)
  : "";

let driver = null;
let sessionId = "";
let cleanupPromise = null;
let driverOutput = "";

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

function appendDriverOutput(chunk) {
  driverOutput += chunk.toString();
  if (driverOutput.length > 80_000) {
    driverOutput = driverOutput.slice(-80_000);
  }
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

async function waitForDriver(baseUrl) {
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
  const targetUrl = `http://${debuggerAddress}/json/list`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await fetchJson(targetUrl, { timeout: 2_000 });
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

async function webdriver(baseUrl, method, commandPath, body, timeout = 30_000) {
  const payload = await fetchJson(`${baseUrl}${commandPath}`, { method, body, timeout });
  if (payload?.value?.error) {
    throw new Error(`${payload.value.error}: ${payload.value.message || "WebDriver 명령 실패"}`);
  }
  return payload?.value;
}

async function terminateDriver() {
  if (!driver || driver.exitCode !== null) {
    return;
  }

  const waitForExit = async (milliseconds) => {
    if (driver.exitCode !== null) {
      return true;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        driver.off("exit", onExit);
        resolve(false);
      }, milliseconds);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      driver.once("exit", onExit);
    });
  };

  const signal = (name) => {
    try {
      if (process.platform === "win32") {
        driver.kill(name);
      } else {
        process.kill(-driver.pid, name);
      }
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };

  signal("SIGTERM");
  if (!await waitForExit(3_000)) {
    signal("SIGKILL");
    await waitForExit(3_000);
  }
}

async function cleanup() {
  if (cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = (async () => {
    if (sessionId && driver?.exitCode === null) {
      try {
        await fetchJson(`http://127.0.0.1:${driver.port}/session/${sessionId}`, {
          method: "DELETE",
          timeout: 5_000
        });
      } catch {
        // 아래 process-group 종료가 남은 Chromium까지 정리한다.
      }
      sessionId = "";
    }
    await terminateDriver();
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

async function main() {
  const manifestPath = path.join(extensionRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const serviceWorkerPath = manifest.background?.service_worker;
  assert(serviceWorkerPath, "manifest에 background.service_worker가 없습니다.");

  for (const requiredPath of [
    serviceWorkerPath,
    "editor.html",
    "sidepanel.html",
    "editor/editor.js",
    "editor/asr-worker.js",
    "editor/vendor/ort-wasm-simd-threaded.jsep.wasm"
  ]) {
    await access(path.join(extensionRoot, requiredPath));
  }

  const [chromedriver, chromium, port] = await Promise.all([
    resolveExecutable("CHROMEDRIVER_BINARY", ["chromedriver"]),
    resolveExecutable("CHROMIUM_BINARY", ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]),
    reservePort()
  ]);
  const baseUrl = `http://127.0.0.1:${port}`;

  driver = spawn(chromedriver, [`--port=${port}`], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  driver.port = port;
  driver.stdout.on("data", appendDriverOutput);
  driver.stderr.on("data", appendDriverOutput);

  await waitForDriver(baseUrl);

  const created = await webdriver(baseUrl, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        "goog:loggingPrefs": { browser: "ALL" },
        "goog:chromeOptions": {
          binary: chromium,
          args: [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
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

  const debuggerAddress = created.capabilities?.["goog:chromeOptions"]?.debuggerAddress;
  assert(debuggerAddress, "Chrome DevTools debugger address를 받지 못했습니다.");
  const extensionTarget = await waitForExtensionTarget(debuggerAddress, serviceWorkerPath);
  const extensionId = new URL(extensionTarget.url).host;
  assert(extensionId, "service worker target에서 extension ID를 찾지 못했습니다.");

  const editorUrl = `chrome-extension://${extensionId}/editor.html`;
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: editorUrl });
  const editor = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const requiredIds = [
        "preview-video",
        "subtitle-overlay",
        "video-track",
        "caption-track",
        "cue-text",
        "cue-start",
        "cue-end",
        "cue-x",
        "cue-y",
        "generate-captions",
        "export-video"
      ];
      return {
        title: document.title,
        readyState: document.readyState,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        missingIds: requiredIds.filter((id) => !document.getElementById(id))
      };
    `,
    args: []
  });
  assert(editor.readyState === "complete", `editor readyState가 complete가 아닙니다: ${editor.readyState}`);
  assert(editor.crossOriginIsolated === true, "editor가 cross-origin isolated 상태가 아닙니다.");
  assert(editor.sharedArrayBuffer === "function", "editor에서 SharedArrayBuffer를 사용할 수 없습니다.");
  assert(editor.missingIds.length === 0, `editor 핵심 DOM 누락: ${editor.missingIds.join(", ")}`);

  const runtime = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      const timeout = setTimeout(() => done({ error: "ASR worker boot timeout" }), 8_000);
      (async () => {
        const wasmUrl = chrome.runtime.getURL("editor/vendor/ort-wasm-simd-threaded.jsep.wasm");
        const response = await fetch(wasmUrl);
        if (!response.ok) {
          throw new Error("WASM asset HTTP " + response.status);
        }
        const bytes = await response.arrayBuffer();
        await WebAssembly.compile(bytes);

        const worker = new Worker(chrome.runtime.getURL("editor/asr-worker.js"), { type: "module" });
        const workerResult = await new Promise((resolve) => {
          const workerTimeout = setTimeout(() => resolve({ ok: false, error: "disposed 응답 timeout" }), 5_000);
          worker.addEventListener("message", (event) => {
            if (event.data?.type === "disposed") {
              clearTimeout(workerTimeout);
              resolve({ ok: true });
            }
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(workerTimeout);
            resolve({ ok: false, error: event.message || "ASR worker module error" });
          });
          worker.postMessage({ type: "dispose" });
        });
        worker.terminate();
        clearTimeout(timeout);
        done({
          wasmStatus: response.status,
          wasmBytes: bytes.byteLength,
          wasmCompiled: true,
          worker: workerResult
        });
      })().catch((error) => {
        clearTimeout(timeout);
        done({ error: String(error?.stack || error) });
      });
    `,
    args: []
  });
  assert(!runtime.error, `editor runtime asset 검사 실패: ${runtime.error}`);
  assert(runtime.wasmStatus === 200, `WASM asset 응답 실패: HTTP ${runtime.wasmStatus}`);
  assert(runtime.wasmBytes > 8, `WASM asset이 비어 있습니다: ${runtime.wasmBytes} bytes`);
  assert(runtime.wasmCompiled === true, "WASM asset 컴파일에 실패했습니다.");
  assert(runtime.worker?.ok === true, `ASR worker 부팅 실패: ${runtime.worker?.error || "알 수 없는 오류"}`);

  let asrRuntime = null;
  if (asrPcmPath) {
    const pcmBytes = await readFile(asrPcmPath);
    assert(pcmBytes.byteLength > 0 && pcmBytes.byteLength % 4 === 0, "ASR smoke PCM은 비어 있지 않은 f32le 파일이어야 합니다.");
    const pcmBase64 = pcmBytes.toString("base64");
    asrRuntime = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
      script: `
        const [pcmBase64] = arguments;
        const done = arguments[arguments.length - 1];
        const timeout = setTimeout(() => done({ error: "실제 ASR timeout" }), 300_000);
        const binary = atob(pcmBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const audio = new Float32Array(bytes.buffer);
        const worker = new Worker(chrome.runtime.getURL("editor/asr-worker.js"), { type: "module" });
        const progress = [];
        worker.addEventListener("message", (event) => {
          const message = event.data || {};
          if (message.jobId !== "browser-asr-smoke") {
            return;
          }
          if (message.type === "progress") {
            progress.push(message.progress);
          } else if (message.type === "result") {
            clearTimeout(timeout);
            worker.terminate();
            done({
              text: message.text,
              chunks: message.chunks,
              speechDetected: message.speechDetected,
              progress
            });
          } else if (message.type === "error") {
            clearTimeout(timeout);
            worker.terminate();
            done({ error: message.error, progress });
          }
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          worker.terminate();
          done({ error: event.message || "ASR worker module error", progress });
        });
        worker.postMessage({
          type: "transcribe",
          jobId: "browser-asr-smoke",
          model: "Xenova/whisper-tiny",
          audio
        }, [audio.buffer]);
      `,
      args: [pcmBase64]
    }, 330_000);
    assert(!asrRuntime.error, `실제 Whisper Tiny 전사 실패: ${asrRuntime.error}`);
    assert(asrRuntime.speechDetected === true, "한국어 음성 샘플을 무음으로 잘못 판정했습니다.");
    assert(Array.isArray(asrRuntime.chunks) && asrRuntime.chunks.length > 0, "한국어 음성에서 전사 chunk가 나오지 않았습니다.");
    assert(/[가-힣]{2}/u.test(asrRuntime.text), `한국어 전사 결과를 확인하지 못했습니다: ${asrRuntime.text}`);
    assert(asrRuntime.chunks.every((chunk) => chunk.timestamp[1] > chunk.timestamp[0]), "0초 길이 ASR chunk가 남았습니다.");
    assert(asrRuntime.progress.every((value, index, values) => index === 0 || value >= values[index - 1]), "ASR 진행률이 역행했습니다.");
    const progressValues = asrRuntime.progress;
    asrRuntime = {
      ...asrRuntime,
      progress: {
        events: progressValues.length,
        first: progressValues[0] ?? null,
        last: progressValues.at(-1) ?? null
      }
    };
  }

  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: sidepanelUrl });
  const sidepanel = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const requiredIds = [
        "capture-start",
        "capture-end",
        "save-segment",
        "open-editor",
        "create-codex-job",
        "generate-prompt"
      ];
      return {
        title: document.title,
        readyState: document.readyState,
        missingIds: requiredIds.filter((id) => !document.getElementById(id))
      };
    `,
    args: []
  });
  assert(sidepanel.readyState === "complete", `sidepanel readyState가 complete가 아닙니다: ${sidepanel.readyState}`);
  assert(sidepanel.missingIds.length === 0, `sidepanel 핵심 DOM 누락: ${sidepanel.missingIds.join(", ")}`);

  await delay(300);
  const browserLogs = await webdriver(baseUrl, "POST", `/session/${sessionId}/log`, { type: "browser" });
  const severeLogs = browserLogs.filter((entry) => entry.level === "SEVERE");
  assert(severeLogs.length === 0, `브라우저 SEVERE 로그가 있습니다:\n${JSON.stringify(severeLogs, null, 2)}`);

  console.log(JSON.stringify({
    ok: true,
    chromium,
    chromedriver,
    extensionId,
    serviceWorker: extensionTarget.url,
    editor,
    runtime,
    asrRuntime,
    sidepanel,
    browserSevereLogs: severeLogs.length
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
