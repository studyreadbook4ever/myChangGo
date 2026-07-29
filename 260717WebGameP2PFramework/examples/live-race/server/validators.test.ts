import { describe, expect, it } from "vitest";

import {
  validateLiveRaceFinish,
  validateLiveRaceInteraction,
  validateLiveRaceProgress,
} from "./validators.js";

describe("shared live-race server validators", () => {
  it("accepts a consistent bounded progress snapshot", async () => {
    const result = await validateLiveRaceProgress(
      {
        version: 1,
        type: "progress",
        sequence: 1,
        payload: {
          score: 25,
          normalizedProgress: 0.25,
          combo: 10,
          phase: "running",
        },
      },
      {} as Parameters<typeof validateLiveRaceProgress>[1],
    );

    expect(result).toEqual({
      accepted: true,
      payload: {
        score: 25,
        normalizedProgress: 0.25,
        combo: 10,
        phase: "running",
      },
    });
  });

  it("rejects inconsistent progress and bounds finish claims", async () => {
    const progress = await validateLiveRaceProgress(
      {
        version: 1,
        type: "progress",
        sequence: 2,
        payload: {
          score: 25,
          normalizedProgress: 0.9,
          combo: 10,
          phase: "running",
        },
      },
      {} as Parameters<typeof validateLiveRaceProgress>[1],
    );
    const finish = await validateLiveRaceFinish(
      {
        version: 1,
        type: "finish",
        idempotencyKey: "finish_example_12345678",
        payload: { score: 100, elapsedMs: 12_345 },
      },
      {} as Parameters<typeof validateLiveRaceFinish>[1],
    );

    expect(progress.accepted).toBe(false);
    expect(finish).toEqual({ accepted: true, payload: { score: 100 } });
  });

  it("assigns an accepted freeze to a future server time", async () => {
    const result = await validateLiveRaceInteraction(
      {
        version: 1,
        type: "interaction",
        idempotencyKey: "freeze_example_12345678",
        action: "freeze",
        targetPlayerId: "player_bravo",
        payload: { durationMs: 1_250 },
      },
      {
        now: 10_000,
        target: {},
      } as Parameters<typeof validateLiveRaceInteraction>[1],
    );

    expect(result).toMatchObject({
      accepted: true,
      payload: { durationMs: 1_250 },
      effectiveAt: { kind: "server-time", serverTimeMs: 10_750 },
    });
  });
});
