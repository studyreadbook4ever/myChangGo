import {
  mergeConfig,
  type RelayPlayConfig,
  type RelayPlayConfigInput,
} from "./config.js";

export type GamePresetName =
  | "live-race"
  | "soft-battle"
  | "falling-block-battle"
  | "rhythm-race";

export type PlatformPresetName = "universal" | "mobile-first" | "desktop-first";

function freezePreset<T extends RelayPlayConfigInput>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      freezePreset(child as RelayPlayConfigInput);
    }
  }
  return value;
}

export const liveRacePreset = freezePreset({
  room: {
    maxPlayers: 16,
  },
  features: {
    interactions: {
      enabled: false,
      targeted: false,
      scheduled: false,
    },
  },
  progress: {
    intervalMs: 1_000,
    broadcast: true,
  },
  time: {
    clockMode: "monotonic",
    startLeadMs: 3_000,
    lateEventPolicy: "apply-immediately",
  },
} satisfies RelayPlayConfigInput);

export const softBattlePreset = freezePreset({
  room: {
    maxPlayers: 8,
  },
  features: {
    interactions: {
      enabled: true,
      targeted: true,
      scheduled: true,
    },
    verification: {
      interactionClaims: true,
    },
  },
  progress: {
    intervalMs: 500,
  },
  time: {
    clockMode: "monotonic",
    interactionLeadMs: 250,
    lateEventPolicy: "next-boundary",
  },
  security: {
    rateLimits: {
      actions: {
        interaction: { capacity: 6, refillPerSecond: 3 },
      },
    },
  },
} satisfies RelayPlayConfigInput);

export const fallingBlockBattlePreset = freezePreset({
  room: {
    maxPlayers: 8,
  },
  features: {
    interactions: {
      enabled: true,
      targeted: true,
      scheduled: true,
    },
    evidence: {
      replayChunks: true,
      stateHashes: true,
    },
    verification: {
      interactionClaims: true,
      finalResults: true,
    },
  },
  progress: {
    intervalMs: 1_000,
  },
  time: {
    clockMode: "fixed-tick",
    tickRateHz: 60,
    startLeadMs: 3_000,
    interactionLeadMs: 100,
    lateEventPolicy: "next-boundary",
  },
} satisfies RelayPlayConfigInput);

export const rhythmRacePreset = freezePreset({
  room: {
    maxPlayers: 16,
  },
  features: {
    interactions: {
      enabled: false,
      targeted: false,
      scheduled: false,
    },
    evidence: {
      replayChunks: true,
      stateHashes: true,
    },
    verification: {
      finalResults: true,
    },
  },
  progress: {
    intervalMs: 500,
  },
  time: {
    clockMode: "audio",
    startLeadMs: 5_000,
    audioLookAheadMs: 150,
    lateEventPolicy: "drop",
  },
} satisfies RelayPlayConfigInput);

export const universalPlatformPreset = freezePreset({
  platform: {
    target: "universal",
    inputs: {
      touch: true,
      keyboard: true,
      pointer: true,
      gamepad: true,
    },
    crossPlay: {
      enabled: true,
      rankedPool: "same-input-preferred",
      allowInputSwitch: false,
    },
  },
} satisfies RelayPlayConfigInput);

export const mobileFirstPlatformPreset = freezePreset({
  platform: {
    target: "mobile-first",
    inputs: {
      touch: true,
      keyboard: false,
      pointer: true,
      gamepad: false,
    },
    crossPlay: {
      enabled: true,
      rankedPool: "unified",
      allowInputSwitch: false,
    },
    presentation: {
      adaptiveQuality: true,
      maxDevicePixelRatio: 2,
      preferReducedMotion: true,
    },
  },
} satisfies RelayPlayConfigInput);

export const desktopFirstPlatformPreset = freezePreset({
  platform: {
    target: "desktop-first",
    inputs: {
      touch: false,
      keyboard: true,
      pointer: true,
      gamepad: true,
    },
    crossPlay: {
      enabled: true,
      rankedPool: "same-input-preferred",
      allowInputSwitch: false,
    },
    presentation: {
      adaptiveQuality: true,
      maxDevicePixelRatio: 3,
      preferReducedMotion: true,
    },
  },
} satisfies RelayPlayConfigInput);

export const GAME_PRESETS: Readonly<Record<GamePresetName, RelayPlayConfigInput>> =
  Object.freeze({
    "live-race": liveRacePreset,
    "soft-battle": softBattlePreset,
    "falling-block-battle": fallingBlockBattlePreset,
    "rhythm-race": rhythmRacePreset,
  });

export const PLATFORM_PRESETS: Readonly<
  Record<PlatformPresetName, RelayPlayConfigInput>
> = Object.freeze({
  universal: universalPlatformPreset,
  "mobile-first": mobileFirstPlatformPreset,
  "desktop-first": desktopFirstPlatformPreset,
});

export function createPresetConfig(
  game: GamePresetName,
  platform: PlatformPresetName = "universal",
  overrides: RelayPlayConfigInput = {},
): RelayPlayConfig {
  return mergeConfig(GAME_PRESETS[game], PLATFORM_PRESETS[platform], overrides);
}
