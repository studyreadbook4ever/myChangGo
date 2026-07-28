import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  FORBIDDEN_MEDIA_TRANSFORM_FLAGS,
  YOUTUBE_ACQUISITION_PROFILES,
  assertNoMediaReencodeFlags,
  buildYtDlpArgs,
  normalizeYouTubeVideoUrl,
  parseAcquireYouTubeArgs,
  requireExecutable,
  runSpawnedCommand
} from "../scripts/acquire-youtube.mjs";

const VIDEO_ID = "abcdefghijk";
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
}

test("지원 YouTube 영상 주소만 canonical watch URL로 정규화한다", () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=12s&list=ignored`,
    `https://youtube.com/watch?v=${VIDEO_ID}`,
    `https://m.youtube.com/shorts/${VIDEO_ID}?feature=share`,
    `https://www.youtube.com/embed/${VIDEO_ID}?autoplay=1`,
    `https://www.youtube.com/live/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?t=90`
  ]) {
    assert.equal(normalizeYouTubeVideoUrl(url), CANONICAL_URL);
  }
});

test("비 YouTube·비 HTTPS·채널/재생목록·비정상 ID 주소를 거부한다", () => {
  for (const url of [
    `http://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com.evil.test/watch?v=${VIDEO_ID}`,
    `https://user:secret@www.youtube.com/watch?v=${VIDEO_ID}`,
    "https://www.youtube.com/playlist?list=playlist",
    "https://www.youtube.com/watch?v=short",
    `https://youtu.be/${VIDEO_ID}/extra`,
    "not-a-url"
  ]) {
    assert.throws(
      () => normalizeYouTubeVideoUrl(url),
      /YouTube 영상 URL|HTTPS YouTube/u
    );
  }
});

test("CLI 인자는 quality-first 기본값과 절대 저장 경로를 만든다", () => {
  assert.deepEqual(
    parseAcquireYouTubeArgs([
      "--output-dir", "downloads",
      `https://youtu.be/${VIDEO_ID}?t=5`
    ], {
      cwd: "/workspace/project"
    }),
    {
      help: false,
      profile: "quality-first",
      outputDir: "/workspace/project/downloads",
      url: CANONICAL_URL
    }
  );
});

test("CLI는 editor-safe, 등호 옵션과 명시적 -- 구분자를 지원한다", () => {
  assert.deepEqual(
    parseAcquireYouTubeArgs([
      "--profile=editor-safe",
      "--output-dir=/media/kirinuki",
      "--",
      CANONICAL_URL
    ], {
      cwd: "/workspace"
    }),
    {
      help: false,
      profile: "editor-safe",
      outputDir: "/media/kirinuki",
      url: CANONICAL_URL
    }
  );
});

test("CLI는 알 수 없는 옵션·프로필·0개 또는 복수 URL을 거부한다", () => {
  assert.throws(
    () => parseAcquireYouTubeArgs(["--cookies", "secret.txt", CANONICAL_URL]),
    /지원하지 않는 옵션/u
  );
  assert.throws(
    () => parseAcquireYouTubeArgs(["--profile", "fast", CANONICAL_URL]),
    /지원하지 않는 프로필/u
  );
  assert.throws(
    () => parseAcquireYouTubeArgs([]),
    /URL 하나만/u
  );
  assert.throws(
    () => parseAcquireYouTubeArgs([CANONICAL_URL, CANONICAL_URL]),
    /URL 하나만/u
  );
});

test("quality-first는 최고 영상·음성과 MKV stream-copy 병합을 선택한다", () => {
  const args = buildYtDlpArgs({
    url: CANONICAL_URL,
    profile: "quality-first",
    outputDir: "/media/output",
    ffmpegLocation: "/usr/bin/ffmpeg"
  });
  assert.equal(
    args[args.indexOf("--format") + 1],
    "bv*+ba/b"
  );
  assert.equal(
    args[args.indexOf("--merge-output-format") + 1],
    "mkv"
  );
  assert.match(
    args[args.indexOf("--postprocessor-args") + 1],
    /(?:^|[: ])-c copy(?: |$)/u
  );
  assert.deepEqual(args.slice(-2), ["--", CANONICAL_URL]);
});

