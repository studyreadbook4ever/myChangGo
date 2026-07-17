import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  defineConfig,
  normalizeConfig,
  validateConfig,
} from "../src/config.js";
import { ConfigValidationError } from "../src/errors.js";

describe("RelayPlay configuration", () => {
  it("provides secure defaults and the required progress cadence", () => {
    const config = defineConfig();

    expect(config.progress.intervalMs).toBe(1_000);
    expect(config.security.peerToPeer).toBe(false);
    expect(config.security.strictMessageValidation).toBe(true);
    expect(config.security.requireIdempotencyKeys).toBe(true);
    expect(config.security.requireResumeEpoch).toBe(true);
    expect(config.time.sync.enabled).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.security.rateLimits.actions)).toBe(true);
  });

  it("deeply merges nested overrides without losing sibling defaults", () => {
    const config = normalizeConfig({
      time: { sync: { sampleCount: 9 } },
      security: {
        rateLimits: {
          actions: {
            interaction: { capacity: 3 },
            custom_action: { capacity: 2, refillPerSecond: 0.5 },
          },
        },
      },
    });

    expect(config.time.sync.sampleCount).toBe(9);
    expect(config.time.sync.resyncIntervalMs).toBe(30_000);
    expect(config.security.rateLimits.actions.interaction).toEqual({
      capacity: 3,
      refillPerSecond: 4,
    });
    expect(config.security.rateLimits.actions.custom_action).toEqual({
      capacity: 2,
      refillPerSecond: 0.5,
    });
  });

  it("rejects unknown keys, invalid ranges, and disabled security invariants", () => {
    const result = validateConfig({
      progress: { intervalMs: 99, mystery: true },
      security: { peerToPeer: true },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          "$.progress.intervalMs",
          "$.progress.mystery",
          "$.security.peerToPeer",
        ]),
      );
    }
  });

  it("rejects incomplete new per-action rate limits after normalization", () => {
    const result = validateConfig({
      security: {
        rateLimits: {
          actions: {
            custom: { capacity: 1 },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "$.security.rateLimits.actions.custom",
          code: "invariant",
        }),
      );
    }
  });

  it("rejects contradictory nested feature flags", () => {
    expect(() =>
      normalizeConfig({
        features: {
          interactions: {
            enabled: false,
          },
        },
      }),
    ).toThrow(ConfigValidationError);

    expect(() =>
      normalizeConfig({
        features: {
          reconnect: {
            enabled: false,
          },
        },
      }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a payload cap larger than the complete message cap", () => {
    expect(() =>
      normalizeConfig({
        security: {
          maxMessageBytes: 2_048,
          maxPayloadBytes: 4_096,
        },
      }),
    ).toThrow(ConfigValidationError);
  });
});
