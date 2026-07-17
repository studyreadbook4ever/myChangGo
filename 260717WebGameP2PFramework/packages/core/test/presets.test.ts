import { describe, expect, it } from "vitest";

import {
  createPresetConfig,
  fallingBlockBattlePreset,
  GAME_PRESETS,
  mobileFirstPlatformPreset,
  PLATFORM_PRESETS,
} from "../src/presets.js";

describe("configuration presets", () => {
  it("keeps the basic live race at the documented 1000 ms cadence", () => {
    const config = createPresetConfig("live-race");
    expect(config.progress.intervalMs).toBe(1_000);
    expect(config.features.interactions).toEqual({
      enabled: false,
      targeted: false,
      scheduled: false,
    });
  });

  it("selects deterministic timing and evidence for falling-block battles", () => {
    const config = createPresetConfig("falling-block-battle", "desktop-first");
    expect(config.time.clockMode).toBe("fixed-tick");
    expect(config.time.tickRateHz).toBe(60);
    expect(config.features.evidence).toEqual({
      replayChunks: true,
      stateHashes: true,
    });
    expect(config.platform.target).toBe("desktop-first");
    expect(config.platform.inputs.keyboard).toBe(true);
    expect(config.platform.inputs.touch).toBe(false);
  });

  it("selects audio time and strict late-event dropping for rhythm races", () => {
    const config = createPresetConfig("rhythm-race", "mobile-first");
    expect(config.time.clockMode).toBe("audio");
    expect(config.time.lateEventPolicy).toBe("drop");
    expect(config.time.startLeadMs).toBe(5_000);
    expect(config.platform.inputs.touch).toBe(true);
  });

  it("applies explicit overrides after both presets", () => {
    const config = createPresetConfig("soft-battle", "universal", {
      room: { maxPlayers: 4 },
      progress: { intervalMs: 750 },
    });
    expect(config.room.maxPlayers).toBe(4);
    expect(config.progress.intervalMs).toBe(750);
    expect(config.features.interactions.scheduled).toBe(true);
  });

  it("exports frozen preset registries and nested preset values", () => {
    expect(Object.isFrozen(GAME_PRESETS)).toBe(true);
    expect(Object.isFrozen(PLATFORM_PRESETS)).toBe(true);
    expect(Object.isFrozen(fallingBlockBattlePreset.features)).toBe(true);
    expect(Object.isFrozen(mobileFirstPlatformPreset.platform?.inputs)).toBe(true);
  });
});
