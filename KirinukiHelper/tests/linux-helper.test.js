import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CANDIDATES,
  DEFAULT_SOURCE_URL,
  browserProduct,
  browserLaunchArgs,
  captionStartStrategy,
  helpText,
  inspectBrowser,
  inspectPreferredBrowser,
  parseBrowserMajor,
  parseLinuxHelperArgs,
  resolveLinuxHelperPaths,
  restoreLauncherPermissions,
  shouldCycleForegroundCaption,
  validateSourceUrl,
  versionAtLeast
} from "../scripts/linux-helper.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const helperPath = path.join(packageRoot, "scripts", "linux-helper.mjs");

async function runNode(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      cwd: packageRoot,
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

test("버전 하한은 Node 20.9와 Chromium 120 경계를 정확히 구분한다", () => {
  assert.equal(versionAtLeast("20.8.9", "20.9.0"), false);
  assert.equal(versionAtLeast("20.9.0", "20.9.0"), true);
  assert.equal(versionAtLeast("21.0.0", "20.9.0"), true);
  assert.equal(parseBrowserMajor("Chromium 119.0.1"), 119);
  assert.equal(parseBrowserMajor("Google Chrome 120.0.1"), 120);
  assert.equal(parseBrowserMajor("unknown"), null);
  assert.equal(browserProduct("Chromium 150.0.1"), "chromium");
  assert.equal(browserProduct("Google Chrome 150.0.1"), "chrome");
  assert.equal(browserProduct("unknown"), "unknown");
  assert.deepEqual(BROWSER_CANDIDATES, ["chromium", "chromium-browser"]);
});

test("CLI는 setup/doctor/open/status/stop 계약과 자막 방식을 파싱한다", () => {
  assert.deepEqual(
    parseLinuxHelperArgs([
      "setup",
      "--mode",
      "whisper",
      "--profile=light",
      "--backend",
      "cpu",
      "--yes",
      "--dry-run"
    ]),
    {
      command: "setup",
      options: {
        mode: "whisper",
        profile: "light",
        backend: "cpu",
        browser: null,
        yes: true,
        dryRun: true,
        json: false,
        url: null
      }
    }
  );
  assert.equal(
    parseLinuxHelperArgs([
      "open",
      "https://chzzk.naver.com/video/123"
    ]).options.url,
    "https://chzzk.naver.com/video/123"
  );
  assert.equal(
    parseLinuxHelperArgs(["start"]).command,
    "start"
  );
  assert.throws(
    () => parseLinuxHelperArgs(["setup", "--api-key", "secret"]),
    /비밀 값/u
  );
  assert.throws(
    () => parseLinuxHelperArgs(["setup", "--mode", "solar"]),
    /mode/u
  );
  assert.throws(
    () => parseLinuxHelperArgs(["status", "--profile", "quality"]),
    /setup에서만/u
  );
});

test("URL은 지원 서비스의 공개 HTTPS만 한 인자로 허용한다", () => {
  for (const value of [
    "https://chzzk.naver.com/video/14405514",
    "https://www.youtube.com/watch?v=nixLJx1UhfY",
    "https://youtu.be/nixLJx1UhfY",
    "https://naver.me/xJcAj1dV"
  ]) {
    assert.equal(validateSourceUrl(value), value);
  }
  assert.equal(validateSourceUrl(""), DEFAULT_SOURCE_URL);
  for (const value of [
    "http://chzzk.naver.com/video/1",
    "https://example.com/video/1",
    "https://user:pass@youtube.com/watch?v=x",
    "javascript:alert(1)",
    "https://youtube.com/\n--remote-debugging-port=1"
  ]) {
    assert.throws(() => validateSourceUrl(value), /URL|HTTPS|제어/u);
  }
});

test("브라우저 인자는 안정적인 전용 profile과 exact Extension만 사용한다", () => {
  const args = browserLaunchArgs({
    extensionRoot: "/tmp/Kirinuki Folder/extension",
    profileRoot: "/tmp/Kirinuki Profile",
    sourceUrl: "https://chzzk.naver.com/video/1"
  });
  assert.deepEqual(args, [
    "--user-data-dir=/tmp/Kirinuki Profile",
    "--disable-extensions-except=/tmp/Kirinuki Folder/extension",
    "--load-extension=/tmp/Kirinuki Folder/extension",
    "--no-first-run",
    "--no-default-browser-check",
    "https://chzzk.naver.com/video/1"
  ]);
  assert.ok(!args.some((value) => /remote-debugging/iu.test(value)));
});

test("Whisper 시작은 설치·Origin·ready 뒤 systemd/foreground를 정확히 고른다", () => {
  assert.equal(captionStartStrategy(null), "setup-required");
  assert.equal(captionStartStrategy({
    configured: true,
    originMatchesCurrentPath: false
  }), "origin-mismatch");
  assert.equal(captionStartStrategy({
    configured: true,
    originMatchesCurrentPath: true,
    endpoints: { stt: true, gateway: true },
    systemdUser: false
  }), "ready");
  assert.equal(captionStartStrategy({
    configured: true,
    originMatchesCurrentPath: true,
    endpoints: { stt: false, gateway: false },
    systemdUser: true
  }), "systemd");
  assert.equal(captionStartStrategy({
    configured: true,
    originMatchesCurrentPath: true,
    endpoints: { stt: false, gateway: false },
    systemdUser: false
  }), "foreground");
  assert.equal(shouldCycleForegroundCaption({
    configured: true,
    runtime: {
      manager: "foreground",
      managedForeground: true
    }
  }), true);
  assert.equal(shouldCycleForegroundCaption({
    configured: true,
    runtime: {
      manager: "systemd",
      managedForeground: false
    }
  }), false);
});

test("XDG 경로는 repository 밖의 안정적인 사용자 profile을 고른다", () => {
  const paths = resolveLinuxHelperPaths({
    env: {
      XDG_CONFIG_HOME: "/tmp/config root",
      XDG_STATE_HOME: "/tmp/state root"
    },
    homeDir: "/tmp/home"
  });
  assert.equal(
    paths.browserProfileRoot,
    "/tmp/config root/kirinuki-studio/chromium-profile"
  );
  assert.equal(
    paths.captionLogPath,
    "/tmp/state root/kirinuki-studio/caption-stack.log"
  );
});

test("도움말은 사람이 쓸 모든 명령과 안전 경계를 노출한다", () => {
  const text = helpText();
  for (const command of [
    "setup",
    "doctor",
    "open",
    "start",
    "status",
    "stop"
  ]) {
    assert.match(text, new RegExp(`\\b${command}\\b`, "u"));
  }
  assert.match(text, /audseg/u);
  assert.match(text, /whisper/u);
  assert.match(text, /강제 종료하지 않음/u);
  assert.doesNotMatch(text, /curl\s*\|\s*(?:ba)?sh/iu);
});

test("fresh Linux dry-run은 외부 변경 없이 정확한 setup과 open 명령을 보여준다", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "kirinuki-linux-helper-")
  );
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const browser = path.join(tempRoot, "chromium");
  const npm = path.join(tempRoot, "npm");
  await Promise.all([
    writeFile(
      browser,
      "#!/bin/sh\nprintf '%s\\n' 'Chromium 120.0.0.0'\n"
    ),
    writeFile(npm, "#!/bin/sh\nexit 0\n")
  ]);
  await Promise.all([chmod(browser, 0o755), chmod(npm, 0o755)]);
  const env = {
    ...process.env,
    PATH: `${tempRoot}:${process.env.PATH || ""}`,
    KIRINUKI_BROWSER_BINARY: browser,
    KIRINUKI_NPM_BINARY: npm,
    XDG_CONFIG_HOME: path.join(tempRoot, "config"),
    XDG_STATE_HOME: path.join(tempRoot, "state")
  };

  const setup = await runNode([
    "setup",
    "--mode",
    "audseg",
    "--yes",
    "--dry-run"
  ], { env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /ci" "--ignore-scripts/u);
  assert.match(setup.stdout, /run" "build/u);
  assert.match(setup.stdout, /run" "validate/u);
  assert.match(setup.stdout, /run" "license:check/u);
  assert.doesNotMatch(setup.stdout, /caption-stack\.mjs" "setup/u);

  const whisperSetup = await runNode([
    "setup",
    "--mode",
    "whisper",
    "--profile",
    "draft",
    "--backend",
    "cpu",
    "--yes",
    "--dry-run"
  ], { env });
  assert.equal(whisperSetup.code, 0, whisperSetup.stderr);
  assert.match(whisperSetup.stdout, /local-caption-stack\.mjs" "doctor/u);
  assert.match(whisperSetup.stdout, /local-caption-stack\.mjs" "setup/u);
  assert.match(whisperSetup.stdout, /"--profile" "draft"/u);
  assert.match(whisperSetup.stdout, /"--backend" "cpu"/u);

  const open = await runNode([
    "open",
    "--mode",
    "audseg",
    "--dry-run",
    "https://naver.me/xJcAj1dV"
  ], { env });
  assert.equal(open.code, 0, open.stderr);
  assert.match(open.stdout, /--user-data-dir=/u);
  assert.match(open.stdout, /--load-extension=/u);
  assert.match(open.stdout, /https:\/\/naver\.me\/xJcAj1dV/u);
  assert.equal(
    await readFile(browser, "utf8"),
    "#!/bin/sh\nprintf '%s\\n' 'Chromium 120.0.0.0'\n"
  );
});

