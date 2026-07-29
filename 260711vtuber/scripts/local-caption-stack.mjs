#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream
} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_STT_PORT,
  LOCAL_CAPTION_STACK_SCHEMA,
  LOCAL_CAPTION_STACK_SERVICE,
  LOOPBACK_HOST,
  MINIMUM_NODE_VERSION,
  PINNED_MODELS,
  PINNED_VAD_MODEL,
  PINNED_WHISPER_CPP,
  buildWhisperServerArgs,
  createInstallConfig,
  extensionOriginForPath,
  installedProfileSummary,
  parseLocalCaptionStackArgs,
  renderSystemdUserUnit,
  resolveSemanticProfile,
  resolveStackPaths,
  secretFreeConfigJson,
  supportedNodeVersion,
  systemdRestartCommands,
  systemdStartCommands,
  systemdStopCommands
} from "./local-caption-stack-core.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(import.meta.url);
const gatewayPath = path.join(packageRoot, "scripts", "solar-caption-gateway.mjs");
const STARTUP_TIMEOUT_MS = 4 * 60 * 1_000;
const CAPTION_REQUEST_SCHEMA =
  "chzzk-kirinuki-caption-request/v1";
const CAPTION_HEALTH_SCHEMA =
  "chzzk-kirinuki-caption-agent/health-v1";
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

function output(message = "") {
  process.stdout.write(`${message}\n`);
}

function outputError(message) {
  process.stderr.write(`${message}\n`);
}

export function helpText() {
  return `
Kirinuki 로컬 자막 스택

사용법:
  npm run caption-stack -- doctor [--profile draft|auto|light|quality]
  npm run caption-stack -- setup  [--profile draft|auto|light|quality] [--backend auto|cpu|cuda] [--dry-run]
  npm run caption-stack -- start  [--foreground]
  npm run caption-stack -- status [--json]
  npm run caption-stack -- stop

명령:
  doctor  Node·빌드 도구·NVIDIA·systemd-user·설치 상태를 읽기 전용 점검
  setup   고정 버전 whisper.cpp와 SHA 검증 모델/VAD를 사용자 데이터 경로에 설치
  start   systemd-user를 우선 사용하고 불가능하면 foreground로 안전하게 실행
  status  서비스와 127.0.0.1 전용 두 포트 상태 확인
  stop    systemd-user 서비스 또는 검증된 foreground 프로세스 중지

profile:
  draft    기본값. 빠른 자막 초벌용 Whisper Tiny tiny-q5_1
  auto     균형형 small-q5_1. 6 GiB 미만에서는 light로 자동 하향
  light    저사양 CPU용 base-q5_1
  quality  정확도 우선 medium-q5_0

비밀 값:
  기본 Whisper Tiny 초벌에는 API 키가 필요하지 않습니다.
  Upstage 키는 Solar 고급 초벌을 명시적으로 고른 요청에만 전달합니다.
  CLI는 API 키를 입력받거나 옵션·파일·환경·systemd unit·로그에 기록하지 않습니다.

systemd-user가 없다면:
  npm run caption-stack -- start --foreground
  종료는 같은 터미널에서 Ctrl+C
`.trim();
}

async function pathExists(candidate, mode = fsConstants.F_OK) {
  try {
    await access(candidate, mode);
    return true;
  } catch {
    return false;
  }
}

function executableFromPath(name, env = process.env) {
  const directories = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH without exposing environment contents.
    }
  }
  return null;
}

function captureCommand(file, args, {
  env = withoutCaptionSecrets(),
  timeout = 5_000
} = {}) {
  if (!executableFromPath(file, env)) {
    return { available: false, ok: false, stdout: "" };
  }
  const result = spawnSync(file, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    maxBuffer: 1024 * 1024
  });
  return {
    available: true,
    ok: result.status === 0,
    stdout: result.status === 0 ? String(result.stdout || "") : ""
  };
}

