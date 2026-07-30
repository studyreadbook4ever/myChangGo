#!/usr/bin/env node

import {
  access,
  chmod,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BROWSER_CANDIDATES = Object.freeze([
  "chromium",
  "chromium-browser"
]);
export const DEFAULT_SOURCE_URL = "https://chzzk.naver.com/";
export const MINIMUM_NODE_VERSION = "20.9.0";
export const MINIMUM_BROWSER_MAJOR = 120;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_SCHEMA = "kirinuki-linux-helper/audseg-only-v1";
const SUPPORTED_COMMANDS = new Set([
  "setup",
  "doctor",
  "open",
  "start",
  "status",
  "stop",
  "help"
]);
const FORBIDDEN_SECRET_OPTION = /(?:api[-_]?key|token|secret|password|credential)/iu;

function finiteVersionPart(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function versionAtLeast(actual, minimum) {
  const actualParts = String(actual || "")
    .replace(/^v/u, "")
    .split(".")
    .map(finiteVersionPart);
  const minimumParts = String(minimum || "")
    .replace(/^v/u, "")
    .split(".")
    .map(finiteVersionPart);
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = actualParts[index] || 0;
    const right = minimumParts[index] || 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

export function parseBrowserMajor(versionText) {
  const match = String(versionText || "").match(/\b(\d+)(?:\.\d+){1,3}\b/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function browserProduct(versionText) {
  const value = String(versionText || "");
  if (/Chromium/iu.test(value)) {
    return "chromium";
  }
  if (/Google Chrome/iu.test(value)) {
    return "chrome";
  }
  return "unknown";
}

function commandPath(command, env = process.env) {
  const value = String(command || "").trim();
  if (!value) {
    return null;
  }
  if (value.includes(path.sep)) {
    return path.resolve(value);
  }
  const pathEntries = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, value);
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (!probe.error || probe.error.code !== "ENOENT") {
      return candidate;
    }
  }
  return null;
}

export function inspectBrowser({ requested, env = process.env } = {}) {
  const binary = commandPath(requested, env);
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
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const version = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const product = browserProduct(version);
  const major = parseBrowserMajor(version);
  return {
    available: !result.error && result.status === 0,
    binary,
    major,
    product,
    supported: (
      !result.error
      && result.status === 0
      && product === "chromium"
      && Number.isInteger(major)
      && major >= MINIMUM_BROWSER_MAJOR
    ),
    version
  };
}

export function inspectPreferredBrowser({
  explicit = null,
  stored = null,
  env = process.env
} = {}) {
  if (explicit) {
    return inspectBrowser({ requested: explicit, env });
  }
  if (stored) {
    const storedResult = inspectBrowser({ requested: stored, env });
    if (storedResult.supported) {
      return storedResult;
    }
  }
  const envBrowser = String(env.KIRINUKI_BROWSER_BINARY || "").trim();
  if (envBrowser) {
    const envResult = inspectBrowser({ requested: envBrowser, env });
    if (envResult.supported) {
      return envResult;
    }
  }
  for (const candidate of BROWSER_CANDIDATES) {
    const result = inspectBrowser({ requested: candidate, env });
    if (result.supported) {
      return result;
    }
  }
  return {
    available: false,
    binary: null,
    major: null,
    product: "unknown",
    supported: false,
    version: ""
  };
}

export function validateSourceUrl(value) {
  const normalized = String(value || "").trim() || DEFAULT_SOURCE_URL;
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("영상 URL에 제어 문자를 넣을 수 없습니다.");
  }
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("영상 URL 형식이 올바르지 않습니다.");
  }
  if (url.protocol !== "https:") {
    throw new Error("영상 URL은 공개 HTTPS 주소여야 합니다.");
  }
  if (url.username || url.password) {
    throw new Error("영상 URL에 사용자 정보나 비밀번호를 넣을 수 없습니다.");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = (
    hostname === "chzzk.naver.com"
    || hostname === "youtube.com"
    || hostname === "www.youtube.com"
    || hostname === "m.youtube.com"
    || hostname === "youtu.be"
    || hostname === "naver.me"
  );
  if (!allowed) {
    throw new Error("치지직·YouTube·naver.me 영상 URL만 열 수 있습니다.");
  }
  return url.toString();
}

export function browserLaunchArgs({
  extensionRoot,
  profileRoot,
  sourceUrl
}) {
  return [
    `--user-data-dir=${path.resolve(profileRoot)}`,
    `--disable-extensions-except=${path.resolve(extensionRoot)}`,
    `--load-extension=${path.resolve(extensionRoot)}`,
    "--no-first-run",
    "--no-default-browser-check",
    validateSourceUrl(sourceUrl)
  ];
}

export function resolveLinuxHelperPaths({
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const configBase = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(homeDir, ".config");
  const stateBase = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(homeDir, ".local", "state");
  const configRoot = path.join(configBase, "kirinuki-studio");
  return {
    configRoot,
    stateRoot: path.join(stateBase, "kirinuki-studio"),
    browserProfileRoot: path.join(configRoot, "chromium-profile"),
    configPath: path.join(configRoot, "helper.json")
  };
}

function emptyOptions() {
  return {
    browser: null,
    yes: false,
    dryRun: false,
    json: false,
    url: null
  };
}

export function parseLinuxHelperArgs(argv = []) {
  const args = [...argv].map((entry) => String(entry));
  if (args.some((entry) => FORBIDDEN_SECRET_OPTION.test(entry))) {
    throw new Error("이 도우미 인자에는 API 키·토큰 같은 비밀 값을 넣지 마세요.");
  }
  const command = args[0] && !args[0].startsWith("-")
    ? args.shift()
    : "help";
  if (!SUPPORTED_COMMANDS.has(command)) {
    throw new Error(`지원하지 않는 명령입니다: ${command}`);
  }
  const options = emptyOptions();
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--yes") {
      options.yes = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--browser") {
      if (!args[0] || args[0].startsWith("-")) {
        throw new Error("--browser 뒤에 실행 파일 경로가 필요합니다.");
      }
      options.browser = args.shift();
      continue;
    }
    if (argument.startsWith("--browser=")) {
      options.browser = argument.slice("--browser=".length);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`지원하지 않는 옵션입니다: ${argument}`);
    }
    if (!["open", "start"].includes(command) || options.url) {
      throw new Error(`예상하지 못한 인자입니다: ${argument}`);
    }
    options.url = argument;
  }
  if (!["open", "start"].includes(command) && options.url) {
    throw new Error(`${command} 명령에는 영상 URL을 사용할 수 없습니다.`);
  }
  return { command, options };
}

