import { describe, expect, it } from "vitest";

import { createPresetConfig } from "../src/presets.js";
import {
  checkPlatformCompatibility,
  getAdaptivePresentationHints,
  getAvailableInputClasses,
  parsePlatformCapabilities,
  safeParsePlatformCapabilities,
  type PlatformCapabilities,
} from "../src/platform.js";

const mobileCapabilities: PlatformCapabilities = {
  deviceClass: "mobile",
  inputs: {
    touch: true,
    keyboard: false,
    pointer: true,
    gamepad: false,
    maxTouchPoints: 5,
    pointerAccuracy: "coarse",
  },
  display: {
    devicePixelRatio: 3,
    prefersReducedMotion: true,
    refreshRateHz: 60,
  },
  audio: {
    webAudio: true,
    outputTimestamp: true,
    sampleRate: 48_000,
  },
  runtime: {
    worker: true,
    offscreenCanvas: true,
    sharedArrayBuffer: false,
    crossOriginIsolated: false,
  },
};

describe("platform capabilities", () => {
  it("strictly parses a capability report", () => {
    expect(parsePlatformCapabilities(mobileCapabilities)).toEqual(mobileCapabilities);
    expect(getAvailableInputClasses(mobileCapabilities)).toEqual(["touch", "pointer"]);
  });

  it("rejects unknown fields and impossible SharedArrayBuffer claims", () => {
    const result = safeParsePlatformCapabilities({
      ...mobileCapabilities,
      surprise: true,
      runtime: {
        ...mobileCapabilities.runtime,
        sharedArrayBuffer: true,
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["$.surprise", "$.runtime.sharedArrayBuffer"]),
      );
    }
  });

  it("matches actual inputs against the configured platform policy", () => {
    const mobile = createPresetConfig("live-race", "mobile-first").platform;
    const desktop = createPresetConfig("live-race", "desktop-first").platform;

    expect(checkPlatformCompatibility(mobileCapabilities, mobile).compatible).toBe(true);
    expect(checkPlatformCompatibility(mobileCapabilities, desktop).compatible).toBe(true);

    const noPointerOrKeyboard = {
      ...mobileCapabilities,
      inputs: {
        ...mobileCapabilities.inputs,
        touch: false,
        pointer: false,
      },
    } satisfies PlatformCapabilities;
    expect(checkPlatformCompatibility(noPointerOrKeyboard, desktop).compatible).toBe(false);
  });

  it("caps DPR and honors reduced motion without changing game rules", () => {
    const config = createPresetConfig("rhythm-race", "mobile-first").platform;
    expect(getAdaptivePresentationHints(mobileCapabilities, config)).toEqual({
      devicePixelRatio: 2,
      reduceMotion: true,
      quality: "low",
      useOffscreenCanvas: true,
    });
  });
});
