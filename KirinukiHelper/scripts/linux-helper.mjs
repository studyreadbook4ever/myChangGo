#!/usr/bin/env node

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync
} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HELPER_SCHEMA = "chzzk-kirinuki-linux-helper/v1";
export const MINIMUM_NODE_VERSION = "20.9.0";
export const MINIMUM_BROWSER_VERSION = 120;
export const DEFAULT_SOURCE_URL = "https://chzzk.naver.com/";
export const BROWSER_CANDIDATES = Object.freeze([
  "chromium",
  "chromium-browser"
]);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const stackCliPath = path.join(
  packageRoot,
  "scripts",
  "local-caption-stack.mjs"
);
const MODES = Object.freeze(["audseg", "whisper"]);
const PROFILES = Object.freeze(["draft", "auto", "light", "quality"]);
const BACKENDS = Object.freeze(["auto", "cpu", "cuda"]);
const COMMANDS = Object.freeze([
  "setup",
  "doctor",
  "start",
  "open",
  "status",
  "stop",
  "help"
]);
const SUPPORTED_SOURCE_HOSTS = new Set([
  "chzzk.naver.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "naver.me"
]);

function line(stream, value = "") {
  stream.write(`${value}\n`);
}

export function versionAtLeast(actual, required) {
  const parse = (value) => String(value || "")
    .replace(/^v/u, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  const left = parse(actual);
  const right = parse(required);
  if (
    left.length < 2
    || right.length < 2
    || [...left, ...right].some((part) => !Number.isInteger(part))
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart;
    }
  }
  return true;
}

function requiredChoice(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new TypeError(
      `${label}은 ${allowed.join(", ")} 중 하나여야 합니다.`
    );
  }
  return normalized;
}