export function inspectLocalHardware({
  env = withoutCaptionSecrets(),
  platform = process.platform
} = {}) {
  const nvidia = platform === "linux"
    ? captureCommand(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { env }
    )
    : { available: false, ok: false, stdout: "" };
  const firstGpu = nvidia.ok
    ? nvidia.stdout.trim().split(/\r?\n/u)[0] || ""
    : "";
  const [gpuName = "", memoryMiB = ""] = firstGpu
    .split(",")
    .map((value) => value.trim());
  const nvcc = platform === "linux"
    ? captureCommand("nvcc", ["--version"], { env })
    : { available: false, ok: false, stdout: "" };
  return {
    platform,
    cpuCount: os.availableParallelism?.() || os.cpus().length || 1,
    totalMemoryBytes: os.totalmem(),
    nvidiaDetected: Boolean(nvidia.ok && gpuName),
    nvidiaName: gpuName,
    nvidiaMemoryMiB: Number(memoryMiB) || null,
    nvccAvailable: nvcc.ok
  };
}

function stackPaths(env = process.env) {
  return resolveStackPaths({
    env,
    homeDir: os.homedir(),
    repoRoot: packageRoot
  });
}

function systemdUserAvailable(env = withoutCaptionSecrets()) {
  if (process.platform !== "linux" || !executableFromPath("systemctl", env)) {
    return false;
  }
  return spawnSync("systemctl", ["--user", "show-environment"], {
    env,
    stdio: "ignore",
    timeout: 4_000
  }).status === 0;
}

function systemdServiceState(env = withoutCaptionSecrets()) {
  if (!systemdUserAvailable(env)) {
    return "unavailable";
  }
  const result = spawnSync(
    "systemctl",
    ["--user", "is-active", LOCAL_CAPTION_STACK_SERVICE],
    {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000
    }
  );
  return String(result.stdout || "").trim() || "inactive";
}

