import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com"
]);

export const DEFAULT_ACQUISITION_PROFILE = "quality-first";

export const YOUTUBE_ACQUISITION_PROFILES = Object.freeze({
  "quality-first": Object.freeze({
    description: "YouTube가 제공하는 최고 영상·음성 스트림을 보존하는 아카이브 우선 모드",
    formatSelector: "bv*+ba/b",
    mergeOutputFormat: "mkv",
    postprocessorArgs: "Merger+ffmpeg_o:-c copy"
  }),
  "editor-safe": Object.freeze({
    description: "Chromium 편집 호환성을 우선하는 H.264/AAC MP4 모드",
    formatSelector:
      "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/" +
      "b[ext=mp4][vcodec^=avc1][acodec^=mp4a]",
    mergeOutputFormat: "mp4",
    postprocessorArgs: "Merger+ffmpeg_o:-c copy -movflags +faststart"
  })
});

export const FORBIDDEN_MEDIA_TRANSFORM_FLAGS = Object.freeze([
  "--recode-video",
  "--extract-audio",
  "-x"
]);

export const ACQUIRE_YOUTUBE_USAGE = `사용법:
  npm run acquire:youtube -- [옵션] <YouTube 영상 URL>

옵션:
  --profile <quality-first|editor-safe>
      quality-first (기본): 최고 영상·음성을 무재인코딩 병합합니다.
      editor-safe: 최고 H.264 MP4 영상 + AAC M4A 음성을 MP4로 병합합니다.
  --output-dir <경로>  저장 폴더. 기본값은 현재 폴더입니다.
  --help               이 도움말을 표시합니다.

환경 변수:
  YT_DLP_BINARY  yt-dlp 실행 파일 경로
  FFMPEG_BINARY  ffmpeg 실행 파일 경로`;

function parseVideoId(url) {
  if (url.hostname === "youtu.be") {
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length === 1 ? segments[0] : "";
  }

  if (!YOUTUBE_HOSTS.has(url.hostname)) {
    return "";
  }
  if (url.pathname === "/watch") {
    return url.searchParams.get("v") || "";
  }

  const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/u);
  return match?.[1] || "";
}

export function normalizeYouTubeVideoUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError("올바른 YouTube 영상 URL을 입력해 주세요.");
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || (!YOUTUBE_HOSTS.has(url.hostname) && url.hostname !== "youtu.be")
  ) {
    throw new TypeError("HTTPS YouTube 영상 URL만 사용할 수 있습니다.");
  }

  const videoId = parseVideoId(url);
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new TypeError(
      "watch, shorts, embed, live 또는 youtu.be 형식의 유효한 YouTube 영상 URL이 필요합니다."
    );
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function optionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new TypeError(`${optionName} 뒤에 값을 입력해 주세요.`);
  }
  return value;
}

export function parseAcquireYouTubeArgs(argv, { cwd = process.cwd() } = {}) {
  let profile = DEFAULT_ACQUISITION_PROFILE;
  let outputDir = cwd;
  let help = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--profile") {
      profile = optionValue(argv, index, "--profile");
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) {
      profile = argument.slice("--profile=".length);
      continue;
    }
    if (argument === "--output-dir") {
      outputDir = optionValue(argv, index, "--output-dir");
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      outputDir = argument.slice("--output-dir=".length);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new TypeError(`지원하지 않는 옵션입니다: ${argument}`);
    }
    positional.push(argument);
  }

  if (!Object.hasOwn(YOUTUBE_ACQUISITION_PROFILES, profile)) {
    throw new TypeError(
      `지원하지 않는 프로필입니다: ${profile}. quality-first 또는 editor-safe를 사용해 주세요.`
    );
  }
  if (typeof outputDir !== "string" || !outputDir.trim() || outputDir.includes("\0")) {
    throw new TypeError("올바른 저장 폴더 경로를 입력해 주세요.");
  }
  if (help) {
    return {
      help: true,
      profile,
      outputDir: path.resolve(cwd, outputDir),
      url: ""
    };
  }
  if (positional.length !== 1) {
    throw new TypeError("YouTube 영상 URL 하나만 입력해 주세요.");
  }

  return {
    help: false,
    profile,
    outputDir: path.resolve(cwd, outputDir),
    url: normalizeYouTubeVideoUrl(positional[0])
  };
}