export function parseLinuxHelperArgs(argv = []) {
  const values = [...argv].map((value) => String(value));
  const first = values[0];
  const command = (
    !first || first.startsWith("-")
      ? (!first ? "" : "help")
      : values.shift()
  );
  const options = {
    mode: null,
    profile: "draft",
    backend: "auto",
    browser: null,
    yes: false,
    dryRun: false,
    json: false,
    url: null
  };
  const positionals = [];

  const takeValue = (flag, inlineValue) => {
    const value = inlineValue ?? values.shift();
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${flag} 값이 필요합니다.`);
    }
    return value;
  };

  while (values.length > 0) {
    const raw = values.shift();
    if (raw === "--") {
      positionals.push(...values);
      values.length = 0;
      break;
    }
    if (!raw.startsWith("-")) {
      positionals.push(raw);
      continue;
    }
    const [flag, inlineValue] = raw.split("=", 2);
    if (/api[-_]?key|token|secret|password|credential/iu.test(flag)) {
      throw new TypeError("비밀 값은 Linux 도우미 옵션으로 받을 수 없습니다.");
    }
    if (flag === "--mode") {
      options.mode = requiredChoice(
        takeValue(flag, inlineValue),
        MODES,
        "mode"
      );
      continue;
    }
    if (flag === "--profile") {
      options.profile = requiredChoice(
        takeValue(flag, inlineValue),
        PROFILES,
        "profile"
      );
      continue;
    }
    if (flag === "--backend") {
      options.backend = requiredChoice(
        takeValue(flag, inlineValue),
        BACKENDS,
        "backend"
      );
      continue;
    }
    if (flag === "--browser") {
      options.browser = takeValue(flag, inlineValue);
      continue;
    }
    if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      return { command: "help", options };
    }
    throw new TypeError(`알 수 없는 옵션입니다: ${raw}`);
  }

  if (command && !COMMANDS.includes(command)) {
    throw new TypeError(`알 수 없는 명령입니다: ${command}`);
  }
  if (positionals.length > 1) {
    throw new TypeError("영상 URL은 하나만 지정할 수 있습니다.");
  }
  if (positionals.length === 1) {
    if (!["start", "open"].includes(command)) {
      throw new TypeError(`${command || "이 명령"}에는 위치 인자를 쓸 수 없습니다.`);
    }
    options.url = validateSourceUrl(positionals[0]);
  }
  if (
    options.browser
    && !["setup", "doctor", "start", "open"].includes(command)
  ) {
    throw new TypeError(`--browser는 ${command || "이 명령"}에서 쓸 수 없습니다.`);
  }
  if (
    (options.profile !== "draft" || options.backend !== "auto")
    && command !== "setup"
  ) {
    throw new TypeError("--profile과 --backend는 setup에서만 쓸 수 있습니다.");
  }
  return { command, options };
}

export function validateSourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_SOURCE_URL;
  }
  if (raw.length > 2_048 || /[\0-\x1f\x7f]/u.test(raw)) {
    throw new TypeError("영상 URL에 허용되지 않는 제어 문자나 길이가 있습니다.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("올바른 HTTPS 영상 URL을 입력하세요.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || !SUPPORTED_SOURCE_HOSTS.has(hostname)
  ) {
    throw new TypeError(
      "치지직·YouTube·naver.me의 공개 HTTPS URL만 열 수 있습니다."
    );
  }
  return parsed.href;
}

export function resolveLinuxHelperPaths({
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const absoluteHome = path.resolve(homeDir);
  const configBase = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(absoluteHome, ".config");
  const stateBase = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(absoluteHome, ".local", "state");
  const configRoot = path.join(configBase, "kirinuki-studio");
  const stateRoot = path.join(stateBase, "kirinuki-studio");
  return Object.freeze({
    configRoot,
    stateRoot,
    settingsPath: path.join(configRoot, "helper.json"),
    browserProfileRoot: path.join(configRoot, "chromium-profile"),
    browserLogPath: path.join(stateRoot, "browser.log"),
    captionLogPath: path.join(stateRoot, "caption-stack.log")
  });
}

function executableAt(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

export function resolveExecutable(
  requested,
  candidates,
  env = process.env
) {
  const names = requested ? [requested] : [...candidates];
  const directories = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const name of names) {
    if (name.includes(path.sep)) {
      const direct = executableAt(path.resolve(name));
      if (direct) {
        return direct;
      }
      continue;
    }
    for (const directory of directories) {
      const candidate = executableAt(path.resolve(directory, name));
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

export function parseBrowserMajor(versionOutput) {
  const match = /(?:Chromium|Chrome)\s+(\d+)(?:\.|$)/iu.exec(
    String(versionOutput || "")
  );
  return match ? Number(match[1]) : null;
}

export function browserProduct(versionOutput) {
  const value = String(versionOutput || "");
  if (/\bChromium\s+\d+(?:\.|$)/iu.test(value)) {
    return "chromium";
  }
  if (/\b(?:Google\s+)?Chrome(?:\s+for\s+Testing)?\s+\d+(?:\.|$)/iu.test(
    value
  )) {
    return "chrome";
  }
  return "unknown";
}

function withoutSecrets(environment = process.env) {
  const safe = { ...environment };
  for (const name of Object.keys(safe)) {
    if (
      /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/iu.test(name)
    ) {
      delete safe[name];
    }
  }
  return safe;
}

function commandResult(file, args, {
  cwd = packageRoot,
  env = withoutSecrets(),
  timeout = 10_000
} = {}) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error || null
  };
}

export function inspectBrowser({
  requested = null,
  env = process.env
} = {}) {
  const binary = resolveExecutable(
    requested || env.KIRINUKI_BROWSER_BINARY,
    BROWSER_CANDIDATES,
    env
  );
  if (!binary) {
    return {
      available: false,
      binary: null,
      major: null,
      product: "unknown",
      supported: false,
      version: ""
    };
  }
  const result = commandResult(binary, ["--version"], {
    env: withoutSecrets(env),
    timeout: 5_000
  });
  const version = `${result.stdout}\n${result.stderr}`.trim();
  const major = parseBrowserMajor(version);
  const product = browserProduct(version);
  return {
    available: true,
    binary,
    major,
    product,
    supported: Boolean(
      result.ok
      && product === "chromium"
      && Number.isInteger(major)
      && major >= MINIMUM_BROWSER_VERSION
    ),
    version
  };
}

export function inspectPreferredBrowser({
  explicit = null,
  stored = null,
  env = process.env
} = {}) {
  const preferred = explicit || stored;
  const first = inspectBrowser({ requested: preferred, env });
  if (explicit || first.supported || !stored) {
    return first;
  }
  return inspectBrowser({ env });
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readSettings(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.settingsPath, "utf8"));
    if (
      parsed?.schema !== HELPER_SCHEMA
      || !MODES.includes(parsed.mode)
      || (
        parsed.browser !== null
        && typeof parsed.browser !== "string"
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeSettings(paths, settings) {
  await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
  const temporary = `${paths.settingsPath}.${process.pid}.tmp`;
  const body = `${JSON.stringify({
    schema: HELPER_SCHEMA,
    mode: settings.mode,
    browser: settings.browser || null,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`;
  try {
    await writeFile(temporary, body, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, paths.settingsPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function restoreLauncherPermissions(root = packageRoot) {
  await Promise.all([
    chmod(path.join(root, "kirinuki.sh"), 0o755),
    chmod(path.join(root, "setup.sh"), 0o755)
  ]);
}

function describeCommand(file, args) {
  return `${file} ${args.map((value) => JSON.stringify(value)).join(" ")}`;
}

function npmBinary(env = process.env) {
  return resolveExecutable(
    env.KIRINUKI_NPM_BINARY || null,
    ["npm"],
    env
  );
}

function nativeTools(env = process.env) {
  return Object.fromEntries(
    ["cmake", "tar", "c++"].map((name) => [
      name,
      resolveExecutable(null, [name], env)
    ])
  );
}

function buildReadyFiles(root = packageRoot) {
  return [
    path.join(root, "extension", "manifest.json"),
    path.join(root, "extension", "editor", "editor.js"),
    path.join(root, "extension", "editor", "audseg-worker.js"),
    path.join(root, "extension", "content-script.js")
  ];
}

async function inspectBuild(root = packageRoot) {
  const files = buildReadyFiles(root);
  const ready = (await Promise.all(files.map(exists))).every(Boolean);
  return { ready, files };
}

function readCaptionStatus(env = process.env) {
  const result = commandResult(
    process.execPath,
    [stackCliPath, "status", "--json"],
    { env: withoutSecrets(env), timeout: 10_000 }
  );
  if (!result.ok) {
    return {
      ok: false,
      error: (
        result.stderr.trim()
        || result.stdout.trim()
        || "자막 스택 상태를 읽지 못했습니다."
      )
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: "자막 스택 status JSON이 올바르지 않습니다." };
  }
}

export async function inspectLinuxEnvironment({
  mode = "audseg",
  browser = null,
  env = process.env,
  platform = process.platform,
  root = packageRoot
} = {}) {
  const selectedMode = requiredChoice(mode, MODES, "mode");
  const browserReport = inspectBrowser({ requested: browser, env });
  const build = await inspectBuild(root);
  const tools = selectedMode === "whisper"
    ? nativeTools(env)
    : {};
  const caption = selectedMode === "whisper"
    ? readCaptionStatus(env)
    : {
      ok: true,
      value: {
        required: false,
        message: "AudSeg는 companion이 필요 없습니다."
      }
    };
  const npm = npmBinary(env);
  const report = {
    schema: HELPER_SCHEMA,
    linux: platform === "linux",
    node: {
      version: process.versions.node,
      supported: versionAtLeast(
        process.versions.node,
        MINIMUM_NODE_VERSION
      )
    },
    npm: {
      available: Boolean(npm),
      binary: npm
    },
    browser: browserReport,
    extension: {
      root: path.join(root, "extension"),
      built: build.ready
    },
    mode: selectedMode,
    nativeTools: Object.fromEntries(
      Object.entries(tools).map(([name, value]) => [name, Boolean(value)])
    ),
    caption
  };
  report.ready = Boolean(
    report.linux
    && report.node.supported
    && report.npm.available
    && report.browser.supported
    && report.extension.built
    && (
      selectedMode !== "whisper"
      || (
        Object.values(report.nativeTools).every(Boolean)
        && caption.ok
        && caption.value?.configured
        && caption.value?.originMatchesCurrentPath
      )
    )
  );
  return report;
}

function dependencyGuidance(mode) {
  const debianNative = mode === "whisper" ? " cmake g++ tar" : "";
  const fedoraNative = mode === "whisper" ? " cmake gcc-c++ tar" : "";
  const archNative = mode === "whisper" ? " cmake gcc tar" : "";
  return [
    "누락된 프로그램은 사용자가 검토한 뒤 배포판 패키지 관리자로 설치하세요.",
    `Debian/Ubuntu 예: apt install nodejs npm chromium${debianNative}`,
    `Fedora 예: dnf install nodejs npm chromium${fedoraNative}`,
    `Arch 예: pacman -S --needed nodejs npm chromium${archNative}`,
    `설치 뒤 Node ${MINIMUM_NODE_VERSION}+와 Chromium ${MINIMUM_BROWSER_VERSION}+인지 다시 확인하세요.`,
    "일반 Google Chrome은 unpacked Extension 자동 로드 플래그를 지원하지 않습니다. Chrome에서는 chrome://extensions에서 extension 폴더를 수동으로 불러오세요.",
    "도우미는 관리자 권한 획득이나 시스템 패키지 설치를 자동 실행하지 않습니다."
  ];
}

function printDoctor(report, stdout = process.stdout) {
  line(stdout, `Linux: ${report.linux ? "OK" : "지원 대상 아님"}`);
  line(
    stdout,
    `Node ${report.node.version}: ${report.node.supported ? "OK" : `${MINIMUM_NODE_VERSION}+ 필요`}`
  );
  line(
    stdout,
    `npm: ${report.npm.available ? report.npm.binary : "없음"}`
  );
  line(
    stdout,
    `브라우저: ${
      report.browser.available
        ? `${report.browser.version || report.browser.binary} · ${
          report.browser.supported
            ? "OK"
            : report.browser.product === "chrome"
              ? "자동 실행 미지원(Chromium 필요)"
              : `Chromium ${MINIMUM_BROWSER_VERSION}+ 필요`
        }`
        : "Chromium 없음"
    }`
  );
  line(
    stdout,
    `Extension 빌드: ${report.extension.built ? "준비됨" : "setup 필요"}`
  );
  line(stdout, `자막 방식: ${report.mode}`);
  if (report.mode === "whisper") {
    line(
      stdout,
      `네이티브 도구: ${Object.entries(report.nativeTools)
        .map(([name, ready]) => `${name}=${ready ? "OK" : "없음"}`)
        .join(" · ")}`
    );
    if (report.caption.ok) {
      const status = report.caption.value;
      line(
        stdout,
        `Whisper 설치: ${status.configured ? "설정 있음" : "setup 필요"}`
        + (
          status.configured && !status.originMatchesCurrentPath
            ? " · Extension 경로 변경(setup 재실행 필요)"
            : ""
        )
      );
      line(
        stdout,
        `Whisper 서비스: STT=${status.endpoints?.stt ? "ready" : "down"}`
        + ` · gateway=${status.endpoints?.gateway ? "ready" : "down"}`
      );
    } else {
      line(stdout, `Whisper 상태: ${report.caption.error}`);
    }
  } else {
    line(stdout, "AudSeg: 모델·companion·API 키 없이 브라우저에서 실행");
  }
  line(stdout, `종합: ${report.ready ? "사용 준비됨" : "확인 필요"}`);
}

async function runStreaming(file, args, {
  cwd = packageRoot,
  env = withoutSecrets()
} = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${path.basename(file)}가 ${signal} 신호로 종료됐습니다.`
          : `${path.basename(file)}가 종료 코드 ${code}로 실패했습니다.`
      ));
    });
  });
}