function commandAvailable(command, env = process.env) {
  return Boolean(commandPath(command, env));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readConfig(paths) {
  try {
    const payload = JSON.parse(await readFile(paths.configPath, "utf8"));
    if (payload?.schema !== CONFIG_SCHEMA) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function writeConfig(paths, payload) {
  await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.configPath,
    `${JSON.stringify({
      schema: CONFIG_SCHEMA,
      ...payload,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function quotedCommand(command, args) {
  return [command, ...args]
    .map((entry) => JSON.stringify(String(entry)))
    .join(" ");
}

function run(command, args, {
  cwd = packageRoot,
  dryRun = false,
  env = process.env
} = {}) {
  if (dryRun) {
    process.stdout.write(`[dry-run] ${quotedCommand(command, args)}\n`);
    return;
  }
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 실패 (${result.status})`);
  }
}

async function extensionReady() {
  const required = [
    path.join(packageRoot, "extension", "manifest.json"),
    path.join(packageRoot, "extension", "editor", "editor.js"),
    path.join(packageRoot, "extension", "editor", "audseg-worker.js")
  ];
  return (await Promise.all(required.map(fileExists))).every(Boolean);
}

export async function restoreLauncherPermissions(root = packageRoot) {
  for (const relativePath of ["kirinuki.sh", "setup.sh"]) {
    const filePath = path.join(root, relativePath);
    if (await fileExists(filePath)) {
      await chmod(filePath, 0o755);
    }
  }
}

function installHint() {
  return [
    "필요한 도구를 자동 설치하지 않습니다.",
    "Debian/Ubuntu 예: sudo apt install nodejs npm chromium",
    "Fedora 예: sudo dnf install nodejs npm chromium",
    "Arch 예: sudo pacman -S nodejs npm chromium"
  ].join("\n");
}

async function doctorReport(options, env = process.env) {
  const paths = resolveLinuxHelperPaths({ env });
  const config = await readConfig(paths);
  const browser = inspectPreferredBrowser({
    explicit: options.browser,
    stored: config?.browserBinary,
    env
  });
  const npmCommand = String(env.KIRINUKI_NPM_BINARY || "").trim() || "npm";
  return {
    schema: "kirinuki-linux-helper/doctor-v1",
    mode: "audseg-local",
    node: {
      version: process.versions.node,
      ready: versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION)
    },
    npm: {
      command: npmCommand,
      ready: commandAvailable(npmCommand, env)
    },
    browser,
    extension: {
      path: path.join(packageRoot, "extension"),
      ready: await extensionReady()
    },
    services: {
      required: false,
      running: false
    }
  };
}

