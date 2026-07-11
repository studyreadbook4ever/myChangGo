#!/usr/bin/env python3
"""Create a rights-safe Korean talk-show-like source video for the Codex beta run."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import edge_tts


FONT_PATH = Path("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc")
VIDEO_SIZE = "1280x720"
FRAME_RATE = 30


ITEMS = [
    {
        "id": "title",
        "kind": "card",
        "text": "키리누키 파이프라인 베타\n100% 합성 테스트 영상",
        "duration": 3.0,
        "color": "0x10251f",
    },
    {
        "id": "intro",
        "kind": "speech",
        "speaker": "진행자",
        "voice": "ko-KR-SunHiNeural",
        "text": "오늘은 키리누키 자동 편집 베타를 시작해 볼게요.",
        "duration": 4.5,
        "color": "0x12352c",
        "session": "intro",
    },
    {
        "id": "session1-question",
        "kind": "speech",
        "speaker": "검수자",
        "voice": "ko-KR-InJoonNeural",
        "text": "타임스탬프 그대로 자르는 건가요?",
        "duration": 4.5,
        "color": "0x172d45",
        "session": "semantic-cut",
    },
    {
        "id": "session1-answer",
        "kind": "speech",
        "speaker": "진행자",
        "voice": "ko-KR-SunHiNeural",
        "text": "아니요. 질문부터 답변이 끝나는 지점까지 하나의 말 세션으로 묶어요.",
        "duration": 5.5,
        "color": "0x12352c",
        "session": "semantic-cut",
    },
    {
        "id": "session1-reaction",
        "kind": "speech",
        "speaker": "검수자",
        "voice": "ko-KR-InJoonNeural",
        "text": "아하, 마지막 반응까지 있어야 문맥이 자연스럽겠네요.",
        "duration": 5.0,
        "color": "0x172d45",
        "session": "semantic-cut",
    },
    {
        "id": "topic-break",
        "kind": "card",
        "text": "다음 주제\n정책 검수",
        "duration": 2.5,
        "color": "0x2b2512",
    },
    {
        "id": "policy-intro",
        "kind": "speech",
        "speaker": "진행자",
        "voice": "ko-KR-SunHiNeural",
        "text": "두 번째는 정책 검수예요. 방송인별 공식 규정을 먼저 확인합니다.",
        "duration": 5.5,
        "color": "0x353012",
        "session": "policy-intro",
    },
    {
        "id": "session2-question",
        "kind": "speech",
        "speaker": "검수자",
        "voice": "ko-KR-InJoonNeural",
        "text": "수익과 음원은 자동 승인하면 안 되는 거죠?",
        "duration": 5.0,
        "color": "0x172d45",
        "session": "policy-gates",
    },
    {
        "id": "session2-answer",
        "kind": "speech",
        "speaker": "진행자",
        "voice": "ko-KR-SunHiNeural",
        "text": "네. 사람이 다시 확인하고, 제삼자가 나오면 그 사람 정책도 교차 확인해요.",
        "duration": 6.0,
        "color": "0x12352c",
        "session": "policy-gates",
    },
    {
        "id": "session2-conclusion",
        "kind": "speech",
        "speaker": "검수자",
        "voice": "ko-KR-InJoonNeural",
        "text": "좋아요. 그러면 비공개 검수본까지만 만들면 됩니다.",
        "duration": 5.0,
        "color": "0x172d45",
        "session": "policy-gates",
    },
    {
        "id": "outro",
        "kind": "card",
        "text": "원본 종료\n이 영상은 공개용 콘텐츠가 아닙니다",
        "duration": 3.0,
        "color": "0x24141a",
    },
]


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def escape_filter_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


async def synthesize(item: dict, output: Path) -> None:
    communicator = edge_tts.Communicate(
        text=item["text"],
        voice=item["voice"],
        rate="+8%",
        volume="+0%",
    )
    await communicator.save(str(output))


def drawtext_filter(item: dict, text_file: Path, speaker_file: Path | None) -> str:
    font = escape_filter_path(FONT_PATH)
    text = escape_filter_path(text_file)
    filters = [
        (
            f"drawtext=fontfile='{font}':textfile='{text}':fontcolor=white:fontsize=42:"
            "line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2:"
            "box=1:boxcolor=black@0.38:boxborderw=28:expansion=none"
        ),
        (
            "drawtext=fontfile='{}':text='SYNTHETIC BETA':fontcolor=0x66ffc2:fontsize=22:"
            "x=44:y=38"
        ).format(font),
    ]
    if speaker_file:
        speaker = escape_filter_path(speaker_file)
        filters.append(
            f"drawtext=fontfile='{font}':textfile='{speaker}':fontcolor=0x9fffd8:fontsize=30:"
            "x=(w-text_w)/2:y=h*0.20:expansion=none"
        )
    return ",".join(filters)


def render_card(item: dict, clip_path: Path, text_file: Path) -> None:
    duration = float(item["duration"])
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={item['color']}:s={VIDEO_SIZE}:r={FRAME_RATE}:d={duration}",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", drawtext_filter(item, text_file, None),
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart",
        str(clip_path),
    ])


def render_speech(item: dict, clip_path: Path, text_file: Path, speaker_file: Path, audio_path: Path) -> float:
    audio_duration = probe_duration(audio_path)
    duration = max(float(item["duration"]), audio_duration + 0.65)
    item["duration"] = round(duration, 3)
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={item['color']}:s={VIDEO_SIZE}:r={FRAME_RATE}:d={duration}",
        "-i", str(audio_path),
        "-vf", drawtext_filter(item, text_file, speaker_file),
        "-af", f"apad=pad_dur={duration:.3f},atrim=0:{duration:.3f}",
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart",
        str(clip_path),
    ])
    return audio_duration


async def create_video(output_video: Path, reference_json: Path, work_dir: Path) -> None:
    if not FONT_PATH.exists():
        raise FileNotFoundError(f"Korean font not found: {FONT_PATH}")

    work_dir.mkdir(parents=True, exist_ok=True)
    output_video.parent.mkdir(parents=True, exist_ok=True)
    reference_json.parent.mkdir(parents=True, exist_ok=True)

    items = [dict(item) for item in ITEMS]
    for item in items:
        text_file = work_dir / f"{item['id']}.txt"
        text_file.write_text(item["text"], encoding="utf-8")
        if item["kind"] == "speech":
            audio_path = work_dir / f"{item['id']}.mp3"
            await synthesize(item, audio_path)

    timeline = []
    clips = []
    cursor = 0.0
    for index, item in enumerate(items):
        text_file = work_dir / f"{item['id']}.txt"
        clip_path = work_dir / f"clip-{index:02d}-{item['id']}.mp4"
        audio_duration = None
        if item["kind"] == "speech":
            speaker_file = work_dir / f"{item['id']}-speaker.txt"
            speaker_file.write_text(item["speaker"], encoding="utf-8")
            audio_duration = render_speech(
                item,
                clip_path,
                text_file,
                speaker_file,
                work_dir / f"{item['id']}.mp3",
            )
        else:
            render_card(item, clip_path, text_file)

        start = round(cursor, 3)
        end = round(cursor + float(item["duration"]), 3)
        timeline.append({
            **item,
            "startSeconds": start,
            "endSeconds": end,
            "audioDurationSeconds": round(audio_duration, 3) if audio_duration is not None else None,
        })
        cursor = end
        clips.append(clip_path)

    concat_file = work_dir / "concat.txt"
    concat_file.write_text(
        "".join(f"file '{clip.resolve()}'\n" for clip in clips),
        encoding="utf-8",
    )
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", "-movflags", "+faststart", str(output_video),
    ])

    actual_duration = probe_duration(output_video)
    video_hash = hashlib.sha256(output_video.read_bytes()).hexdigest()
    by_id = {item["id"]: item for item in timeline}
    expected_sessions = [
        {
            "id": "semantic-cut",
            "startSeconds": by_id["session1-question"]["startSeconds"],
            "endSeconds": by_id["session1-reaction"]["endSeconds"],
            "itemIds": ["session1-question", "session1-answer", "session1-reaction"],
        },
        {
            "id": "policy-gates",
            "startSeconds": by_id["session2-question"]["startSeconds"],
            "endSeconds": by_id["session2-conclusion"]["endSeconds"],
            "itemIds": ["session2-question", "session2-answer", "session2-conclusion"],
        },
    ]
    reference = {
        "schema": "chzzk-kirinuki-synthetic-beta-reference/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rights": {
            "source": "Entirely synthetic test media created for this beta",
            "humanPerformers": False,
            "thirdPartyMusic": False,
            "publicDistribution": False,
        },
        "video": {
            "path": str(output_video.resolve()),
            "durationSeconds": round(actual_duration, 3),
            "sha256": video_hash,
            "resolution": VIDEO_SIZE,
            "frameRate": FRAME_RATE,
        },
        "timeline": timeline,
        "expectedSessions": expected_sessions,
    }
    reference_json.write_text(json.dumps(reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(reference["video"], ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-video", type=Path, required=True)
    parser.add_argument("--reference-json", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.work_dir.exists():
        shutil.rmtree(args.work_dir)
    asyncio.run(create_video(args.output_video, args.reference_json, args.work_dir))


if __name__ == "__main__":
    main()