function setupPlan(npm, mode, profile, backend) {
  const commands = [
    [npm, ["ci", "--ignore-scripts"]],
    [npm, ["run", "build"]],
    [npm, ["run", "validate"]],
    [npm, ["run", "license:check"]]
  ];
  if (mode === "whisper") {
    commands.push(
      [
        process.execPath,
        [stackCliPath, "doctor", "--profile", profile, "--backend", backend]
      ],
      [
        process.execPath,
        [stackCliPath, "setup", "--profile", profile, "--backend", backend]
      ]
    );
  }
  return commands;
}

export function shouldCycleForegroundCaption(status) {
  return Boolean(
    status?.configured
    && status.runtime?.manager === "foreground"
    && status.runtime?.managedForeground
  );
}

async function setupCommand(options, context) {
  const mode = options.mode || await chooseMode(options, context);
  const browserReport = inspectBrowser({
    requested: options.browser,
    env: context.env
  });
  const npm = npmBinary(context.env);
  const missing = [];
  if (context.platform !== "linux") {
    missing.push("Linux");
  }
  if (!versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION)) {
    missing.push(`Node ${MINIMUM_NODE_VERSION}+`);
  }
  if (!npm) {
    missing.push("npm");
  }
  if (!browserReport.available) {
    missing.push("Chromium");
  } else if (!browserReport.supported) {
    missing.push(
      browserReport.product === "chrome"
        ? "자동 로드를 지원하는 Chromium"
        : `Chromium ${MINIMUM_BROWSER_VERSION}+`
    );
  }
  if (mode === "whisper") {
    for (const [name, executable] of Object.entries(nativeTools(context.env))) {
      if (!executable) {
        missing.push(name);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `필수 환경이 없습니다: ${missing.join(", ")}\n`
      + dependencyGuidance(mode).join("\n")
    );
  }

  const plan = setupPlan(
    npm,
    mode,
    options.profile,
    options.backend
  );
  const captionAtDryRun = mode === "whisper"
    ? readCaptionStatus(context.env)
    : null;
  line(
    context.stdout,
    `설정 방식: ${mode === "whisper" ? "로컬 Whisper 글+타이밍" : "AudSeg 빈 타이밍"}`
  );
  if (options.dryRun) {
    line(context.stdout, "dry-run: 다음 명령을 실행하지 않고 표시합니다.");
    for (const [file, args] of plan) {
      line(context.stdout, `  ${describeCommand(file, args)}`);
    }
    if (
      captionAtDryRun?.ok
      && shouldCycleForegroundCaption(captionAtDryRun.value)
    ) {
      line(
        context.stdout,
        `  실행 중인 foreground 재설정: ${describeCommand(process.execPath, [stackCliPath, "stop"])} 후 다시 시작`
      );
    }
    line(
      context.stdout,
      `  브라우저 프로필: ${context.paths.browserProfileRoot}`
    );
    return;
  }

  let cycleForeground = false;
  try {
    for (const [file, args] of plan) {
      const isCaptionSetup = (
        file === process.execPath
        && args[0] === stackCliPath
        && args[1] === "setup"
      );
      if (isCaptionSetup) {
        const captionImmediatelyBeforeSetup = readCaptionStatus(context.env);
        cycleForeground = Boolean(
          captionImmediatelyBeforeSetup.ok
          && shouldCycleForegroundCaption(
            captionImmediatelyBeforeSetup.value
          )
        );
        if (cycleForeground) {
          line(
            context.stdout,
            "실행 중인 foreground Whisper를 안전하게 중지한 뒤 같은 방식으로 복원합니다."
          );
          await runStreaming(process.execPath, [stackCliPath, "stop"], {
            cwd: packageRoot,
            env: withoutSecrets(context.env)
          });
        }
      }
      await runStreaming(file, args, {
        cwd: packageRoot,
        env: withoutSecrets(context.env)
      });
    }
  } catch (error) {
    if (cycleForeground) {
      try {
        await ensureWhisper(options, context, {
          preferredManager: "foreground"
        });
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "설정에 실패했고, 기존 foreground Whisper 복원도 실패했습니다."
        );
      }
    }
    throw error;
  }
  if (cycleForeground) {
    await ensureWhisper(options, context, {
      preferredManager: "foreground"
    });
    line(context.stdout, "foreground Whisper 재설정·복원 완료");
  }
  await writeSettings(context.paths, {
    mode,
    browser: browserReport.binary
  });
  await restoreLauncherPermissions();
  line(context.stdout, "Kirinuki 설정 완료");
  line(
    context.stdout,
    `영상 열기: ./kirinuki.sh open "${DEFAULT_SOURCE_URL}"`
  );
  if (mode === "whisper") {
    line(
      context.stdout,
      "첫 영상 열기 때 로컬 Whisper 서비스도 자동으로 준비합니다."
    );
  }
}