test("일반 Google Chrome 자동 로드는 fail-closed이고 저장된 Chrome은 Chromium으로 대체한다", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "kirinuki-browser-brand-")
  );
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const chromium = path.join(tempRoot, "chromium");
  const chrome = path.join(tempRoot, "google-chrome");
  await Promise.all([
    writeFile(
      chromium,
      "#!/bin/sh\nprintf '%s\\n' 'Chromium 150.0.0.0'\n"
    ),
    writeFile(
      chrome,
      "#!/bin/sh\nprintf '%s\\n' 'Google Chrome 150.0.0.0'\n"
    )
  ]);
  await Promise.all([chmod(chromium, 0o755), chmod(chrome, 0o755)]);
  const env = {
    PATH: tempRoot
  };
  const branded = inspectBrowser({ requested: chrome, env });
  assert.equal(branded.available, true);
  assert.equal(branded.product, "chrome");
  assert.equal(branded.supported, false);
  assert.equal(
    inspectPreferredBrowser({ explicit: chrome, env }).supported,
    false
  );
  const replacement = inspectPreferredBrowser({ stored: chrome, env });
  assert.equal(replacement.supported, true);
  assert.equal(replacement.product, "chromium");
  assert.equal(replacement.binary, chromium);
});

test("누락된 fresh Linux 의존성은 변경 없이 실행 가능한 설치 안내로 실패한다", async () => {
  const result = await runNode([
    "doctor",
    "--mode",
    "audseg"
  ], {
    env: {
      ...process.env,
      PATH: ""
    }
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /npm: 없음/u);
  assert.match(result.stdout, /Chromium 없음/u);
  assert.match(result.stdout, /apt install nodejs npm chromium/u);
  assert.doesNotMatch(result.stdout, /chromium cmake c\+\+ tar/u);
  assert.match(result.stdout, /자동 실행하지 않습니다/u);
});

test("AudSeg status와 stop은 Whisper companion을 호출하지 않는다", async (t) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "kirinuki-audseg-status-")
  );
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(tempRoot, "config"),
    XDG_STATE_HOME: path.join(tempRoot, "state")
  };
  const status = await runNode([
    "status",
    "--mode",
    "audseg",
    "--json"
  ], { env });
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.caption.value.required, false);

  const stopped = await runNode([
    "stop",
    "--mode",
    "audseg"
  ], { env });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /중지할 백그라운드 서비스가 없습니다/u);
  assert.match(stopped.stdout, /직접 정상 종료/u);
});

