import { createHash } from "node:crypto";
import path from "node:path";

export const LOCAL_CAPTION_STACK_SCHEMA =
  "chzzk-kirinuki-local-caption-stack/v1";
export const LOCAL_CAPTION_STACK_SERVICE =
  "kirinuki-caption-stack.service";
export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_STT_PORT = 4318;
export const DEFAULT_GATEWAY_PORT = 4319;
export const MINIMUM_NODE_VERSION = "20.9.0";

export const PINNED_WHISPER_CPP = Object.freeze({
  version: "v1.8.6",
  commit: "23ee03506a91ac3d3f0071b40e66a430eebdfa1d",
  archive: Object.freeze({
    name: "whisper.cpp-v1.8.6.tar.gz",
    url:
      "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/23ee03506a91ac3d3f0071b40e66a430eebdfa1d",
    sha256: "c8b0de473e9ec47a74bdf6104425c709261beeada8d6d7c1fec7432be701d032",
    size: 8_846_418
  })
});

const WHISPER_MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const WHISPER_VAD_REVISION = "9ffd54a1e1ee413ddf265af9913beaf518d1639b";

export const PINNED_MODELS = Object.freeze({
  draft: Object.freeze({
    id: "tiny-q5_1",
    name: "ggml-tiny-q5_1.bin",
    url:
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-tiny-q5_1.bin`,
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
    size: 32_152_673
  }),
  light: Object.freeze({
    id: "base-q5_1",
    name: "ggml-base-q5_1.bin",
    url:
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-base-q5_1.bin`,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    size: 59_707_625
  }),
  auto: Object.freeze({
    id: "small-q5_1",
    name: "ggml-small-q5_1.bin",
    url:
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-small-q5_1.bin`,
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    size: 190_085_487
  }),
  quality: Object.freeze({
    id: "medium-q5_0",
    name: "ggml-medium-q5_0.bin",
    url:
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-medium-q5_0.bin`,
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    size: 539_212_467
  })
});

export const PINNED_VAD_MODEL = Object.freeze({
  id: "silero-v6.2.0",
  name: "ggml-silero-v6.2.0.bin",
  url:
    `https://huggingface.co/ggml-org/whisper-vad/resolve/${WHISPER_VAD_REVISION}/ggml-silero-v6.2.0.bin`,
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  size: 885_098
});