async function chooseMode(options, context) {
  if (options.yes || !context.stdin.isTTY || !context.stdout.isTTY) {
    return "audseg";
  }
  const rl = createInterface({
    input: context.stdin,
    output: context.stdout
  });
  try {
    line(context.stdout, "자막 초벌 방식을 고르세요.");
    line(context.stdout, "  1) AudSeg — 모델 없이 빈 타이밍만 생성");
    line(context.stdout, "  2) Whisper Tiny — 한국어 글과 타이밍 생성");
    const answer = String(
      await rl.question("선택 [1]: ")
    ).trim();
    if (!answer || answer === "1") {
      return "audseg";
    }
    if (answer === "2") {
      return "whisper";
    }
    throw new TypeError("1 또는 2를 입력하세요.");
  } finally {
    rl.close();
  }
}

export function browserLaunchArgs({
  extensionRoot,
  profileRoot,
  sourceUrl = DEFAULT_SOURCE_URL
}) {
  const extension = path.resolve(extensionRoot);
  const profile = path.resolve(profileRoot);
  return [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    validateSourceUrl(sourceUrl)
  ];
}

export function captionStartStrategy(status) {
  if (!status?.configured) {
    return "setup-required";
  }
  if (!status.originMatchesCurrentPath) {
    return "origin-mismatch";
  }
  if (status.endpoints?.stt && status.endpoints?.gateway) {
    return "ready";
  }
  return status.systemdUser ? "systemd" : "foreground";
}

