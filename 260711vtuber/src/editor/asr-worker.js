import { env, pipeline } from "@huggingface/transformers";
import {
  detectSpeechRanges,
  mergeTranscriptChunks,
  normalizeTranscriptChunks
} from "./asr-core.js";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/", self.location.href).href;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, self.navigator.hardwareConcurrency || 2));

let activeModel = null;
let transcriber = null;
let workQueue = Promise.resolve();
const modelProgressState = new Map();

const MODELS = Object.freeze({
  "Xenova/whisper-tiny": {
    revision: "5332fcc35e32a33b86612b9a57a89be7906102b1"
  },
  "Xenova/whisper-small": {
    revision: "2d67713f236afa48a18992566e7647f6ca848e13"
  }
});

function emit(message) {
  self.postMessage(message);
}

function modelProgress(jobId, event) {
  const progress = Number.isFinite(event?.progress) ? event.progress / 100 : 0;
  const status = event?.status || "loading";
  const label = status === "progress"
    ? `${event.file || "모델"} 받는 중`
    : status === "ready"
      ? "모델 준비 완료"
      : "음성인식 모델 준비 중";
  const value = status === "ready"
    ? 0.44
    : Math.min(0.42, Math.max(0.02, progress * 0.42));
  const previous = modelProgressState.get(jobId) || {
    value: 0,
    emittedValue: -1,
    emittedAt: 0
  };
  const monotonic = Math.max(previous.value, value);
  const currentTime = Date.now();
  const shouldEmit = (
    status === "ready" ||
    monotonic - previous.emittedValue >= 0.01 ||
    currentTime - previous.emittedAt >= 500
  );
  modelProgressState.set(jobId, {
    value: monotonic,
    emittedValue: shouldEmit ? monotonic : previous.emittedValue,
    emittedAt: shouldEmit ? currentTime : previous.emittedAt
  });
  if (!shouldEmit) {
    return;
  }
  emit({
    type: "progress",
    jobId,
    stage: "model",
    progress: monotonic,
    label
  });
}

async function getTranscriber(model, jobId) {
  const config = MODELS[model];
  if (!config) {
    throw new Error("허용되지 않은 음성인식 모델입니다.");
  }
  if (transcriber && activeModel === model) {
    modelProgressState.set(jobId, {
      value: 0.44,
      emittedValue: 0.44,
      emittedAt: Date.now()
    });
    emit({
      type: "progress",
      jobId,
      stage: "model",
      progress: 0.44,
      label: "캐시된 모델 준비 완료"
    });
    return transcriber;
  }
  if (transcriber?.dispose) {
    await transcriber.dispose().catch(() => {});
  }
  transcriber = null;
  activeModel = null;
  const nextTranscriber = await pipeline("automatic-speech-recognition", model, {
    device: "wasm",
    dtype: "q8",
    revision: config.revision,
    progress_callback: (event) => modelProgress(jobId, event)
  });
  transcriber = nextTranscriber;
  activeModel = model;
  return transcriber;
}

async function handleMessage(message) {
  if (message.type === "dispose") {
    if (transcriber?.dispose) {
      await transcriber.dispose().catch(() => {});
    }
    transcriber = null;
    activeModel = null;
    emit({ type: "disposed" });
    return;
  }
  if (message.type !== "transcribe") {
    return;
  }

  const { jobId, model, audio } = message;
  try {
    if (!(audio instanceof Float32Array) || audio.length === 0) {
      throw new Error("전사할 오디오 데이터가 비어 있습니다.");
    }
    const ranges = detectSpeechRanges(audio);
    if (ranges.length === 0) {
      emit({
        type: "result",
        jobId,
        text: "",
        chunks: [],
        speechDetected: false
      });
      return;
    }
    const pipe = await getTranscriber(model, jobId);
    emit({
      type: "progress",
      jobId,
      stage: "inference",
      progress: 0.48,
      label: "한국어 음성을 받아쓰는 중"
    });
    const groups = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const segment = audio.subarray(range.startSample, range.endSample);
      const durationSeconds = segment.length / 16_000;
      emit({
        type: "progress",
        jobId,
        stage: "inference",
        progress: 0.48 + (index / ranges.length) * 0.48,
        label: ranges.length === 1
          ? "한국어 음성을 받아쓰는 중"
          : `음성 구간 ${index + 1}/${ranges.length} 받아쓰는 중`
      });
      const result = await pipe(segment, {
        language: "korean",
        task: "transcribe",
        return_timestamps: "word",
        chunk_length_s: 30,
        stride_length_s: 3,
        no_repeat_ngram_size: 3,
        repetition_penalty: 1.12,
        max_new_tokens: Math.min(256, Math.max(32, Math.ceil(durationSeconds * 10)))
      });
      groups.push(normalizeTranscriptChunks(result?.chunks, {
        offsetSeconds: range.startSeconds,
        durationSeconds
      }));
    }
    const chunks = mergeTranscriptChunks(groups);
    emit({
      type: "result",
      jobId,
      text: chunks.map((chunk) => chunk.text).join(" ").trim(),
      chunks,
      speechDetected: true
    });
  } catch (error) {
    emit({
      type: "error",
      jobId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    modelProgressState.delete(jobId);
  }
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  workQueue = workQueue
    .then(() => handleMessage(message))
    .catch((error) => {
      emit({
        type: "error",
        jobId: message.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
});