const PROFILE_NAMES = Object.freeze(["draft", "auto", "light", "quality"]);
const BACKEND_NAMES = Object.freeze(["auto", "cpu", "cuda"]);
const SIX_GIB = 6 * 1024 ** 3;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function supportedNodeVersion(
  version,
  minimum = MINIMUM_NODE_VERSION
) {
  const parse = (value) => String(value || "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  const actual = parse(version);
  const required = parse(minimum);
  if (
    actual.length < 2
    || required.length < 2
    || [...actual, ...required].some((part) => !Number.isInteger(part))
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] || 0;
    const requiredPart = required[index] || 0;
    if (actualPart !== requiredPart) {
      return actualPart > requiredPart;
    }
  }
  return true;
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function requiredAbsolutePath(value, label) {
  const raw = String(value || "");
  if (!raw || !path.isAbsolute(raw)) {
    throw new TypeError(`${label} 경로가 절대 경로가 아닙니다.`);
  }
  return path.normalize(raw);
}

export function parseLocalCaptionStackArgs(argv = []) {
  const values = [...argv].map((value) => String(value));
  const command = values.shift() || "help";
  const options = {
    profile: "draft",
    backend: "auto",
    foreground: false,
    dryRun: false,
    json: false
  };
  const takeValue = (flag, inlineValue) => {
    const value = inlineValue ?? values.shift();
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${flag} 값이 필요합니다.`);
    }
    return value;
  };

  while (values.length > 0) {
    const raw = values.shift();
    const [flag, inlineValue] = raw.split("=", 2);
    if (/api[-_]?key|token|secret/iu.test(flag)) {
      throw new TypeError(
        "API 키는 지원하지 않고 연결 토큰은 로컬 companion이 자동 발급되므로 명령행 인자로 받을 수 없습니다."
      );
    }
    if (flag === "--profile") {
      options.profile = takeValue(flag, inlineValue);
      continue;
    }
    if (flag === "--backend") {
      options.backend = takeValue(flag, inlineValue);
      continue;
    }
    if (flag === "--foreground" || flag === "--no-systemd") {
      options.foreground = true;
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
    throw new TypeError(`알 수 없는 옵션입니다: ${raw}`);
  }

  if (!PROFILE_NAMES.includes(options.profile)) {
    throw new TypeError(
      `profile은 ${PROFILE_NAMES.join(", ")} 중 하나여야 합니다.`
    );
  }
  if (!BACKEND_NAMES.includes(options.backend)) {
    throw new TypeError(
      `backend는 ${BACKEND_NAMES.join(", ")} 중 하나여야 합니다.`
    );
  }
  return { command, options };
}

export function resolveStackPaths({
  env = {},
  homeDir,
  repoRoot
} = {}) {
  const resolvedHome = requiredAbsolutePath(homeDir, "홈");
  const resolvedRepo = requiredAbsolutePath(repoRoot, "레포지토리");
  const dataBase = env.XDG_DATA_HOME
    ? requiredAbsolutePath(env.XDG_DATA_HOME, "XDG_DATA_HOME")
    : path.join(resolvedHome, ".local", "share");
  const configBase = env.XDG_CONFIG_HOME
    ? requiredAbsolutePath(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME")
    : path.join(resolvedHome, ".config");
  const stateBase = env.XDG_STATE_HOME
    ? requiredAbsolutePath(env.XDG_STATE_HOME, "XDG_STATE_HOME")
    : path.join(resolvedHome, ".local", "state");
  const runtimeBase = env.XDG_RUNTIME_DIR
    ? requiredAbsolutePath(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR")
    : path.join(stateBase, "run");
  const dataRoot = path.join(dataBase, "kirinuki-caption-stack");
  const configRoot = path.join(configBase, "kirinuki-caption-stack");
  const stateRoot = path.join(stateBase, "kirinuki-caption-stack");
  const runtimeRoot = path.join(runtimeBase, "kirinuki-caption-stack");
  return Object.freeze({
    repoRoot: resolvedRepo,
    extensionRoot: path.join(resolvedRepo, "extension"),
    dataRoot,
    configRoot,
    stateRoot,
    runtimeRoot,
    downloadsRoot: path.join(dataRoot, "downloads"),
    sourcesRoot: path.join(dataRoot, "sources"),
    buildsRoot: path.join(dataRoot, "builds"),
    modelsRoot: path.join(dataRoot, "models"),
    runtimeNoticesPath: path.join(dataRoot, "THIRD_PARTY_NOTICES.md"),
    configPath: path.join(configRoot, "config.json"),
    unitPath: path.join(
      configBase,
      "systemd",
      "user",
      LOCAL_CAPTION_STACK_SERVICE
    ),
    pidPath: path.join(runtimeRoot, "stack.pid")
  });
}

export function detectBackend(hardware = {}, preference = "auto") {
  if (!BACKEND_NAMES.includes(preference)) {
    throw new TypeError(`지원하지 않는 backend입니다: ${preference}`);
  }
  const cudaReady = Boolean(
    hardware.platform === "linux"
    && hardware.nvidiaDetected
    && hardware.nvccAvailable
  );
  if (preference === "cuda" && !cudaReady) {
    throw new Error(
      "CUDA backend를 요청했지만 NVIDIA GPU와 CUDA compiler를 함께 찾지 못했습니다."
    );
  }
  if (preference === "cpu") {
    return "cpu";
  }
  return cudaReady ? "cuda" : "cpu";
}

export function resolveSemanticProfile(
  requestedProfile = "draft",
  hardware = {},
  backendPreference = "auto"
) {
  if (!PROFILE_NAMES.includes(requestedProfile)) {
    throw new TypeError(`지원하지 않는 profile입니다: ${requestedProfile}`);
  }
  const cpuCount = positiveInteger(hardware.cpuCount, 2);
  const memoryBytes = positiveInteger(hardware.totalMemoryBytes, SIX_GIB);
  const effectiveProfile = (
    requestedProfile === "auto" && memoryBytes < SIX_GIB
  )
    ? "light"
    : requestedProfile;
  const backend = detectBackend(hardware, backendPreference);
  const threadTargets = {
    draft: bounded(Math.floor(cpuCount / 2), 2, 4),
    light: bounded(Math.floor(cpuCount / 2), 2, 4),
    auto: bounded(Math.floor(cpuCount * 0.75), 2, 8),
    quality: bounded(cpuCount - 1, 4, 12)
  };
  const threads = backend === "cuda"
    ? Math.min(4, threadTargets[effectiveProfile])
    : threadTargets[effectiveProfile];
  return Object.freeze({
    requestedProfile,
    effectiveProfile,
    backendPreference,
    backend,
    model: PINNED_MODELS[effectiveProfile],
    vadModel: PINNED_VAD_MODEL,
    threads,
    buildJobs: bounded(cpuCount - 1, 1, 8),
    semantics: Object.freeze({
      language: "ko",
      timestamps: "segment+word",
      vad: true,
      maxSpeechSeconds: effectiveProfile === "quality" ? 30 : 25
    })
  });
}

export function chromiumExtensionIdForPath(extensionPath) {
  const normalized = requiredAbsolutePath(extensionPath, "확장 프로그램");
  const digest = createHash("sha256").update(normalized).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => (
      String.fromCharCode(97 + (byte >> 4))
      + String.fromCharCode(97 + (byte & 0x0f))
    ))
    .join("");
}

export function extensionOriginForPath(extensionPath) {
  return `chrome-extension://${chromiumExtensionIdForPath(extensionPath)}`;
}

export function createInstallConfig(paths, semanticProfile, {
  sttPort = DEFAULT_STT_PORT,
  gatewayPort = DEFAULT_GATEWAY_PORT
} = {}) {
  const binaryName = process.platform === "win32"
    ? "whisper-server.exe"
    : "whisper-server";
  const buildRoot = path.join(
    paths.buildsRoot,
    `${PINNED_WHISPER_CPP.commit}-${semanticProfile.backend}`
  );
  return Object.freeze({
    schema: LOCAL_CAPTION_STACK_SCHEMA,
    installedAt: new Date().toISOString(),
    profile: semanticProfile.requestedProfile,
    effectiveProfile: semanticProfile.effectiveProfile,
    backendPreference: semanticProfile.backendPreference,
    backend: semanticProfile.backend,
    threads: semanticProfile.threads,
    buildJobs: semanticProfile.buildJobs,
    host: LOOPBACK_HOST,
    sttPort,
    gatewayPort,
    origin: extensionOriginForPath(paths.extensionRoot),
    whisper: Object.freeze({
      version: PINNED_WHISPER_CPP.version,
      commit: PINNED_WHISPER_CPP.commit,
      sourceDir: path.join(
        paths.sourcesRoot,
        `whisper.cpp-${PINNED_WHISPER_CPP.commit}`
      ),
      buildRoot,
      binaryPath: path.join(buildRoot, "bin", binaryName)
    }),
    model: Object.freeze({
      id: semanticProfile.model.id,
      path: path.join(paths.modelsRoot, semanticProfile.model.name),
      sha256: semanticProfile.model.sha256,
      size: semanticProfile.model.size
    }),
    vad: Object.freeze({
      id: semanticProfile.vadModel.id,
      path: path.join(paths.modelsRoot, semanticProfile.vadModel.name),
      sha256: semanticProfile.vadModel.sha256,
      size: semanticProfile.vadModel.size
    }),
    semantics: semanticProfile.semantics
  });
}

export function installedProfileSummary(config) {
  if (!config) {
    return null;
  }
  return Object.freeze({
    requested: String(config.profile || ""),
    effective: String(config.effectiveProfile || ""),
    model: String(config.model?.id || ""),
    backend: String(config.backend || "")
  });
}

export function buildWhisperServerArgs(config, { requestPath } = {}) {
  if (config.host !== LOOPBACK_HOST) {
    throw new Error("로컬 STT 서버는 127.0.0.1에만 바인딩할 수 있습니다.");
  }
  const privateRequestPath = String(requestPath || "");
  if (!/^\/kirinuki-[a-f0-9]{48}$/u.test(privateRequestPath)) {
    throw new Error("로컬 STT 서버에는 매 실행 새 192-bit 비공개 요청 경로가 필요합니다.");
  }
  const args = [
    "--host", LOOPBACK_HOST,
    "--port", String(config.sttPort),
    "--request-path", privateRequestPath,
    "--model", config.model.path,
    "--language", "ko",
    "--threads", String(config.threads),
    "--processors", "1",
    "--split-on-word",
    "--vad",
    "--vad-model", config.vad.path,
    "--vad-threshold", "0.50",
    "--vad-min-speech-duration-ms", "160",
    "--vad-min-silence-duration-ms", "120",
    "--vad-max-speech-duration-s",
    String(config.semantics?.maxSpeechSeconds || 25),
    "--vad-speech-pad-ms", "80",
    "--vad-samples-overlap", "0.15"
  ];
  if (config.backend === "cpu") {
    args.push("--no-gpu");
  } else if (config.backend === "cuda") {
    args.push("--flash-attn");
  } else {
    throw new Error(`지원하지 않는 설치 backend입니다: ${config.backend}`);
  }
  return args;
}

function systemdQuote(value) {
  const escaped = String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "$$")
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

function systemdWorkingDirectory(value) {
  const absolutePath = requiredAbsolutePath(value, "레포지토리");
  if (/[\0\r\n]/u.test(absolutePath)) {
    throw new TypeError("systemd 작업 경로에 제어 문자를 사용할 수 없습니다.");
  }
  return absolutePath
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "%%");
}

export function renderSystemdUserUnit({
  nodePath,
  cliPath,
  repoRoot,
  origin
}) {
  const exactOrigin = String(origin || "");
  if (!/^chrome-extension:\/\/[a-p]{32}$/u.test(exactOrigin)) {
    throw new TypeError("systemd unit에 정확한 확장 프로그램 Origin이 필요합니다.");
  }
  const execStart = [
    systemdQuote(requiredAbsolutePath(nodePath, "Node")),
    systemdQuote(requiredAbsolutePath(cliPath, "CLI")),
    "start",
    "--foreground"
  ].join(" ");
  return [
    "[Unit]",
    "Description=Kirinuki local Whisper caption stack",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdWorkingDirectory(repoRoot)}`,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=20",
    "UMask=0077",
    "RuntimeDirectory=kirinuki-caption-stack",
    "Environment=KIRINUKI_AUTO_PAIR=1",
    "Environment=KIRINUKI_STT_MODE=local-whispercpp",
    `Environment=${systemdQuote(`KIRINUKI_ALLOWED_ORIGIN=${exactOrigin}`)}`,
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "ProtectClock=true",
    "ProtectKernelLogs=true",
    "ProtectKernelModules=true",
    "ProtectKernelTunables=true",
    "RestrictRealtime=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function systemdStartCommands() {
  return [
    { file: "systemctl", args: ["--user", "daemon-reload"] },
    {
      file: "systemctl",
      args: ["--user", "start", LOCAL_CAPTION_STACK_SERVICE]
    }
  ];
}

export function systemdRestartCommands() {
  return [
    { file: "systemctl", args: ["--user", "daemon-reload"] },
    {
      file: "systemctl",
      args: ["--user", "restart", LOCAL_CAPTION_STACK_SERVICE]
    }
  ];
}

export function systemdStopCommands() {
  return [
    {
      file: "systemctl",
      args: ["--user", "stop", LOCAL_CAPTION_STACK_SERVICE]
    }
  ];
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSha256(value, expected, label = "artifact") {
  const actual = sha256Hex(value);
  if (actual !== String(expected || "").toLowerCase()) {
    throw new Error(
      `${label} SHA-256 불일치: expected ${expected}, received ${actual}`
    );
  }
  return actual;
}

export function secretFreeConfigJson(config, secretValues = []) {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (/(?:api[_-]?key|agent[_-]?token|secret)/iu.test(serialized)) {
    throw new Error("설정 파일에 비밀 필드가 포함되었습니다.");
  }
  for (const secret of secretValues) {
    if (secret && serialized.includes(String(secret))) {
      throw new Error("설정 파일에 런타임 비밀 값이 포함되었습니다.");
    }
  }
  return serialized;
}
