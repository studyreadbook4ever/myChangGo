import type {
  DeviceClass,
  PlatformCapabilities,
} from "@relayplay/core";

export type BrowserCapabilities = PlatformCapabilities;

export interface CapabilityEnvironment {
  readonly deviceClass?: DeviceClass;
  readonly maxTouchPoints?: number;
  readonly hasTouchEvents?: boolean;
  readonly hasKeyboardEvents?: boolean;
  readonly hasPointerEvents?: boolean;
  readonly hasGamepadApi?: boolean;
  readonly devicePixelRatio?: number;
  readonly refreshRateHz?: number;
  readonly webAudio?: boolean;
  readonly outputTimestamp?: boolean;
  readonly sampleRate?: number;
  readonly worker?: boolean;
  readonly offscreenCanvas?: boolean;
  readonly sharedArrayBuffer?: boolean;
  readonly crossOriginIsolated?: boolean;
  readonly matchesMedia?: (query: string) => boolean;
}

function browserEnvironment(): CapabilityEnvironment {
  const navigator = globalThis.navigator;
  const window = globalThis.window;
  const mobile =
    navigator !== undefined &&
    "userAgentData" in navigator &&
    (navigator.userAgentData as { readonly mobile?: boolean }).mobile === true;
  return {
    ...(mobile ? { deviceClass: "mobile" as const } : {}),
    maxTouchPoints: navigator?.maxTouchPoints ?? 0,
    hasTouchEvents: window !== undefined && "ontouchstart" in window,
    hasKeyboardEvents: window !== undefined && "KeyboardEvent" in globalThis,
    hasPointerEvents: "PointerEvent" in globalThis,
    hasGamepadApi: typeof navigator?.getGamepads === "function",
    devicePixelRatio: window?.devicePixelRatio ?? 1,
    webAudio: "AudioContext" in globalThis,
    outputTimestamp:
      "AudioContext" in globalThis &&
      "getOutputTimestamp" in globalThis.AudioContext.prototype,
    worker: "Worker" in globalThis,
    offscreenCanvas: "OffscreenCanvas" in globalThis,
    sharedArrayBuffer: "SharedArrayBuffer" in globalThis,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    matchesMedia: (query) => window?.matchMedia?.(query).matches ?? false,
  };
}

/** Detects presentation/input hints; callers must not use these as auth facts. */
export function detectCapabilities(
  environment: CapabilityEnvironment = browserEnvironment(),
): BrowserCapabilities {
  const reportedTouchPoints = environment.maxTouchPoints ?? 0;
  const maxTouchPoints = Math.max(
    0,
    Math.min(
      32,
      Number.isFinite(reportedTouchPoints)
        ? Math.trunc(reportedTouchPoints)
        : 0,
    ),
  );
  const matches = environment.matchesMedia ?? (() => false);
  const devicePixelRatio = environment.devicePixelRatio ?? 1;
  const coarsePointer = matches("(pointer: coarse)");
  const finePointer = matches("(pointer: fine)");
  const pointerAccuracy = coarsePointer && finePointer
    ? "mixed"
    : coarsePointer
      ? "coarse"
      : finePointer
        ? "fine"
        : undefined;
  const deviceClass =
    environment.deviceClass ??
    (maxTouchPoints > 0 && coarsePointer ? "mobile" : "unknown");
  const refreshRateHz = environment.refreshRateHz;
  const sampleRate = environment.sampleRate;
  const validRefreshRate =
    refreshRateHz !== undefined &&
    Number.isFinite(refreshRateHz) &&
    refreshRateHz >= 1 &&
    refreshRateHz <= 1_000;
  const validSampleRate =
    sampleRate !== undefined &&
    Number.isFinite(sampleRate) &&
    sampleRate >= 8_000 &&
    sampleRate <= 384_000;
  return {
    deviceClass,
    inputs: {
      touch: maxTouchPoints > 0 || environment.hasTouchEvents === true,
      keyboard: environment.hasKeyboardEvents ?? true,
      pointer: environment.hasPointerEvents ?? false,
      gamepad: environment.hasGamepadApi ?? false,
      maxTouchPoints,
      ...(pointerAccuracy === undefined ? {} : { pointerAccuracy }),
    },
    display: {
      devicePixelRatio:
        Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
          ? Math.min(16, Math.max(0.5, devicePixelRatio))
          : 1,
      prefersReducedMotion: matches("(prefers-reduced-motion: reduce)"),
      ...(validRefreshRate ? { refreshRateHz } : {}),
    },
    audio: {
      webAudio: environment.webAudio ?? false,
      outputTimestamp: environment.outputTimestamp ?? false,
      ...(validSampleRate ? { sampleRate } : {}),
    },
    runtime: {
      worker: environment.worker ?? false,
      offscreenCanvas: environment.offscreenCanvas ?? false,
      sharedArrayBuffer:
        (environment.sharedArrayBuffer ?? false) &&
        (environment.crossOriginIsolated ?? false),
      crossOriginIsolated: environment.crossOriginIsolated ?? false,
    },
  };
}
