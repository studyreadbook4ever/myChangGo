import { describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/capabilities.js";

describe("detectCapabilities", () => {
  it("reports injected touch, pointer, gamepad, and presentation hints", () => {
    const capabilities = detectCapabilities({
      maxTouchPoints: 5,
      deviceClass: "mobile",
      hasKeyboardEvents: true,
      hasPointerEvents: true,
      hasGamepadApi: true,
      devicePixelRatio: 3,
      webAudio: true,
      outputTimestamp: true,
      worker: true,
      offscreenCanvas: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      matchesMedia: (query) =>
        query === "(pointer: coarse)" ||
        query === "(prefers-reduced-motion: reduce)",
    });

    expect(capabilities).toMatchObject({
      deviceClass: "mobile",
      inputs: {
        touch: true,
        keyboard: true,
        pointer: true,
        gamepad: true,
        pointerAccuracy: "coarse",
      },
      display: {
        prefersReducedMotion: true,
        devicePixelRatio: 3,
      },
      audio: { webAudio: true, outputTimestamp: true },
      runtime: {
        worker: true,
        offscreenCanvas: true,
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
      },
    });
  });
});