async function readInstalledConfig(paths, { required = false } = {}) {
  let raw;
  try {
    raw = await readFile(paths.configPath, "utf8");
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return null;
    }
    if (error?.code === "ENOENT") {
      throw new Error(
        "로컬 자막 스택이 아직 설치되지 않았습니다. 먼저 setup을 실행하세요."
      );
    }
    throw error;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("로컬 자막 스택 설정 파일이 올바른 JSON이 아닙니다.");
  }
  const pinnedModel = PINNED_MODELS[config?.effectiveProfile];
  if (
    config?.schema !== LOCAL_CAPTION_STACK_SCHEMA
    || config.host !== LOOPBACK_HOST
    || !["cpu", "cuda"].includes(config.backend)
    || !Number.isInteger(config.sttPort)
    || !Number.isInteger(config.gatewayPort)
    || config.sttPort < 1
    || config.sttPort > 65_535
    || config.gatewayPort < 1
    || config.gatewayPort > 65_535
    || config.sttPort === config.gatewayPort
    || !/^chrome-extension:\/\/[a-p]{32}$/u.test(String(config.origin || ""))
    || config.whisper?.version !== PINNED_WHISPER_CPP.version
    || config.whisper?.commit !== PINNED_WHISPER_CPP.commit
    || !pinnedModel
    || config.model?.id !== pinnedModel.id
    || config.model?.sha256 !== pinnedModel.sha256
    || config.model?.size !== pinnedModel.size
    || config.vad?.id !== PINNED_VAD_MODEL.id
    || config.vad?.sha256 !== PINNED_VAD_MODEL.sha256
    || config.vad?.size !== PINNED_VAD_MODEL.size
  ) {
    throw new Error(
      "로컬 자막 스택 설정이 현재 고정 버전과 맞지 않습니다. setup을 다시 실행하세요."
    );
  }
  for (const [candidate, root, label] of [
    [config.whisper?.binaryPath, paths.buildsRoot, "whisper binary"],
    [config.model?.path, paths.modelsRoot, "Whisper model"],
    [config.vad?.path, paths.modelsRoot, "VAD model"]
  ]) {
    const relative = path.relative(root, path.resolve(String(candidate || "")));
    if (!candidate || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} 경로가 관리 디렉터리를 벗어났습니다.`);
    }
  }
  return config;
}

function installOriginMatches(paths, config) {
  return Boolean(
    config
    && config.origin === extensionOriginForPath(paths.extensionRoot)
  );
}

function assertInstallOriginMatches(paths, config) {
  if (!installOriginMatches(paths, config)) {
    throw new Error(
      "Extension 폴더 경로가 설치 때와 달라졌습니다. caption-stack:setup을 다시 실행하세요."
    );
  }
}

async function sha256File(filePath) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verifiedFile(filePath, artifact) {
  try {
    const info = await stat(filePath);
    return (
      info.isFile()
      && info.size === artifact.size
      && await sha256File(filePath) === artifact.sha256
    );
  } catch {
    return false;
  }
}

async function downloadVerifiedArtifact(
  artifact,
  destination,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (await verifiedFile(destination, artifact)) {
    output(`검증됨: ${artifact.name}`);
    return destination;
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Node fetch를 사용할 수 없습니다.");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.part-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const response = await fetchImpl(artifact.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60 * 1_000)
    });
    if (!response.ok || !response.body) {
      throw new Error(`${artifact.name} 다운로드 실패 (${response.status})`);
    }
    const advertisedSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedSize) && advertisedSize > artifact.size) {
      throw new Error(`${artifact.name} 응답 크기가 고정 manifest보다 큽니다.`);
    }
    let receivedBytes = 0;
    const enforceArtifactSize = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > artifact.size) {
          callback(
            new Error(`${artifact.name} 다운로드가 고정 크기 상한을 넘었습니다.`)
          );
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(
      Readable.fromWeb(response.body),
      enforceArtifactSize,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    );
    if (!await verifiedFile(temporary, artifact)) {
      throw new Error(`${artifact.name} 크기 또는 SHA-256 검증에 실패했습니다.`);
    }
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    output(`다운로드·SHA 검증 완료: ${artifact.name}`);
    return destination;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function assertManagedChildPath(candidate, managedRoot) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(managedRoot), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("관리 디렉터리 밖의 경로는 정리할 수 없습니다.");
  }
  return resolved;
}

function runCommandChecked(file, args, {
  env = withoutCaptionSecrets(),
  stdio = "inherit"
} = {}) {
  const result = spawnSync(file, args, {
    env,
    stdio,
    timeout: 60 * 60 * 1_000
  });
  if (result.error) {
    throw new Error(`${file} 실행 실패: ${result.error.code || "UNKNOWN"}`);
  }
  if (result.status !== 0) {
    throw new Error(`${file} 명령이 종료 코드 ${result.status}로 실패했습니다.`);
  }
}

async function writeAtomic(filePath, contents, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.part-${process.pid}-${randomBytes(5).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    await chmod(filePath, mode);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function ensureWhisperSource(paths, archivePath, config) {
  const sourceDir = assertManagedChildPath(
    config.whisper.sourceDir,
    paths.sourcesRoot
  );
  const markerPath = path.join(sourceDir, ".kirinuki-pinned-source.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.commit === PINNED_WHISPER_CPP.commit) {
      return;
    }
  } catch {
    // A missing/incomplete managed source is replaced below.
  }
  if (await pathExists(sourceDir)) {
    await rm(sourceDir, { recursive: true, force: true });
  }
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  runCommandChecked("tar", [
    "-xzf", archivePath,
    "-C", sourceDir,
    "--strip-components=1"
  ]);
  await writeAtomic(
    markerPath,
    `${JSON.stringify({
      version: PINNED_WHISPER_CPP.version,
      commit: PINNED_WHISPER_CPP.commit,
      archiveSha256: PINNED_WHISPER_CPP.archive.sha256
    }, null, 2)}\n`
  );
}

async function locateWhisperBinary(config) {
  const candidates = [
    config.whisper.binaryPath,
    path.join(config.whisper.buildRoot, "bin", "Release", "whisper-server"),
    path.join(config.whisper.buildRoot, "bin", "whisper-whisper-server")
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate, fsConstants.X_OK)) {
      return candidate;
    }
  }
  return null;
}

async function doctorCommand(options) {
  const paths = stackPaths();
  const hardware = inspectLocalHardware();
  let semantic;
  let backendError = "";
  try {
    semantic = resolveSemanticProfile(
      options.profile,
      hardware,
      options.backend
    );
  } catch (error) {
    backendError = error.message;
    semantic = resolveSemanticProfile(options.profile, hardware, "cpu");
  }
  const tools = Object.fromEntries(
    ["cmake", "tar", "c++"].map((name) => [
      name,
      Boolean(executableFromPath(name))
    ])
  );
  const config = await readInstalledConfig(paths).catch(() => null);
  const installedProfile = installedProfileSummary(config);
  const [
    modelVerified,
    vadVerified,
    sttPortListening,
    gatewayPortListening
  ] = await Promise.all([
    config ? verifiedFile(config.model.path, config.model) : false,
    config ? verifiedFile(config.vad.path, config.vad) : false,
    probePort(config?.sttPort || DEFAULT_STT_PORT),
    probePort(config?.gatewayPort || DEFAULT_GATEWAY_PORT)
  ]);
  const report = {
    node: {
      version: process.versions.node,
      supported: supportedNodeVersion(process.versions.node)
    },
    platform: {
      name: process.platform,
      supported: process.platform === "linux"
    },
    hardware: {
      cpuCount: hardware.cpuCount,
      memoryGiB: Number((hardware.totalMemoryBytes / 1024 ** 3).toFixed(1)),
      nvidiaDetected: hardware.nvidiaDetected,
      nvidiaName: hardware.nvidiaName || null,
      cudaCompiler: hardware.nvccAvailable,
      selectedBackend: semantic.backend,
      backendError: backendError || null
    },
    profile: {
      requested: semantic.requestedProfile,
      effective: semantic.effectiveProfile,
      model: semantic.model.id
    },
    tools,
    systemdUser: systemdUserAvailable(),
    installation: {
      configured: Boolean(config),
      configPath: paths.configPath,
      originMatchesCurrentPath: installOriginMatches(paths, config),
      binaryReady: Boolean(config && await locateWhisperBinary(config)),
      modelReady: modelVerified,
      vadReady: vadVerified,
      profile: installedProfile
    },
    loopbackPorts: {
      stt: {
        port: config?.sttPort || DEFAULT_STT_PORT,
        listening: sttPortListening
      },
      gateway: {
        port: config?.gatewayPort || DEFAULT_GATEWAY_PORT,
        listening: gatewayPortListening
      }
    },
    secrets: {
      acceptedByCli: false,
      persisted: false
    }
  };
  if (options.json) {
    output(JSON.stringify(report, null, 2));
    return report;
  }
  output(
    `Node ${report.node.version}: ${report.node.supported ? "OK" : `Node ${MINIMUM_NODE_VERSION}+ 필요`}`
  );
  output(`Linux: ${report.platform.supported ? "OK" : "지원 대상 아님"}`);
  output(
    `setup 후보: ${report.profile.requested} → ${report.profile.effective} (${report.profile.model})`
  );
  output(
    `backend: ${report.hardware.selectedBackend}`
    + (
      report.hardware.nvidiaDetected
        ? ` · NVIDIA ${report.hardware.nvidiaName}`
        : " · CPU 기본"
    )
  );
  if (backendError) {
    output(`backend 주의: ${backendError}`);
  }
  output(
    `빌드 도구: ${Object.entries(tools).map(([name, ready]) => `${name}=${ready ? "OK" : "없음"}`).join(" · ")}`
  );
  output(`systemd-user: ${report.systemdUser ? "사용 가능" : "foreground fallback"}`);
  output(
    `설치: ${report.installation.configured ? "설정 있음" : "setup 필요"}`
    + (
      report.installation.profile
        ? ` · 실제 ${report.installation.profile.requested}`
          + ` → ${report.installation.profile.effective}`
          + ` (${report.installation.profile.model})`
          + ` · ${report.installation.profile.backend}`
        : ""
    )
    + (
      report.installation.configured
      && !report.installation.originMatchesCurrentPath
        ? " · Extension 경로 변경(setup 필요)"
        : ""
    )
  );
  output(
    `loopback 포트: STT ${report.loopbackPorts.stt.port}=${report.loopbackPorts.stt.listening ? "사용 중" : "비어 있음"}`
    + ` · gateway ${report.loopbackPorts.gateway.port}=${report.loopbackPorts.gateway.listening ? "사용 중" : "비어 있음"}`
  );
  output("API 키: 편집기 현재 탭에서 요청 시에만 전달 · CLI 저장 안 함");
  if (!report.systemdUser) {
    output("fallback: npm run caption-stack -- start --foreground");
  }
  return report;
}

async function setupCommand(options) {
  if (process.platform !== "linux") {
    throw new Error("현재 setup은 Linux만 지원합니다.");
  }
  const paths = stackPaths();
  const hardware = inspectLocalHardware();
  const semantic = resolveSemanticProfile(
    options.profile,
    hardware,
    options.backend
  );
  const config = createInstallConfig(paths, semantic);
  const sourceArchive = path.join(
    paths.downloadsRoot,
    PINNED_WHISPER_CPP.archive.name
  );
  const modelArtifact = PINNED_MODELS[semantic.effectiveProfile];
  const modelPath = path.join(paths.modelsRoot, modelArtifact.name);
  const vadPath = path.join(paths.modelsRoot, PINNED_VAD_MODEL.name);
  const cmakeConfigure = [
    "-S", config.whisper.sourceDir,
    "-B", config.whisper.buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    `-DGGML_CUDA=${config.backend === "cuda" ? "ON" : "OFF"}`
  ];
  const cmakeBuild = [
    "--build", config.whisper.buildRoot,
    "--config", "Release",
    "--target", "whisper-server",
    "--parallel", String(config.buildJobs)
  ];

  if (options.dryRun) {
    output(JSON.stringify({
      mutation: false,
      profile: {
        requested: semantic.requestedProfile,
        effective: semantic.effectiveProfile,
        backend: semantic.backend,
        model: semantic.model.id
      },
      downloads: [
        { ...PINNED_WHISPER_CPP.archive, destination: sourceArchive },
        { ...modelArtifact, destination: modelPath },
        { ...PINNED_VAD_MODEL, destination: vadPath }
      ],
      build: [
        { file: "cmake", args: cmakeConfigure },
        { file: "cmake", args: cmakeBuild }
      ],
      configPath: paths.configPath,
      unitPath: paths.unitPath,
      secretsPersisted: false
    }, null, 2));
    return;
  }

  for (const requiredTool of ["cmake", "tar", "c++"]) {
    if (!executableFromPath(requiredTool)) {
      throw new Error(`${requiredTool}가 필요합니다. 설치 후 setup을 다시 실행하세요.`);
    }
  }
  await mkdir(paths.modelsRoot, { recursive: true, mode: 0o700 });
  await downloadVerifiedArtifact(
    PINNED_WHISPER_CPP.archive,
    sourceArchive
  );
  await downloadVerifiedArtifact(modelArtifact, modelPath);
  await downloadVerifiedArtifact(PINNED_VAD_MODEL, vadPath);
  await ensureWhisperSource(paths, sourceArchive, config);
  await mkdir(config.whisper.buildRoot, { recursive: true, mode: 0o700 });
  runCommandChecked("cmake", cmakeConfigure);
  runCommandChecked("cmake", cmakeBuild);
  const binaryPath = await locateWhisperBinary(config);
  if (!binaryPath) {
    throw new Error("빌드는 끝났지만 whisper-server 실행 파일을 찾지 못했습니다.");
  }
  const installedConfig = {
    ...config,
    whisper: { ...config.whisper, binaryPath }
  };
  const runtimeNotices = await readFile(
    path.join(packageRoot, "legal", "THIRD_PARTY_NOTICES.md"),
    "utf8"
  );
  await writeAtomic(paths.runtimeNoticesPath, runtimeNotices);
  await writeAtomic(
    paths.configPath,
    secretFreeConfigJson(installedConfig)
  );

  if (systemdUserAvailable()) {
    const restartActiveService = systemdServiceState() === "active";
    const unit = renderSystemdUserUnit({
      nodePath: process.execPath,
      cliPath,
      repoRoot: packageRoot,
      origin: installedConfig.origin
    });
    await writeAtomic(paths.unitPath, unit, 0o600);
    output(`systemd-user unit 준비: ${paths.unitPath}`);
    if (restartActiveService) {
      runSystemdCommands(
        systemdRestartCommands(),
        withoutCaptionSecrets()
      );
      await waitForManagedGateway(installedConfig, {
        requireActiveService: true
      });
      output("실행 중이던 로컬 자막 스택에 새 설치 설정 적용 완료");
    }
  } else {
    output("systemd-user를 사용할 수 없어 foreground fallback을 준비했습니다.");
  }
  output(
    `설치 완료: ${installedConfig.effectiveProfile} (${installedConfig.model.id})`
    + ` · ${installedConfig.backend} · API 키 저장 없음`
  );
  output("실행: npm run caption-stack -- start");
}

export function withoutCaptionSecrets(environment = process.env) {
  const next = { ...environment };
  for (const name of Object.keys(next)) {
    if (
      /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/iu.test(name)
      || [
        "UPSTAGE_API_KEY",
        "KIRINUKI_AGENT_TOKEN",
        "KIRINUKI_STT_API_KEY"
      ].includes(name)
    ) {
      delete next[name];
    }
  }
  return next;
}

export function managedChildEnvironment(environment = process.env) {
  const next = withoutCaptionSecrets(environment);
  const noProxy = new Set(
    [next.NO_PROXY, next.no_proxy, LOOPBACK_HOST, "localhost"]
      .flatMap((value) => String(value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const value = [...noProxy].join(",");
  next.NO_PROXY = value;
  next.no_proxy = value;
  return next;
}

function waitForPort(port, {
  timeoutMs = STARTUP_TIMEOUT_MS,
  child = null
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child?.off("exit", onExit);
      child?.off("error", onChildError);
      error ? reject(error) : resolve();
    };
    const onExit = (code) => {
      finish(new Error(`서비스가 준비 전에 종료했습니다 (${code ?? "signal"}).`));
    };
    const onChildError = (error) => {
      finish(new Error(`서비스 프로세스를 시작하지 못했습니다: ${error.code || "UNKNOWN"}`));
    };
    const attempt = () => {
      const socket = net.createConnection({ host: LOOPBACK_HOST, port });
      let retryScheduled = false;
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        finish();
      });
      const retry = () => {
        if (retryScheduled || settled) {
          return;
        }
        retryScheduled = true;
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          finish(new Error(`${LOOPBACK_HOST}:${port} 준비 시간이 초과되었습니다.`));
          return;
        }
        timer = setTimeout(attempt, 200);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    child?.once("exit", onExit);
    child?.once("error", onChildError);
    attempt();
  });
}

function probeManagedGateway(config, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Boolean(value));
    };
    const request = httpRequest({
      host: LOOPBACK_HOST,
      port: config.gatewayPort,
      path: "/v1/health",
      method: "GET",
      agent: false,
      headers: {
        Origin: config.origin,
        "X-Kirinuki-Protocol": CAPTION_REQUEST_SCHEMA,
        Accept: "application/json"
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_HEALTH_RESPONSE_BYTES) {
          request.destroy();
          finish(false);
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (settled) {
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish(false);
          return;
        }
        const validHealth = (
          response.statusCode === 200
          && payload?.schema === CAPTION_HEALTH_SCHEMA
          && payload?.status === "ok"
          && payload?.managed === true
          && payload?.originBinding === "exact-extension"
          && payload?.transcriptionMode === "local-whispercpp"
        );
        finish(validHealth);
      });
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

async function waitForManagedGateway(config, {
  timeoutMs = STARTUP_TIMEOUT_MS,
  requireActiveService = false
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probeManagedGateway(config)) {
      return;
    }
    if (
      requireActiveService
      && !["active", "activating"].includes(systemdServiceState())
    ) {
      throw new Error(
        "관리형 systemd 서비스가 gateway 준비 전에 종료했습니다."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${LOOPBACK_HOST}:${config.gatewayPort}에서 관리형 gateway를 확인하지 못했습니다.`
  );
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000))
  ]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
  }
}

