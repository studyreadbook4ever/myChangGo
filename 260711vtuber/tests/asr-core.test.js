import assert from "node:assert/strict";
import test from "node:test";

import {
  detectSpeechRanges,
  mergeTranscriptChunks,
  normalizeTranscriptChunks
} from "../src/editor/asr-core.js";

test("디지털 무음은 Whisper에 보내지 않는다", () => {
  const audio = new Float32Array(16_000 * 3);
  assert.deepEqual(detectSpeechRanges(audio), []);
});

test("발화처럼 에너지가 있는 부분만 여유 구간과 함께 찾는다", () => {
  const sampleRate = 16_000;
  const audio = new Float32Array(sampleRate * 2);
  for (let index = sampleRate / 2; index < sampleRate; index += 1) {
    audio[index] = Math.sin(index / 8) * 0.08;
  }
  const ranges = detectSpeechRanges(audio);
  assert.equal(ranges.length, 1);
  assert.ok(ranges[0].startSeconds < 0.5);
  assert.ok(ranges[0].endSeconds > 1);
  assert.ok(ranges[0].startSample >= 0);
  assert.ok(ranges[0].endSample <= audio.length);
});

test("긴 활성 오디오는 메모리와 반복 생성을 제한하도록 28초 이하로 나눈다", () => {
  const sampleRate = 16_000;
  const audio = new Float32Array(sampleRate * 60);
  audio.fill(0.02);
  const ranges = detectSpeechRanges(audio);
  assert.equal(ranges.length, 3);
  assert.ok(ranges.every((range) => range.endSeconds - range.startSeconds <= 28.001));
  assert.equal(ranges[0].startSample, 0);
  assert.equal(ranges.at(-1).endSample, audio.length);
});

test("0초짜리·같은 시각 반복 전사를 버리고 원본 클립 오프셋을 더한다", () => {
  const chunks = normalizeTranscriptChunks([
    { text: "안녕", timestamp: [0.2, 0.8] },
    { text: " 안녕 ", timestamp: [0.2, 0.8] },
    { text: "버림", timestamp: [1.1, 1.1] },
    { text: "하세요", timestamp: [1.2, 1.8] }
  ], {
    offsetSeconds: 5,
    durationSeconds: 2
  });
  assert.deepEqual(chunks, [
    { text: "안녕", timestamp: [5.2, 5.8] },
    { text: "하세요", timestamp: [6.2, 6.8] }
  ]);
});

test("겹쳐 처리된 구간의 동일 전사만 한 번 남긴다", () => {
  const merged = mergeTranscriptChunks([
    [
      { text: "첫말", timestamp: [1, 1.5] },
      { text: "반복", timestamp: [2, 2.5] }
    ],
    [
      { text: "반복", timestamp: [2.45, 2.8] },
      { text: "끝말", timestamp: [3, 3.5] }
    ]
  ]);
  assert.deepEqual(merged.map((chunk) => chunk.text), ["첫말", "반복", "끝말"]);
});
