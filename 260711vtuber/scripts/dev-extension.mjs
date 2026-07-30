import { readFileSync, unlinkSync, watch } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  classifyDevReload,
  createDevReloadMarker,
  devChangeNeedsBuild,
  normalizeDevChangedPath,
  removeOwnedDevReloadMarker,
  writeDevReloadMarker
} from "./dev-hot-reload-core.mjs";
import {
  acquireDevRunnerLock,
  releaseDevRunnerLock,
  releaseDevRunnerLockSync
} from "./dev-runner-lock.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const markerPath = path.join(root, "extension", "dev-reload.json");
const lockPath = path.join(root, ".dev-editor.lock");
const debounceMs = 180;
const watchedDirectories = [
  path.join(root, "src", "editor"),
  path.join(root, "src"),
  path.join(root, "extension"),
  path.join(root, "extension", "editor"),
  path.join(root, "extension", "lib")
];
const watchedFiles = new Set([
  "src/content-script.js",
  "extension/editor.html",
  "extension/editor/editor.css",
  "extension/manifest.json",
  "extension/service-worker.js",
  "extension/sidepanel.html",
  "extension/sidepanel.css",
  "extension/sidepanel.js",
  "extension/lib/caption-style.js",
  "extension/lib/core.js",
  "extension/lib/editor-core.js",
  "extension/lib/session-recovery.js",
  "extension/lib/source-platform.js"
]);

let revisionSequence = 0;
let buildInProgress = false;
let rebuildRequested = false;
let debounceTimer = null;
let shuttingDown = false;
let runnerLockLease = null;
let activeBuildChild = null;
let cleanupPromise = null;
const pendingFiles = new Set();
const watchers = [];

function nextRevision() {
  revisionSequence += 1;
  return `${Date.now().toString(36)}-${revisionSequence.toString(36)}`;
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "build-editor.mjs")], {
      cwd: root,
      stdio: "inherit"
    });
    activeBuildChild = child;
    child.once("error", (error) => {
      if (activeBuildChild === child) {
        activeBuildChild = null;
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeBuildChild === child) {
        activeBuildChild = null;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `빌드 프로세스가 ${signal} 신호로 종료됐습니다.`
          : `빌드 프로세스가 종료 코드 ${code}로 끝났습니다.`
      ));
    });
  });
}

function trackedChangedPath(directory, filename) {
  if (!filename) {
    return null;
  }
  const relativePath = normalizeDevChangedPath(root, path.join(directory, filename));
  if (
    relativePath.startsWith("src/editor/")
  ) {
    return relativePath;
  }
  return watchedFiles.has(relativePath) ? relativePath : null;
}

async function publishChange(files) {
  const kind = classifyDevReload(files);
  if (kind === "none") {
    return;
  }
  if (devChangeNeedsBuild(files)) {
    await runBuild();
  }
  const marker = createDevReloadMarker({
    revision: nextRevision(),
    kind,
    changedFiles: files
  });
  await writeDevReloadMarker(markerPath, marker);
  const action = {
    style: "CSS를 상태 보존 교체합니다",
    editor: "CURRENT 저장 검증 후 편집기 탭을 다시 엽니다",
    content: "원본 영상 탭은 자동으로 건드리지 않습니다",
    extension: "확장 재로드가 필요하므로 현재 편집 상태만 보존합니다"
  }[kind];
  console.log(`[dev:editor] ${marker.revision} · ${kind} · ${action}`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}

async function drainChanges() {
  if (buildInProgress || shuttingDown) {
    rebuildRequested = true;
    return;
  }
  const files = [...pendingFiles].sort();
  pendingFiles.clear();
  if (files.length === 0) {
    return;
  }
  buildInProgress = true;
  try {
    await publishChange(files);
  } catch (error) {
    console.error(`[dev:editor] 변경을 적용하지 않았습니다: ${error.message}`);
  } finally {
    buildInProgress = false;
    if (!shuttingDown && (pendingFiles.size > 0 || rebuildRequested)) {
      rebuildRequested = false;
      queueDrain();
    }
  }
}

function queueDrain() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void drainChanges();
  }, debounceMs);
}

function observe(directory) {
  const watcher = watch(directory, { persistent: true }, (_eventType, filename) => {
    const changedPath = trackedChangedPath(directory, filename?.toString());
    if (!changedPath) {
      return;
    }
    pendingFiles.add(changedPath);
    queueDrain();
  });
  watcher.on("error", (error) => {
    console.error(`[dev:editor] 감시 실패 (${directory}): ${error.message}`);
  });
  watchers.push(watcher);
}

async function ensureSingleRunner() {
  try {
    await unlink(markerPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateActiveBuild() {
  const child = activeBuildChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (!await waitForChildExit(child, 5_000)) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  }
}

async function cleanup() {
  if (cleanupPromise) {
    return cleanupPromise;
  }
  shuttingDown = true;
  cleanupPromise = (async () => {
    clearTimeout(debounceTimer);
    for (const watcher of watchers) {
      watcher.close();
    }
    await terminateActiveBuild();
    try {
      await removeOwnedDevReloadMarker(markerPath);
      try {
        await unlink(`${markerPath}.${process.pid}.tmp`);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    } finally {
      await releaseDevRunnerLock(runnerLockLease);
    }
  })();
  return cleanupPromise;
}

function removeOwnedFileSync(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (value?.pid === process.pid) {
      unlinkSync(filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.error(`[dev:editor] 종료 정리 실패 (${filePath}): ${error.message}`);
    }
  }
}

function cleanupSync() {
  clearTimeout(debounceTimer);
  for (const watcher of watchers) {
    watcher.close();
  }
  if (
    activeBuildChild
    && activeBuildChild.exitCode === null
    && activeBuildChild.signalCode === null
  ) {
    activeBuildChild.kill("SIGKILL");
  }
  removeOwnedFileSync(markerPath);
  releaseDevRunnerLockSync(runnerLockLease);
  try {
    unlinkSync(`${markerPath}.${process.pid}.tmp`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`[dev:editor] 임시 marker 정리 실패: ${error.message}`);
    }
  }
}

async function main() {
  runnerLockLease = await acquireDevRunnerLock(lockPath, {
    pid: process.pid,
    role: "editor"
  });
  await ensureSingleRunner();
  await runBuild();
  await writeDevReloadMarker(markerPath, createDevReloadMarker({
    revision: nextRevision(),
    kind: "initial",
    changedFiles: []
  }));

  const existingDirectories = [];
  for (const directory of watchedDirectories) {
    try {
      const entry = await readdir(directory);
      if (entry) {
        existingDirectories.push(directory);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const directory of [...new Set(existingDirectories)]) {
    observe(directory);
  }

  console.log(
    "[dev:editor] 안전 핫 리로드 준비 완료. 편집기 URL 쿼리에 dev=1을 붙여 처음 한 번만 새로고침하세요."
  );
  console.log(
    "[dev:editor] CSS는 즉시 교체하고, JS/Worker는 원본 핸들과 CURRENT 저장을 확인한 뒤에만 재로드합니다."
  );
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void cleanup().then(
      () => process.exit(0),
      (error) => {
        console.error(`[dev:editor] 종료 정리 실패: ${error.message}`);
        process.exit(1);
      }
    );
  });
}
process.once("exit", cleanupSync);

main().catch(async (error) => {
  console.error(`[dev:editor] 시작 실패: ${error.stack || error.message}`);
  await cleanup();
  process.exitCode = 1;
});