test("editor-safe는 최고 H.264 MP4와 AAC M4A 및 단일 MP4 폴백을 선택한다", () => {
  const args = buildYtDlpArgs({
    url: CANONICAL_URL,
    profile: "editor-safe",
    outputDir: "/media/output"
  });
  assert.equal(
    args[args.indexOf("--format") + 1],
    "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/" +
      "b[ext=mp4][vcodec^=avc1][acodec^=mp4a]"
  );
  assert.equal(
    args[args.indexOf("--merge-output-format") + 1],
    "mp4"
  );
  assert.match(
    args[args.indexOf("--postprocessor-args") + 1],
    /-movflags \+faststart/u
  );
});

test("모든 프로필은 part·무덮어쓰기·단일 영상·최종 경로 출력과 무재인코딩을 고정한다", () => {
  for (const profile of Object.keys(YOUTUBE_ACQUISITION_PROFILES)) {
    const args = buildYtDlpArgs({
      url: CANONICAL_URL,
      profile,
      outputDir: "/media/output"
    });
    for (const required of [
      "--no-playlist",
      "--abort-on-error",
      "--continue",
      "--part",
      "--no-overwrites",
      "--no-post-overwrites"
    ]) {
      assert(args.includes(required), `${profile}에 ${required}가 없습니다.`);
    }
    assert.equal(
      args[args.indexOf("--print") + 1],
      "after_move:filepath"
    );
    assert.doesNotThrow(() => assertNoMediaReencodeFlags(args));
    for (const forbidden of FORBIDDEN_MEDIA_TRANSFORM_FLAGS) {
      assert(!args.includes(forbidden), `${profile}에 ${forbidden}가 들어갔습니다.`);
    }
  }
});

test("재인코딩·음성 추출 옵션은 방어적으로 거부한다", () => {
  for (const args of [
    ["--recode-video", "mp4"],
    ["--recode-video=webm"],
    ["--extract-audio"],
    ["-x"]
  ]) {
    assert.throws(
      () => assertNoMediaReencodeFlags(args),
      /재인코딩 또는 음성 변환/u
    );
  }
});

test("URL의 셸 문자는 제거되고 yt-dlp는 인자 배열과 shell:false로 실행된다", async () => {
  const calls = [];
  const args = buildYtDlpArgs({
    url: `${CANONICAL_URL}&note=$(touch%20/tmp/should-not-exist);echo`,
    profile: "quality-first",
    outputDir: "/media/output"
  });
  await runSpawnedCommand("yt-dlp", args, {
    cwd: "/workspace",
    spawnImpl: successfulSpawn(calls)
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "yt-dlp");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.at(-1), CANONICAL_URL);
  assert(!calls[0].args.some((argument) => argument.includes("touch")));
});

test("실행 파일 누락은 공식 설치 또는 환경 변수 설정을 안내한다", async () => {
  const missingSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      child.emit(
        "error",
        Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" })
      );
    });
    return child;
  };
  await assert.rejects(
    requireExecutable("yt-dlp", {
      label: "yt-dlp",
      versionArgs: ["--version"],
      installHint: "공식 설치 안내",
      spawnImpl: missingSpawn
    }),
    /yt-dlp 실행 파일을 찾을 수 없습니다[\s\S]*공식 설치 안내/u
  );
});

test("테스트 경로 계산은 플랫폼 구분자를 유지한다", () => {
  const parsed = parseAcquireYouTubeArgs([
    "--output-dir", "downloads",
    CANONICAL_URL
  ], {
    cwd: path.resolve("workspace")
  });
  assert.equal(parsed.outputDir, path.resolve("workspace", "downloads"));
});