export function assertNoMediaReencodeFlags(args) {
  for (const argument of args) {
    const flag = FORBIDDEN_MEDIA_TRANSFORM_FLAGS.find((candidate) => (
      argument === candidate || argument.startsWith(`${candidate}=`)
    ));
    if (flag) {
      throw new TypeError(`재인코딩 또는 음성 변환 옵션은 사용할 수 없습니다: ${flag}`);
    }
  }
}

export function buildYtDlpArgs({
  url,
  profile = DEFAULT_ACQUISITION_PROFILE,
  outputDir = process.cwd(),
  ffmpegLocation = "ffmpeg"
}) {
  const selectedProfile = YOUTUBE_ACQUISITION_PROFILES[profile];
  if (!selectedProfile) {
    throw new TypeError(`지원하지 않는 YouTube 획득 프로필입니다: ${profile}`);
  }
  if (
    typeof ffmpegLocation !== "string"
    || !ffmpegLocation.trim()
    || ffmpegLocation.includes("\0")
  ) {
    throw new TypeError("올바른 ffmpeg 실행 파일 경로가 필요합니다.");
  }
  const resolvedOutputDir = path.resolve(outputDir);
  const canonicalUrl = normalizeYouTubeVideoUrl(url);
  const args = [
    "--no-playlist",
    "--abort-on-error",
    "--continue",
    "--part",
    "--no-overwrites",
    "--no-post-overwrites",
    "--ffmpeg-location", ffmpegLocation,
    "--format", selectedProfile.formatSelector,
    "--merge-output-format", selectedProfile.mergeOutputFormat,
    "--postprocessor-args", selectedProfile.postprocessorArgs,
    "--paths", resolvedOutputDir,
    "--output", "%(id)s.%(ext)s",
    "--print", "after_move:filepath",
    "--",
    canonicalUrl
  ];
  assertNoMediaReencodeFlags(args);
  return args;
}

function waitForChild(child, command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, { code, signal });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(reject, new Error(`${command} 실행이 실패했습니다 (${detail}).`));
    });
  });
}

export async function runSpawnedCommand(command, args, {
  cwd = process.cwd(),
  stdio = "inherit",
  spawnImpl = spawn
} = {}) {
  const child = spawnImpl(command, args, {
    cwd,
    stdio,
    shell: false
  });
  return waitForChild(child, command);
}

export async function requireExecutable(command, {
  label,
  versionArgs,
  installHint,
  spawnImpl = spawn
}) {
  try {
    await runSpawnedCommand(command, versionArgs, {
      stdio: "ignore",
      spawnImpl
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${label} 실행 파일을 찾을 수 없습니다: ${command}\n${installHint}`
      );
    }
    throw new Error(
      `${label} 실행 상태를 확인하지 못했습니다: ${error.message}\n${installHint}`
    );
  }
}

export async function runAcquireYouTubeCli(argv = process.argv.slice(2), {
  env = process.env,
  cwd = process.cwd(),
  spawnImpl = spawn,
  stdout = process.stdout
} = {}) {
  const options = parseAcquireYouTubeArgs(argv, { cwd });
  if (options.help) {
    stdout.write(`${ACQUIRE_YOUTUBE_USAGE}\n`);
    return;
  }

  const ytDlpBinary = env.YT_DLP_BINARY?.trim() || "yt-dlp";
  const ffmpegBinary = env.FFMPEG_BINARY?.trim() || "ffmpeg";
  await requireExecutable(ytDlpBinary, {
    label: "yt-dlp",
    versionArgs: ["--version"],
    installHint:
      "공식 설치 안내: https://github.com/yt-dlp/yt-dlp/wiki/Installation\n" +
      "다른 위치에 설치했다면 YT_DLP_BINARY 환경 변수에 실행 파일 경로를 지정하세요.",
    spawnImpl
  });
  await requireExecutable(ffmpegBinary, {
    label: "ffmpeg",
    versionArgs: ["-version"],
    installHint:
      "공식 설치 안내: https://ffmpeg.org/download.html\n" +
      "다른 위치에 설치했다면 FFMPEG_BINARY 환경 변수에 실행 파일 경로를 지정하세요.",
    spawnImpl
  });

  await mkdir(options.outputDir, { recursive: true });
  const args = buildYtDlpArgs({
    ...options,
    ffmpegLocation: ffmpegBinary
  });
  await runSpawnedCommand(ytDlpBinary, args, {
    cwd,
    stdio: "inherit",
    spawnImpl
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  runAcquireYouTubeCli().catch((error) => {
    console.error(`YouTube 원본 획득 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