async function ensureWhisper(
  options,
  context,
  { preferredManager = null } = {}
) {
  if (options.dryRun) {
    line(
      context.stdout,
      `dry-run: ${describeCommand(process.execPath, [stackCliPath, "status", "--json"])}`
    );
    line(
      context.stdout,
      `dry-run: 필요할 때 ${describeCommand(process.execPath, [stackCliPath, "start"])}`
    );
    line(
      context.stdout,
      `dry-run: systemd-user가 없으면 ${describeCommand(process.execPath, [stackCliPath, "start", "--foreground"])}`
    );
    return;
  }
  let result = readCaptionStatus(context.env);
  if (!result.ok) {
    throw new Error(result.error);
  }
  let status = result.value;
  let strategy = captionStartStrategy(status);
  if (
    preferredManager === "foreground"
    && ["systemd", "foreground"].includes(strategy)
  ) {
    strategy = "foreground";
  }
  if (strategy === "setup-required") {
    throw new Error(
      "로컬 Whisper가 설치되지 않았습니다. ./kirinuki.sh setup --mode whisper를 먼저 실행하세요."
    );
  }
  if (strategy === "origin-mismatch") {
    throw new Error(
      "Extension 절대 경로가 설치 때와 달라졌습니다. 같은 profile/backend로 setup --mode whisper를 다시 실행하세요."
    );
  }
  if (strategy === "ready") {
    return;
  }
  let foregroundExit = null;
  if (strategy === "systemd") {
    await runStreaming(
      process.execPath,
      [stackCliPath, "start"],
      { env: withoutSecrets(context.env) }
    );
  } else {
    await mkdir(context.paths.stateRoot, {
      recursive: true,
      mode: 0o700
    });
    const logFd = openSync(
      context.paths.captionLogPath,
      "a",
      0o600
    );
    try {
      const child = spawn(
        process.execPath,
        [stackCliPath, "start", "--foreground"],
        {
          cwd: packageRoot,
          env: withoutSecrets(context.env),
          detached: true,
          stdio: ["ignore", logFd, logFd]
        }
      );
      child.once("exit", (code, signal) => {
        foregroundExit = { code, signal };
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
  }

  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    await delay(500);
    if (foregroundExit) {
      throw new Error(
        `로컬 Whisper foreground가 준비 전에 종료했습니다 (${foregroundExit.code ?? foregroundExit.signal}). 로그: ${context.paths.captionLogPath}`
      );
    }
    result = readCaptionStatus(context.env);
    if (
      result.ok
      && result.value?.endpoints?.stt
      && result.value?.endpoints?.gateway
    ) {
      return;
    }
  }
  throw new Error(
    `로컬 Whisper가 4분 안에 준비되지 않았습니다. 로그: ${context.paths.captionLogPath}`
  );
}

async function launchBrowser(browser, args, options, context) {
  if (options.dryRun) {
    line(context.stdout, `dry-run: ${describeCommand(browser, args)}`);
    return;
  }
  await mkdir(context.paths.browserProfileRoot, {
    recursive: true,
    mode: 0o700
  });
  await mkdir(context.paths.stateRoot, {
    recursive: true,
    mode: 0o700
  });
  const logFd = openSync(context.paths.browserLogPath, "a", 0o600);
  try {
    const child = spawn(browser, args, {
      cwd: packageRoot,
      env: withoutSecrets(context.env),
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

async function openCommand(options, context) {
  const settings = await readSettings(context.paths);
  const mode = options.mode || settings?.mode || "audseg";
  const browser = inspectPreferredBrowser({
    explicit: options.browser,
    stored: settings?.browser,
    env: context.env
  });
  if (!browser.available) {
    throw new Error(
      "Chromium을 찾지 못했습니다.\n"
      + dependencyGuidance(mode).join("\n")
    );
  }
  if (!browser.supported) {
    if (browser.product === "chrome") {
      throw new Error(
        "일반 Google Chrome은 unpacked Extension 자동 로드를 지원하지 않습니다.\n"
        + "Chromium으로 실행하거나 Chrome의 chrome://extensions에서 extension 폴더를 수동으로 불러오세요."
      );
    }
    throw new Error(
      `Chromium ${MINIMUM_BROWSER_VERSION} 이상이 필요합니다. 현재: ${browser.version || "알 수 없음"}`
    );
  }
  const build = await inspectBuild();
  if (!build.ready) {
    throw new Error(
      "Extension 빌드가 준비되지 않았습니다. ./kirinuki.sh setup을 먼저 실행하세요."
    );
  }
  if (mode === "whisper") {
    await ensureWhisper(options, context);
  }
  const sourceUrl = options.url || DEFAULT_SOURCE_URL;
  const args = browserLaunchArgs({
    extensionRoot: path.join(packageRoot, "extension"),
    profileRoot: context.paths.browserProfileRoot,
    sourceUrl
  });
  await launchBrowser(browser.binary, args, options, context);
  if (!options.dryRun) {
    await writeSettings(context.paths, {
      mode,
      browser: browser.binary
    });
  }
  line(context.stdout, options.dryRun
    ? `dry-run: Kirinuki 전용 Chromium 프로필로 열 예정: ${sourceUrl}`
    : `Kirinuki 전용 Chromium 프로필로 열었습니다: ${sourceUrl}`);
  line(
    context.stdout,
    "영상 탭에서 확장 아이콘을 눌러 사이드패널을 열고 시작·끝 스탬프를 찍으세요."
  );
  line(
    context.stdout,
    "브라우저는 편집 내용을 보호하기 위해 도우미가 강제로 종료하지 않습니다."
  );
}

async function doctorCommand(options, context) {
  const settings = await readSettings(context.paths);
  const mode = options.mode || settings?.mode || "audseg";
  const browser = inspectPreferredBrowser({
    explicit: options.browser,
    stored: settings?.browser,
    env: context.env
  });
  const report = await inspectLinuxEnvironment({
    mode,
    browser: browser.binary || options.browser || settings?.browser,
    env: context.env,
    platform: context.platform
  });
  if (options.json) {
    line(context.stdout, JSON.stringify(report, null, 2));
  } else {
    printDoctor(report, context.stdout);
    if (!report.ready) {
      for (const guidance of dependencyGuidance(mode)) {
        line(context.stdout, guidance);
      }
    }
  }
  if (!report.ready) {
    context.setExitCode(1);
  }
}

async function statusCommand(options, context) {
  const settings = await readSettings(context.paths);
  const mode = options.mode || settings?.mode || "audseg";
  const profileInfo = await stat(context.paths.browserProfileRoot)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const caption = mode === "whisper"
    ? readCaptionStatus(context.env)
    : {
      ok: true,
      value: {
        required: false,
        message: "AudSeg는 백그라운드 서비스가 필요 없습니다."
      }
    };
  const value = {
    schema: HELPER_SCHEMA,
    configured: Boolean(settings),
    mode,
    extensionRoot: path.join(packageRoot, "extension"),
    browserProfile: {
      path: context.paths.browserProfileRoot,
      created: profileInfo,
      running: "not-claimed"
    },
    caption
  };
  if (options.json) {
    line(context.stdout, JSON.stringify(value, null, 2));
    if (mode === "whisper" && !caption.ok) {
      context.setExitCode(1);
    }
    return;
  }
  line(
    context.stdout,
    `도우미 설정: ${settings ? "있음" : "없음"} · mode=${mode}`
  );
  line(
    context.stdout,
    `전용 브라우저 프로필: ${profileInfo ? "생성됨" : "아직 없음"} · ${context.paths.browserProfileRoot}`
  );
  line(
    context.stdout,
    "브라우저 실행 여부는 추측하지 않습니다. 창은 사용자가 정상적으로 닫습니다."
  );
  if (mode === "whisper") {
    if (!caption.ok) {
      line(context.stdout, `Whisper 상태 실패: ${caption.error}`);
      context.setExitCode(1);
      return;
    }
    const status = caption.value;
    line(
      context.stdout,
      `Whisper: configured=${Boolean(status.configured)}`
      + ` · origin=${status.originMatchesCurrentPath ? "OK" : "불일치"}`
      + ` · STT=${status.endpoints?.stt ? "ready" : "down"}`
      + ` · gateway=${status.endpoints?.gateway ? "ready" : "down"}`
    );
  } else {
    line(context.stdout, caption.value.message);
  }
}

async function stopCommand(options, context) {
  const settings = await readSettings(context.paths);
  const mode = options.mode || settings?.mode || "audseg";
  if (mode === "audseg") {
    line(context.stdout, "AudSeg에는 중지할 백그라운드 서비스가 없습니다.");
    line(
      context.stdout,
      "Chromium 창은 현재 편집을 보호하기 위해 사용자가 직접 정상 종료하세요."
    );
    return;
  }
  const command = [process.execPath, [stackCliPath, "stop"]];
  if (options.dryRun) {
    line(
      context.stdout,
      `dry-run: ${describeCommand(command[0], command[1])}`
    );
    return;
  }
  await runStreaming(command[0], command[1], {
    env: withoutSecrets(context.env)
  });
  line(
    context.stdout,
    "Chromium 창은 닫지 않았습니다. 편집을 저장한 뒤 사용자가 직접 정상 종료하세요."
  );
}

export function helpText() {
  return `
Kirinuki Linux 원클릭 도우미

사용법:
  ./setup.sh [--mode audseg|whisper]
  ./kirinuki.sh
  ./kirinuki.sh setup [--mode audseg|whisper] [--profile draft|auto|light|quality] [--backend auto|cpu|cuda] [--browser PATH] [--yes] [--dry-run]
  ./kirinuki.sh doctor [--mode audseg|whisper] [--browser PATH] [--json]
  ./kirinuki.sh open [--mode audseg|whisper] [--browser PATH] [--dry-run] [영상 URL]
  ./kirinuki.sh start [--mode audseg|whisper] [--browser PATH] [--dry-run] [영상 URL]
  ./kirinuki.sh status [--mode audseg|whisper] [--json]
  ./kirinuki.sh stop [--mode audseg|whisper] [--dry-run]

명령:
  setup   npm 의존성·Extension 빌드·검증 후 선택한 자막 방식을 준비
  doctor  Linux·Node·npm·브라우저·빌드·선택 자막 방식 상태를 읽기 전용 점검
  open    전용 Chromium 프로필과 Extension으로 영상 URL 열기
  start   open과 동일하며 기존 사용자에게 익숙한 별칭
  status  저장된 방식과 브라우저 profile, 선택적 Whisper 서비스 상태 표시
  stop    Whisper companion만 안전하게 중지; Chromium은 강제 종료하지 않음

자막 방식:
  audseg   기본값. 모델·서버 없이 빈 자막 타이밍 생성
  whisper  고정·검증된 로컬 Whisper Tiny로 한국어 글과 타이밍 생성

지원 URL:
  chzzk.naver.com, youtube.com, youtu.be, naver.me의 공개 HTTPS 주소

안전:
  시스템 패키지를 자동 설치하지 않고, API 키를 받거나 저장하지 않습니다.
  자동 Extension 로드는 Chromium 전용입니다. 일반 Google Chrome은 chrome://extensions에서 수동 로드하세요.
  전용 Chromium profile은 ${resolveLinuxHelperPaths().browserProfileRoot}에 유지됩니다.
`.trim();
}

async function interactiveCommand(context) {
  if (!context.stdin.isTTY || !context.stdout.isTTY) {
    line(context.stdout, helpText());
    return;
  }
  const settings = await readSettings(context.paths);
  const rl = createInterface({
    input: context.stdin,
    output: context.stdout
  });
  try {
    line(context.stdout, "Kirinuki Linux 도우미");
    line(context.stdout, "  1) 영상 열기");
    line(context.stdout, "  2) 처음 설정/다시 설정");
    line(context.stdout, "  3) 상태 점검");
    line(context.stdout, "  4) Whisper 서비스 중지");
    line(context.stdout, "  5) 도움말");
    line(context.stdout, "  0) 종료");
    const fallback = settings ? "1" : "2";
    const answer = String(
      await rl.question(`선택 [${fallback}]: `)
    ).trim() || fallback;
    if (answer === "1") {
      const url = String(
        await rl.question(`영상 URL [${DEFAULT_SOURCE_URL}]: `)
      ).trim();
      return {
        command: "open",
        options: {
          ...parseLinuxHelperArgs(["open"]).options,
          url: validateSourceUrl(url)
        }
      };
    }
    if (answer === "2") {
      return {
        command: "setup",
        options: parseLinuxHelperArgs(["setup"]).options
      };
    }
    if (answer === "3") {
      return {
        command: "doctor",
        options: parseLinuxHelperArgs(["doctor"]).options
      };
    }
    if (answer === "4") {
      return {
        command: "stop",
        options: {
          ...parseLinuxHelperArgs(["stop"]).options,
          mode: "whisper"
        }
      };
    }
    if (answer === "5") {
      return {
        command: "help",
        options: parseLinuxHelperArgs(["help"]).options
      };
    }
    if (answer === "0") {
      return null;
    }
    throw new TypeError("0부터 5 중 하나를 입력하세요.");
  } finally {
    rl.close();
  }
}

function defaultContext(overrides = {}) {
  const context = {
    env: process.env,
    platform: process.platform,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    paths: resolveLinuxHelperPaths(),
    setExitCode(value) {
      process.exitCode = value;
    },
    ...overrides
  };
  if (!overrides.paths) {
    context.paths = resolveLinuxHelperPaths({
      env: context.env,
      homeDir: os.homedir()
    });
  }
  return context;
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const context = defaultContext(overrides);
  if (context.platform !== "linux") {
    throw new Error("Kirinuki Linux 도우미는 현재 Linux만 지원합니다.");
  }
  if (!versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION)) {
    throw new Error(`Node ${MINIMUM_NODE_VERSION} 이상이 필요합니다.`);
  }
  let parsed = parseLinuxHelperArgs(argv);
  if (!parsed.command) {
    parsed = await interactiveCommand(context);
    if (!parsed) {
      return;
    }
  }
  const { command, options } = parsed;
  if (command === "help") {
    line(context.stdout, helpText());
    return;
  }
  if (command === "setup") {
    await setupCommand(options, context);
    return;
  }
  if (command === "doctor") {
    await doctorCommand(options, context);
    return;
  }
  if (command === "start" || command === "open") {
    await openCommand(options, context);
    return;
  }
  if (command === "status") {
    await statusCommand(options, context);
    return;
  }
  if (command === "stop") {
    await stopCommand(options, context);
    return;
  }
  throw new TypeError(`알 수 없는 명령입니다: ${command}`);
}

function isMainModule() {
  return Boolean(
    process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  main().catch((error) => {
    line(process.stderr, `Kirinuki 도우미 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