async function writePidFile(paths) {
  await writeAtomic(
    paths.pidPath,
    `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: "start"
    })}\n`,
    0o600
  );
}

async function runStack(config) {
  if (config.host !== LOOPBACK_HOST) {
    throw new Error("127.0.0.1 이외 주소로는 로컬 자막 스택을 실행할 수 없습니다.");
  }
  const paths = stackPaths();
  const existingPid = await verifiedForegroundPid(paths);
  if (existingPid && existingPid !== process.pid) {
    throw new Error(`로컬 자막 스택이 이미 실행 중입니다 (PID ${existingPid}).`);
  }
  if (await probePort(config.sttPort) || await probePort(config.gatewayPort)) {
    throw new Error(
      `127.0.0.1:${config.sttPort} 또는 ${config.gatewayPort} 포트가 이미 사용 중입니다.`
    );
  }
  const binaryPath = await locateWhisperBinary(config);
  if (!binaryPath) {
    throw new Error("whisper-server가 없습니다. setup을 다시 실행하세요.");
  }
  const privateRequestPath =
    `/kirinuki-${randomBytes(24).toString("hex")}`;
  await writePidFile(paths);
  const whisper = spawn(
    binaryPath,
    buildWhisperServerArgs(config, {
      requestPath: privateRequestPath
    }),
    {
      env: managedChildEnvironment(),
      stdio: "inherit"
    }
  );
  let gateway = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await Promise.all([
      stopChild(gateway),
      stopChild(whisper)
    ]);
    await rm(paths.pidPath, { force: true }).catch(() => {});
  };
  const signalPromise = new Promise((resolve) => {
    const onSignal = (signal) => {
      void shutdown().finally(() => resolve({ signal }));
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  });

  try {
    await waitForPort(config.sttPort, { child: whisper });
    const base = managedChildEnvironment();
    gateway = spawn(process.execPath, [gatewayPath], {
      env: {
        ...base,
        KIRINUKI_AUTO_PAIR: "1",
        KIRINUKI_STT_MODE: "local-whispercpp",
        KIRINUKI_ALLOWED_ORIGIN: config.origin,
        KIRINUKI_AGENT_PORT: String(config.gatewayPort),
        KIRINUKI_STT_ENDPOINT:
          `http://${LOOPBACK_HOST}:${config.sttPort}${privateRequestPath}/inference`,
        KIRINUKI_STT_MODEL: config.model.id
      },
      stdio: "inherit"
    });
    await waitForPort(config.gatewayPort, { child: gateway });
    output(
      `로컬 자막 스택 준비: http://${LOOPBACK_HOST}:${config.gatewayPort}/v1/captions`
    );
    const exited = await Promise.race([
      signalPromise,
      new Promise((resolve) => whisper.once("exit", (code, signal) => (
        resolve({ service: "whisper", code, signal })
      ))),
      new Promise((resolve) => gateway.once("exit", (code, signal) => (
        resolve({ service: "gateway", code, signal })
      )))
    ]);
    if (exited.service && !stopping) {
      throw new Error(
        `${exited.service}가 예기치 않게 종료했습니다 (${exited.code ?? exited.signal}).`
      );
    }
  } finally {
    await shutdown();
  }
}

