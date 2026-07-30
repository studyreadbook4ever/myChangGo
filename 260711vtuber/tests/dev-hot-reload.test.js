import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  DEV_RELOAD_SCHEMA,
  classifyDevReload,
  createDevReloadMarker,
  devChangeNeedsBuild,
  isDevReloadMarker,
  readDevReloadMarker,
  removeOwnedDevReloadMarker,
  writeDevReloadMarker
} from "../scripts/dev-hot-reload-core.mjs";
import {
  DEV_RUNNER_LOCK_SCHEMA,
  acquireDevRunnerLock,
  createDevRunnerLock,
  isDevRunnerLock,
  readDevRunnerLock,
  releaseDevRunnerLock
} from "../scripts/dev-runner-lock.mjs";

function runNodeScript(scriptPath, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("개발 변경을 안전한 리로드 종류로 분류한다", () => {
  assert.equal(classifyDevReload(["extension/editor/editor.css"]), "style");
  assert.equal(classifyDevReload(["src/editor/main.js"]), "editor");
  assert.equal(classifyDevReload(["src/caption-agent/protocol.js"]), "none");
  assert.equal(classifyDevReload(["extension/lib/editor-core.js"]), "extension");
  assert.equal(classifyDevReload(["extension/lib/core.js"]), "extension");
  assert.equal(
    classifyDevReload(["extension/editor/editor.css", "src/editor/audseg-worker.js"]),
    "editor"
  );
  assert.equal(classifyDevReload(["src/content-script.js"]), "content");
  assert.equal(
    classifyDevReload([
      "src/content-script.js",
      "extension/editor/editor.css"
    ]),
    "editor"
  );
  assert.equal(classifyDevReload(["extension/lib/source-platform.js"]), "extension");
  assert.equal(classifyDevReload(["extension/lib/session-recovery.js"]), "extension");
  assert.equal(
    classifyDevReload(["src/editor/main.js", "extension/manifest.json"]),
    "extension"
  );
  assert.equal(classifyDevReload(["README.md"]), "none");
});

test("번들이 필요한 변경만 빌드 대상으로 분리한다", () => {
  assert.equal(devChangeNeedsBuild(["src/editor/main.js"]), true);
  assert.equal(devChangeNeedsBuild(["src/caption-agent/protocol.js"]), false);
  assert.equal(devChangeNeedsBuild(["extension/lib/editor-core.js"]), true);
  assert.equal(devChangeNeedsBuild(["src/content-script.js"]), true);
  assert.equal(devChangeNeedsBuild(["extension/editor/editor.css"]), false);
  assert.equal(devChangeNeedsBuild(["extension/editor.html"]), false);
});

test("개발 marker를 원자적으로 기록하고 소유자만 지운다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-reload-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = path.join(temporaryRoot, "extension", "dev-reload.json");
  const marker = createDevReloadMarker({
    revision: "revision-7",
    kind: "editor",
    changedFiles: ["src/editor/main.js", "src/editor/main.js"],
    pid: 777,
    createdAt: new Date("2026-07-30T00:00:00.000Z")
  });

  assert.deepEqual(marker, {
    schema: DEV_RELOAD_SCHEMA,
    revision: "revision-7",
    kind: "editor",
    changedFiles: ["src/editor/main.js"],
    pid: 777,
    createdAt: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(isDevReloadMarker(marker), true);
  await writeDevReloadMarker(markerPath, marker);
  assert.deepEqual(await readDevReloadMarker(markerPath), marker);
  assert.equal((await readFile(markerPath, "utf8")).endsWith("\n"), true);
  assert.equal(await removeOwnedDevReloadMarker(markerPath, 778), false);
  assert.deepEqual(await readDevReloadMarker(markerPath), marker);
  assert.equal(await removeOwnedDevReloadMarker(markerPath, 777), true);
  assert.equal(await readDevReloadMarker(markerPath), null);
});

test("손상되거나 불완전한 marker는 활성화하지 않는다", () => {
  assert.equal(isDevReloadMarker(null), false);
  assert.equal(isDevReloadMarker({
    schema: DEV_RELOAD_SCHEMA,
    revision: "",
    kind: "editor",
    changedFiles: [],
    pid: 1,
    createdAt: new Date().toISOString()
  }), false);
  assert.equal(isDevReloadMarker({
    schema: DEV_RELOAD_SCHEMA,
    revision: "x",
    kind: "editor",
    changedFiles: [],
    pid: 0,
    createdAt: new Date().toISOString()
  }), false);
  assert.throws(
    () => createDevReloadMarker({
      revision: "x",
      kind: "remote",
      changedFiles: []
    }),
    /지원하지 않는/
  );
});

test("개발 runner 잠금은 역할과 생성 시각까지 엄격히 검증한다", () => {
  const lock = createDevRunnerLock({
    pid: 777,
    role: "package",
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    token: "release-lock-token-0001"
  });
  assert.deepEqual(lock, {
    schema: DEV_RUNNER_LOCK_SCHEMA,
    pid: 777,
    role: "package",
    createdAt: "2026-07-30T00:00:00.000Z",
    token: "release-lock-token-0001"
  });
  assert.equal(isDevRunnerLock(lock), true);
  assert.equal(isDevRunnerLock({ pid: 777, createdAt: lock.createdAt }), true);
  assert.equal(isDevRunnerLock({ ...lock, pid: 0 }), false);
  assert.equal(isDevRunnerLock({ ...lock, role: "unknown" }), false);
  assert.equal(isDevRunnerLock({ ...lock, createdAt: "not-a-date" }), false);
  assert.equal(isDevRunnerLock({ ...lock, token: "short" }), false);
});

test("개발 runner 잠금은 커널에서 원자적으로 상호 배제한다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lockPath = path.join(temporaryRoot, ".dev-editor.lock");

  const editorLease = await acquireDevRunnerLock(lockPath, {
    pid: process.pid,
    role: "editor",
    createdAt: new Date("2026-07-30T00:00:00.000Z")
  });
  assert.equal((await readDevRunnerLock(lockPath)).role, "editor");
  await assert.rejects(
    acquireDevRunnerLock(lockPath, {
      pid: process.pid,
      role: "package"
    }),
    /dev:editor.*잠금을 사용 중/
  );
  assert.equal(await releaseDevRunnerLock(editorLease), true);
  assert.equal(await releaseDevRunnerLock(editorLease), false);

  const packageLease = await acquireDevRunnerLock(lockPath, {
    pid: process.pid,
    role: "package"
  });
  assert.equal((await readDevRunnerLock(lockPath)).role, "package");
  assert.equal(await releaseDevRunnerLock(packageLease), true);
});

test("릴리스 자식은 일치하는 live package token으로만 잠금을 빌린다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lockPath = path.join(temporaryRoot, ".dev-editor.lock");
  const ownerLease = await acquireDevRunnerLock(lockPath, {
    role: "package",
    token: "release-lock-token-0002"
  });
  try {
    const borrowedLease = await acquireDevRunnerLock(lockPath, {
      role: "validate",
      inheritedToken: "release-lock-token-0002",
      onOwnerLost: () => {}
    });
    assert.equal(borrowedLease.borrowed, true);
    assert.equal(await releaseDevRunnerLock(borrowedLease), true);
    await assert.rejects(
      acquireDevRunnerLock(lockPath, {
        role: "validate",
        inheritedToken: "release-lock-token-wrong",
        onOwnerLost: () => {}
      }),
      /token이 현재 소유자와 일치하지 않습니다/
    );
  } finally {
    await releaseDevRunnerLock(ownerLease);
  }
  await assert.rejects(
    acquireDevRunnerLock(lockPath, {
      role: "validate",
      inheritedToken: "release-lock-token-0002",
      onOwnerLost: () => {}
    }),
    /더 이상 실행 중이지 않습니다/
  );
});

