import { createPresetConfig } from "@relayplay/core";

export const LIVE_RACE_MAX_PLAYERS = 4;
export const LIVE_RACE_MINIMUM_PLAYERS_TO_START = 2;
export const LIVE_RACE_MAX_OPPONENTS = LIVE_RACE_MAX_PLAYERS - 1;
export const LIVE_RACE_FINISH_SCORE = 100;
export const LIVE_RACE_MAX_RESULT_ELAPSED_MS = 60 * 60 * 1_000;

export const FREEZE_DURATION_MS = 1_250;
export const FREEZE_COOLDOWN_MS = 8_000;
export const FREEZE_EFFECT_LEAD_MS = 750;
export const FREEZE_MIN_DURATION_MS = 500;
export const FREEZE_MAX_DURATION_MS = 2_000;
export const LATE_BOUNDARY_MS = 250;

/**
 * Public match configuration shared by the browser and room worker. Provider
 * credentials and bindings deliberately remain outside this module.
 */
export const LIVE_RACE_CONFIG = createPresetConfig("soft-battle", "universal", {
  room: { maxPlayers: LIVE_RACE_MAX_PLAYERS },
  progress: { intervalMs: 1_000 },
  features: {
    // Canonical per-round placement stays visible; persistent ranking is opt-in.
    ranking: { enabled: false },
    verification: {
      interactionClaims: true,
      // The example validates finish policy but does not claim replay verification.
      finalResults: false,
    },
  },
  security: {
    rateLimits: {
      actions: {
        freeze: { capacity: 1, refillPerSecond: 0.125 },
      },
    },
  },
});
