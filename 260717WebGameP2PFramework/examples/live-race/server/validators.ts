import { isPlainObject } from "@relayplay/core";
import type {
  FinishValidator,
  InteractionValidator,
  ProgressValidator,
} from "@relayplay/server";

import {
  FREEZE_EFFECT_LEAD_MS,
  FREEZE_MAX_DURATION_MS,
  FREEZE_MIN_DURATION_MS,
  LIVE_RACE_FINISH_SCORE,
  LIVE_RACE_MAX_RESULT_ELAPSED_MS,
} from "../src/config.js";

const LIVE_RACE_PHASES = new Set(["lobby", "countdown", "running", "finished"]);

/** Shared Worker/Node policy for bounded, replaceable progress snapshots. */
export const validateLiveRaceProgress: ProgressValidator = (command) => {
  if (!isPlainObject(command.payload)) {
    return { accepted: false, message: "progress payload must be an object" };
  }
  const { score, normalizedProgress, combo, phase } = command.payload;
  if (
    typeof score !== "number" ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    score > LIVE_RACE_FINISH_SCORE ||
    typeof normalizedProgress !== "number" ||
    !Number.isFinite(normalizedProgress) ||
    normalizedProgress !== score / LIVE_RACE_FINISH_SCORE ||
    typeof combo !== "number" ||
    !Number.isSafeInteger(combo) ||
    combo < 0 ||
    combo > LIVE_RACE_FINISH_SCORE ||
    typeof phase !== "string" ||
    !LIVE_RACE_PHASES.has(phase) ||
    (phase === "finished") !== (score === LIVE_RACE_FINISH_SCORE)
  ) {
    return { accepted: false, message: "progress payload is inconsistent or out of range" };
  }
  return {
    accepted: true,
    payload: { score, normalizedProgress, combo, phase },
  };
};

/** Shared Worker/Node policy for the example's occasional freeze interaction. */
export const validateLiveRaceInteraction: InteractionValidator = (command, context) => {
  if (command.action !== "freeze") {
    return { accepted: false, code: "UNKNOWN_ACTION", message: "unsupported action" };
  }
  if (context.target === undefined) {
    return { accepted: false, code: "TARGET_REQUIRED", message: "freeze needs a target" };
  }
  if (!isPlainObject(command.payload)) {
    return {
      accepted: false,
      code: "INVALID_PAYLOAD",
      message: "freeze payload must be an object",
    };
  }
  const durationMs = command.payload.durationMs;
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < FREEZE_MIN_DURATION_MS ||
    durationMs > FREEZE_MAX_DURATION_MS
  ) {
    return {
      accepted: false,
      code: "INVALID_DURATION",
      message: `freeze duration must be an integer from ${String(FREEZE_MIN_DURATION_MS)} to ${String(FREEZE_MAX_DURATION_MS)} ms`,
    };
  }
  return {
    accepted: true,
    payload: { durationMs },
    effectiveAt: {
      kind: "server-time",
      serverTimeMs: context.now + FREEZE_EFFECT_LEAD_MS,
    },
  };
};

/**
 * Accepts only a completed example result. Client elapsed time is range-checked
 * but discarded; RoomEngine supplies canonical elapsedMs and placement.
 */
export const validateLiveRaceFinish: FinishValidator = (command) => {
  if (!isPlainObject(command.payload)) {
    return {
      accepted: false,
      code: "INVALID_RESULT",
      message: "finish result must be an object",
    };
  }
  const { score, elapsedMs } = command.payload;
  if (
    score !== LIVE_RACE_FINISH_SCORE ||
    typeof elapsedMs !== "number" ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > LIVE_RACE_MAX_RESULT_ELAPSED_MS
  ) {
    return {
      accepted: false,
      code: "INVALID_RESULT",
      message: "finish result is incomplete or out of range",
    };
  }
  return { accepted: true, payload: { score: LIVE_RACE_FINISH_SCORE } };
};