test("owner는 인증된 borrower가 끝나기 전 mutex를 해제하지 않는다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lockPath = path.join(temporaryRoot, ".dev-editor.lock");
  const ownerLease = await acquireDevRunnerLock(lockPath, {
    role: "package",
    token: "release-lock-token-0003"
  });
  const borrowedLease = await acquireDevRunnerLock(lockPath, {
    role: "validate",
    inheritedToken: "release-lock-token-0003",
    onOwnerLost: () => {}
  });
  let ownerReleased = false;
  const ownerRelease = releaseDevRunnerLock(ownerLease).then(() => {
    ownerReleased = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ownerReleased, false);
  await assert.rejects(
    acquireDevRunnerLock(lockPath, { role: "editor" }),
    /릴리스 패키징.*잠금을 사용 중/
  );
  await releaseDevRunnerLock(borrowedLease);
  await ownerRelease;
  assert.equal(ownerReleased, true);
});

test("mutex probe 연결이 들어와도 lease 해제가 대기하지 않는다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lease = await acquireDevRunnerLock(
    path.join(temporaryRoot, ".dev-editor.lock"),
    { role: "editor" }
  );
  const client = createConnection(lease.endpoint);
  context.after(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  let timeout;
  try {
    await Promise.race([
      releaseDevRunnerLock(lease),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("mutex lease 해제 시간 초과")),
          1_000
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
});

test("stale 또는 손상된 메타데이터는 새 커널 잠금에서 안전하게 교체한다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lockPath = path.join(temporaryRoot, ".dev-editor.lock");

  await writeFile(lockPath, "{\"pid\":", "utf8");
  assert.equal(await readDevRunnerLock(lockPath), null);
  const lease = await acquireDevRunnerLock(lockPath, {
    pid: process.pid,
    role: "validate"
  });
  assert.equal((await readDevRunnerLock(lockPath)).role, "validate");
  assert.equal(await releaseDevRunnerLock(lease), true);
});