function runSystemdCommands(commands, env) {
  for (const command of commands) {
    runCommandChecked(command.file, command.args, { env, stdio: "ignore" });
  }
}

function printConnection(config) {
  output(`에이전트 주소: http://${LOOPBACK_HOST}:${config.gatewayPort}/v1/captions`);
  output("자동 페어링: 켜짐 · 로컬 STT는 API 키 없이 127.0.0.1에서만 연결");
  output("기본 Whisper Tiny 초벌: Upstage 호출 0회 · API 키 불필요");
  output("Solar 고급 초벌의 Upstage 키만 편집기 현재 탭에서 요청할 때 전달됩니다.");
}

async function startCommand(options) {
  const paths = stackPaths();
  const config = await readInstalledConfig(paths, { required: true });
  assertInstallOriginMatches(paths, config);
  if (!options.foreground && systemdUserAvailable()) {
    if (!await pathExists(paths.unitPath)) {
      throw new Error("systemd-user unit이 없습니다. setup을 다시 실행하세요.");
    }
    try {
      runSystemdCommands(systemdStartCommands(), withoutCaptionSecrets());
      await waitForManagedGateway(config, {
        requireActiveService: true
      });
    } catch (error) {
      try {
        runSystemdCommands(systemdStopCommands(), withoutCaptionSecrets());
      } catch {
        // Preserve the startup error; status/stop can inspect an unusual manager failure.
      }
      throw error;
    }
    output(`systemd-user로 ${LOCAL_CAPTION_STACK_SERVICE} 시작 완료`);
    printConnection(config);
    return;
  }
  if (!options.foreground) {
    output("systemd-user를 사용할 수 없어 foreground fallback으로 실행합니다.");
    output("이 터미널에서 Ctrl+C로 종료할 수 있습니다.");
  }
  printConnection(config);
  await runStack(config);
}