test("셸 진입점은 ZIP의 0644 권한에서도 setup을 열고 성공 뒤 실행권한을 복원한다", async (t) => {
  const [launcher, setup] = await Promise.all([
    readFile(path.join(packageRoot, "kirinuki.sh"), "utf8"),
    readFile(path.join(packageRoot, "setup.sh"), "utf8")
  ]);
  assert.match(launcher, /^#!\/usr\/bin\/env bash/u);
  assert.match(launcher, /scripts\/linux-helper\.mjs/u);
  assert.match(launcher, /Node\.js 20\.9/u);
  assert.doesNotMatch(launcher, /curl\s*\|\s*(?:ba)?sh/iu);
  assert.match(setup, /kirinuki\.sh" setup/u);
  assert.doesNotMatch(setup, /rm\s+-rf/u);
  assert.match(setup, /exec bash .+kirinuki\.sh" setup/u);
  const helper = await readFile(helperPath, "utf8");
  assert.doesNotMatch(helper, /process\.kill|child\.kill/u);
  assert.match(helper, /detached:\s*true/u);

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "kirinuki-source-zip-mode-")
  );
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const copiedLauncher = path.join(tempRoot, "kirinuki.sh");
  const copiedSetup = path.join(tempRoot, "setup.sh");
  const fakeNode = path.join(tempRoot, "node");
  await Promise.all([
    writeFile(copiedLauncher, launcher),
    writeFile(copiedSetup, setup),
    writeFile(
      fakeNode,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"-e\" ]; then exit 0; fi",
        "printf '%s\\n' \"$@\"",
        ""
      ].join("\n")
    )
  ]);
  await Promise.all([
    chmod(copiedLauncher, 0o644),
    chmod(copiedSetup, 0o644),
    chmod(fakeNode, 0o755)
  ]);
  const entry = await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [copiedSetup, "--mode", "audseg", "--dry-run"],
      {
        env: {
          ...process.env,
          KIRINUKI_NODE_BINARY: fakeNode
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(entry.code, 0, entry.stderr);
  assert.match(entry.stdout, /scripts\/linux-helper\.mjs/u);
  assert.match(entry.stdout, /^setup$/mu);
  assert.equal((await stat(copiedLauncher)).mode & 0o777, 0o644);
  await restoreLauncherPermissions(tempRoot);
  assert.equal((await stat(copiedLauncher)).mode & 0o777, 0o755);
  assert.equal((await stat(copiedSetup)).mode & 0o777, 0o755);
});