test("잠금 소유자가 강제 종료돼도 커널 잠금이 자동 해제된다", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kirinuki-dev-lock-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lockPath = path.join(temporaryRoot, ".dev-editor.lock");
  const moduleUrl = pathToFileURL(
    path.resolve("scripts/dev-runner-lock.mjs")
  ).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    [
      `import { acquireDevRunnerLock } from ${JSON.stringify(moduleUrl)};`,
      `await acquireDevRunnerLock(${JSON.stringify(lockPath)}, {`,
      "  role: \"package\",",
      "  token: \"release-lock-token-crash\"",
      "});",
      "process.stdout.write('READY\\n');",
      "setInterval(() => {}, 1_000);"
    ].join("\n")
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("자식 잠금 프로세스 준비 시간 초과")),
      5_000
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      assert.match(chunk.toString(), /READY/);
      resolve();
    });
  });
  await assert.rejects(
    acquireDevRunnerLock(lockPath, { role: "editor" }),
    /릴리스 패키징.*잠금을 사용 중/
  );
  let ownerLossResolve;
  const ownerLoss = new Promise((resolve) => {
    ownerLossResolve = resolve;
  });
  const borrowedLease = await acquireDevRunnerLock(lockPath, {
    role: "validate",
    inheritedToken: "release-lock-token-crash",
    onOwnerLost: ownerLossResolve
  });

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  let ownerLossTimeout;
  let lossError;
  try {
    lossError = await Promise.race([
      ownerLoss,
      new Promise((_, reject) => {
        ownerLossTimeout = setTimeout(
          () => reject(new Error("borrower owner-loss 감지 시간 초과")),
          1_000
        );
      })
    ]);
  } finally {
    clearTimeout(ownerLossTimeout);
  }
  assert.match(lossError.message, /mutex 연결이 종료/);
  await releaseDevRunnerLock(borrowedLease);
  const recoveredLease = await acquireDevRunnerLock(lockPath, {
    role: "package"
  });
  assert.equal(await releaseDevRunnerLock(recoveredLease), true);
});

test("활성 최상위 lease 중 validator와 package가 모두 fail closed한다", async () => {
  const root = path.resolve(".");
  const lockPath = path.join(root, ".dev-editor.lock");
  const inheritedToken = process.env.KIRINUKI_RELEASE_LOCK_TOKEN;
  const lease = inheritedToken
    ? null
    : await acquireDevRunnerLock(lockPath, { role: "editor" });
  const childEnvironment = { ...process.env };
  delete childEnvironment.KIRINUKI_RELEASE_LOCK_TOKEN;
  try {
    for (const script of [
      "scripts/validate-extension.mjs",
      "scripts/package-extension.mjs"
    ]) {
      const result = await runNodeScript(path.join(root, script), {
        env: childEnvironment
      });
      assert.notEqual(result.code, 0, `${script}가 잠금 중 성공하면 안 됩니다.`);
      assert.equal(result.signal, null);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /(?:dev:editor|릴리스 패키징).*잠금을 사용 중/
      );
    }
  } finally {
    if (lease) {
      await releaseDevRunnerLock(lease);
    }
  }
});

test("일치하는 최상위 package handshake는 자식 validator에서만 재사용된다", async () => {
  const root = path.resolve(".");
  const inheritedToken = process.env.KIRINUKI_RELEASE_LOCK_TOKEN;
  const ownerLease = inheritedToken
    ? null
    : await acquireDevRunnerLock(path.join(root, ".dev-editor.lock"), {
      role: "package"
    });
  const token = inheritedToken || ownerLease.lock.token;
  try {
    const result = await runNodeScript(
      path.join(root, "scripts/validate-extension.mjs"),
      {
        env: {
          ...process.env,
          KIRINUKI_RELEASE_LOCK_TOKEN: token
        }
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Extension 검증 통과/);
  } finally {
    if (ownerLease) {
      await releaseDevRunnerLock(ownerLease);
    }
  }
});

test("릴리스 명령은 전체 검증부터 ZIP까지 한 lease로 감싼다", async () => {
  const [packageJson, releaseScript, browserSmoke] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("scripts/release-package.mjs", "utf8"),
    readFile("scripts/browser-smoke.mjs", "utf8")
  ]);
  assert.equal(
    packageJson.scripts.package,
    "node scripts/release-package.mjs"
  );
  assert.match(releaseScript, /acquireDevRunnerLock/);
  assert.match(releaseScript, /\["run", "check:full"\]/);
  assert.match(releaseScript, /package-extension\.mjs/);
  assert.match(browserSmoke, /extension-under-test/);
  assert.match(browserSmoke, /await cp\(sourceExtensionRoot/);
});