function doctorReady(report) {
  return (
    report.node.ready
    && report.npm.ready
    && report.browser.supported
  );
}

function printDoctor(report) {
  process.stdout.write([
    `Node ${report.node.version}: ${report.node.ready ? "준비됨" : "20.9 이상 필요"}`,
    `npm: ${report.npm.ready ? report.npm.command : "없음"}`,
    report.browser.supported
      ? `Chromium: ${report.browser.version}`
      : "Chromium 없음 또는 자동 로드 미지원",
    `Extension 빌드: ${report.extension.ready ? "준비됨" : "setup 필요"}`,
    "AudSeg: 브라우저 내장 · 모델·서버·백그라운드 서비스 없음"
  ].join("\n") + "\n");
  if (!doctorReady(report)) {
    process.stdout.write(`${installHint()}\n`);
  }
}

async function setupCommand(options) {
  const report = await doctorReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printDoctor(report);
  }
  if (!doctorReady(report)) {
    process.exitCode = 1;
    return;
  }
  const npmCommand = report.npm.command;
  for (const args of [
    ["ci", "--ignore-scripts"],
    ["run", "build"],
    ["run", "validate"],
    ["run", "license:check"]
  ]) {
    run(npmCommand, args, { dryRun: options.dryRun });
  }
  if (!options.dryRun) {
    const paths = resolveLinuxHelperPaths();
    await writeConfig(paths, {
      browserBinary: report.browser.binary,
      extensionRoot: path.join(packageRoot, "extension")
    });
    await restoreLauncherPermissions();
  }
  process.stdout.write(
    options.dryRun
      ? "설정 dry-run을 마쳤습니다. 시스템과 사용자 파일을 바꾸지 않았습니다.\n"
      : "설정을 마쳤습니다. ./kirinuki.sh start \"영상 URL\"로 시작하세요.\n"
  );
}