async function probePort(port, timeoutMs = 350) {
  try {
    await waitForPort(port, { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function statusCommand(options) {
  const paths = stackPaths();
  const config = await readInstalledConfig(paths);
  const systemd = systemdUserAvailable();
  const serviceState = systemdServiceState();
  const originMatchesCurrentPath = installOriginMatches(paths, config);
  const [sttListening, gatewayListening] = config
    ? await Promise.all([
      probePort(config.sttPort),
      probePort(config.gatewayPort)
    ])
    : [false, false];
  const managedGateway = Boolean(
    config
    && originMatchesCurrentPath
    && gatewayListening
    && await probeManagedGateway(config)
  );
  const status = {
    configured: Boolean(config),
    originMatchesCurrentPath,
    profile: config?.profile || null,
    effectiveProfile: config?.effectiveProfile || null,
    backend: config?.backend || null,
    systemdUser: systemd,
    service: serviceState,
    endpoints: {
      stt: managedGateway && sttListening,
      gateway: managedGateway,
      sttListening,
      gatewayListening
    },
    bindHost: LOOPBACK_HOST,
    secretsPersisted: false
  };
  if (options.json) {
    output(JSON.stringify(status, null, 2));
    return;
  }
  output(
    `설정: ${status.configured ? "있음" : "없음"}`
    + (
      status.configured && !status.originMatchesCurrentPath
        ? " · Extension 경로 변경 감지(setup 필요)"
        : ""
    )
  );
  output(
    `서비스: ${status.service} · backend=${status.backend || "-"} · profile=${status.effectiveProfile || "-"}`
  );
  output(
    `127.0.0.1 포트: STT=${
      status.endpoints.stt
        ? "ready"
        : status.endpoints.sttListening ? "occupied/foreign" : "down"
    } · gateway=${
      status.endpoints.gateway
        ? "ready"
        : status.endpoints.gatewayListening ? "occupied/foreign" : "down"
    }`
  );
  output("API 키 파일 저장: 없음");
}

async function verifiedForegroundPid(paths) {
  let record;
  try {
    record = JSON.parse(await readFile(paths.pidPath, "utf8"));
  } catch {
    return null;
  }
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid < 2 || process.platform !== "linux") {
    return null;
  }
  let commandLine;
  try {
    commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  if (
    !commandLine.includes(path.basename(cliPath))
    || !commandLine.split("\u0000").includes("start")
  ) {
    return null;
  }
  return pid;
}

async function stopCommand() {
  const paths = stackPaths();
  let stopped = false;
  if (systemdUserAvailable()) {
    const active = systemdServiceState() === "active";
    if (active) {
      try {
        runSystemdCommands(systemdStopCommands(), withoutCaptionSecrets());
        stopped = true;
      } catch {
        // A separately started foreground process is still checked below.
      }
    }
  }
  const foregroundPid = await verifiedForegroundPid(paths);
  if (foregroundPid) {
    process.kill(foregroundPid, "SIGTERM");
    stopped = true;
  }
  if (!stopped) {
    output("실행 중인 로컬 자막 스택을 찾지 못했습니다.");
    return;
  }
  output("로컬 자막 스택 중지 완료 · 서비스는 API 키를 보관하지 않았습니다.");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseLocalCaptionStackArgs(argv);
  if (!supportedNodeVersion(process.versions.node)) {
    throw new Error(`Node ${MINIMUM_NODE_VERSION} 이상이 필요합니다.`);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    output(helpText());
    return;
  }
  if (command === "doctor") {
    await doctorCommand(options);
    return;
  }
  if (command === "setup") {
    await setupCommand(options);
    return;
  }
  if (command === "start") {
    await startCommand(options);
    return;
  }
  if (command === "status") {
    await statusCommand(options);
    return;
  }
  if (command === "stop") {
    await stopCommand();
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
    outputError(`로컬 자막 스택 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