async function openCommand(options) {
  const paths = resolveLinuxHelperPaths();
  const config = await readConfig(paths);
  const browser = inspectPreferredBrowser({
    explicit: options.browser,
    stored: config?.browserBinary
  });
  if (!browser.supported) {
    throw new Error(
      "Chromium 120 이상을 찾지 못했습니다. 일반 Google Chrome은 chrome://extensions에서 extension 폴더를 수동으로 불러오세요."
    );
  }
  if (!await extensionReady()) {
    throw new Error("./setup.sh를 먼저 실행해 Extension을 빌드해 주세요.");
  }
  const args = browserLaunchArgs({
    extensionRoot: path.join(packageRoot, "extension"),
    profileRoot: paths.browserProfileRoot,
    sourceUrl: options.url
  });
  if (options.dryRun) {
    process.stdout.write(`[dry-run] ${quotedCommand(browser.binary, args)}\n`);
    return;
  }
  await mkdir(paths.browserProfileRoot, { recursive: true, mode: 0o700 });
  await writeConfig(paths, {
    browserBinary: browser.binary,
    extensionRoot: path.join(packageRoot, "extension")
  });
  const child = spawn(browser.binary, args, {
    cwd: packageRoot,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  process.stdout.write("AudSeg 키리누키 편집용 Chromium을 열었습니다.\n");
}

async function statusCommand(options) {
  const report = await doctorReport(options);
  const status = {
    schema: "kirinuki-linux-helper/status-v1",
    mode: "audseg-local",
    browser: report.browser,
    extension: report.extension,
    services: {
      required: false,
      running: false
    }
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write([
      `방식: AudSeg ${status.services.required ? "서비스 필요" : "브라우저 내장"}`,
      `Extension: ${status.extension.ready ? "준비됨" : "setup 필요"}`,
      `Chromium: ${status.browser.supported ? status.browser.version : "찾지 못함"}`
    ].join("\n") + "\n");
  }
}

export function helpText() {
  return `260711vtuber · AudSeg 전용 Linux 도우미

사용법:
  ./setup.sh [--browser PATH] [--dry-run]
  ./kirinuki.sh doctor [--browser PATH] [--json]
  ./kirinuki.sh open [--browser PATH] [--dry-run] [영상 URL]
  ./kirinuki.sh start [--browser PATH] [--dry-run] [영상 URL]
  ./kirinuki.sh status [--browser PATH] [--json]

setup   의존성 확인 → npm 설치 → 빌드 → 검증
open    전용 Chromium profile과 현재 extension을 열기
start   open과 동일한 사람용 별칭
status  Extension과 Chromium 준비 상태 확인

자동 초벌은 AudSeg가 브라우저 안에서 빈 자막 타이밍만 만듭니다.
모델·서버·API 키·백그라운드 서비스가 필요하지 않습니다.
일반 Google Chrome은 chrome://extensions에서 extension 폴더를 수동으로
불러오세요. 이 도우미는 sudo, 시스템 패키지 설치, 브라우저 강제 종료를
자동 실행하지 않습니다.
`;
}

async function interactiveCommand() {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    process.stdout.write(helpText());
    const answer = (await terminal.question(
      "\n1) 설정  2) 영상 열기  3) 점검  4) 상태  5) 끝내기\n선택: "
    )).trim();
    return {
      "1": { command: "setup", options: emptyOptions() },
      "2": { command: "start", options: emptyOptions() },
      "3": { command: "doctor", options: emptyOptions() },
      "4": { command: "status", options: emptyOptions() },
      "5": { command: "help", options: emptyOptions() }
    }[answer] || { command: "help", options: emptyOptions() };
  } finally {
    terminal.close();
  }
}

async function main() {
  let parsed;
  if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) {
    parsed = await interactiveCommand();
  } else {
    parsed = parseLinuxHelperArgs(process.argv.slice(2));
  }
  const { command, options } = parsed;
  if (command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (command === "doctor") {
    const report = await doctorReport(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printDoctor(report);
    }
    if (!doctorReady(report)) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "setup") {
    await setupCommand(options);
    return;
  }
  if (command === "open" || command === "start") {
    await openCommand(options);
    return;
  }
  if (command === "status") {
    await statusCommand(options);
    return;
  }
  if (command === "stop") {
    process.stdout.write("AudSeg에는 중지할 백그라운드 서비스가 없습니다.\n");
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
