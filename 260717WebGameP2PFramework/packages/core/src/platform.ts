import type { PlatformConfig } from "./config.js";
import { CapabilityValidationError } from "./errors.js";
import {
  findUnknownKeys,
  hasOwn,
  isPlainObject,
  issue,
  validationFailure,
  validationSuccess,
  type ValidationIssue,
  type ValidationResult,
} from "./validation.js";

export type InputClass = "touch" | "keyboard" | "pointer" | "gamepad";
export type DeviceClass = "mobile" | "desktop" | "tablet" | "unknown";

export interface PlatformCapabilities {
  readonly deviceClass: DeviceClass;
  readonly inputs: {
    readonly touch: boolean;
    readonly keyboard: boolean;
    readonly pointer: boolean;
    readonly gamepad: boolean;
    readonly maxTouchPoints?: number;
    readonly pointerAccuracy?: "coarse" | "fine" | "mixed";
  };
  readonly display: {
    readonly devicePixelRatio: number;
    readonly prefersReducedMotion: boolean;
    readonly refreshRateHz?: number;
  };
  readonly audio: {
    readonly webAudio: boolean;
    readonly outputTimestamp: boolean;
    readonly sampleRate?: number;
  };
  readonly runtime: {
    readonly worker: boolean;
    readonly offscreenCanvas: boolean;
    readonly sharedArrayBuffer: boolean;
    readonly crossOriginIsolated: boolean;
  };
}

export interface PlatformCompatibility {
  readonly compatible: boolean;
  readonly availableInputs: readonly InputClass[];
  readonly reasons: readonly string[];
}

export interface AdaptivePresentationHints {
  readonly devicePixelRatio: number;
  readonly reduceMotion: boolean;
  readonly quality: "low" | "adaptive" | "high";
  readonly useOffscreenCanvas: boolean;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of findUnknownKeys(value, new Set(allowed))) {
    issues.push(issue(`${path}.${key}`, "unknown_key", "unknown capability key", value[key]));
  }
}

function requiredObject(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
  issues: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (!hasOwn(parent, key)) {
    issues.push(issue(path, "missing_key", "required object is missing", undefined));
    return undefined;
  }
  const value = parent[key];
  if (!isPlainObject(value)) {
    issues.push(issue(path, "invalid_type", "expected an object", value));
    return undefined;
  }
  unknownKeys(value, allowed, path, issues);
  return value;
}

function requiredBoolean(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  const value = parent[key];
  if (!hasOwn(parent, key)) {
    issues.push(issue(path, "missing_key", "required boolean is missing", undefined));
  } else if (typeof value !== "boolean") {
    issues.push(issue(path, "invalid_type", "expected a boolean", value));
  }
}

function numberInRange(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  required: boolean,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(parent, key)) {
    if (required) {
      issues.push(issue(path, "missing_key", "required number is missing", undefined));
    }
    return;
  }
  const value = parent[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(issue(path, "invalid_type", "expected a finite number", value));
  } else if (value < min || value > max) {
    issues.push(issue(path, "out_of_range", `expected ${min}..${max}`, value));
  }
}

export function safeParsePlatformCapabilities(
  input: unknown,
): ValidationResult<PlatformCapabilities> {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return validationFailure([
      issue("$", "invalid_type", "capabilities must be an object", input),
    ]);
  }
  unknownKeys(input, ["deviceClass", "inputs", "display", "audio", "runtime"], "$", issues);

  if (
    !hasOwn(input, "deviceClass") ||
    typeof input.deviceClass !== "string" ||
    !["mobile", "desktop", "tablet", "unknown"].includes(input.deviceClass)
  ) {
    issues.push(
      issue("$.deviceClass", "invalid_value", "invalid device class", input.deviceClass),
    );
  }

  const inputs = requiredObject(
    input,
    "inputs",
    "$.inputs",
    ["touch", "keyboard", "pointer", "gamepad", "maxTouchPoints", "pointerAccuracy"],
    issues,
  );
  if (inputs !== undefined) {
    for (const inputClass of ["touch", "keyboard", "pointer", "gamepad"] as const) {
      requiredBoolean(inputs, inputClass, `$.inputs.${inputClass}`, issues);
    }
    numberInRange(inputs, "maxTouchPoints", "$.inputs.maxTouchPoints", 0, 32, false, issues);
    if (
      hasOwn(inputs, "pointerAccuracy") &&
      (typeof inputs.pointerAccuracy !== "string" ||
        !["coarse", "fine", "mixed"].includes(inputs.pointerAccuracy))
    ) {
      issues.push(
        issue("$.inputs.pointerAccuracy", "invalid_value", "invalid pointer accuracy", inputs.pointerAccuracy),
      );
    }
  }

  const display = requiredObject(
    input,
    "display",
    "$.display",
    ["devicePixelRatio", "prefersReducedMotion", "refreshRateHz"],
    issues,
  );
  if (display !== undefined) {
    numberInRange(display, "devicePixelRatio", "$.display.devicePixelRatio", 0.5, 16, true, issues);
    requiredBoolean(display, "prefersReducedMotion", "$.display.prefersReducedMotion", issues);
    numberInRange(display, "refreshRateHz", "$.display.refreshRateHz", 1, 1_000, false, issues);
  }

  const audio = requiredObject(
    input,
    "audio",
    "$.audio",
    ["webAudio", "outputTimestamp", "sampleRate"],
    issues,
  );
  if (audio !== undefined) {
    requiredBoolean(audio, "webAudio", "$.audio.webAudio", issues);
    requiredBoolean(audio, "outputTimestamp", "$.audio.outputTimestamp", issues);
    numberInRange(audio, "sampleRate", "$.audio.sampleRate", 8_000, 384_000, false, issues);
  }

  const runtime = requiredObject(
    input,
    "runtime",
    "$.runtime",
    ["worker", "offscreenCanvas", "sharedArrayBuffer", "crossOriginIsolated"],
    issues,
  );
  if (runtime !== undefined) {
    for (const key of ["worker", "offscreenCanvas", "sharedArrayBuffer", "crossOriginIsolated"] as const) {
      requiredBoolean(runtime, key, `$.runtime.${key}`, issues);
    }
    if (
      runtime.sharedArrayBuffer === true &&
      runtime.crossOriginIsolated !== true
    ) {
      issues.push(
        issue(
          "$.runtime.sharedArrayBuffer",
          "invariant",
          "SharedArrayBuffer requires cross-origin isolation",
          true,
        ),
      );
    }
  }

  return issues.length === 0
    ? validationSuccess(input as unknown as PlatformCapabilities)
    : validationFailure(issues);
}

export function parsePlatformCapabilities(input: unknown): PlatformCapabilities {
  const result = safeParsePlatformCapabilities(input);
  if (!result.success) {
    throw new CapabilityValidationError(result.issues);
  }
  return result.data;
}

export function getAvailableInputClasses(
  capabilities: PlatformCapabilities,
): readonly InputClass[] {
  return (["touch", "keyboard", "pointer", "gamepad"] as const).filter(
    (inputClass) => capabilities.inputs[inputClass],
  );
}

export function checkPlatformCompatibility(
  capabilities: PlatformCapabilities,
  config: PlatformConfig,
): PlatformCompatibility {
  const availableInputs = getAvailableInputClasses(capabilities).filter(
    (inputClass) => config.inputs[inputClass],
  );
  const reasons: string[] = [];
  if (availableInputs.length === 0) {
    reasons.push("No enabled game input is available on this platform");
  }
  if (config.target === "mobile-first" && capabilities.deviceClass === "desktop") {
    reasons.push("Desktop is supported as cross-play fallback for a mobile-first target");
  }
  if (config.target === "desktop-first" && capabilities.deviceClass === "mobile") {
    reasons.push("Mobile is supported as cross-play fallback for a desktop-first target");
  }
  return {
    compatible: availableInputs.length > 0,
    availableInputs,
    reasons,
  };
}

export function getAdaptivePresentationHints(
  capabilities: PlatformCapabilities,
  config: PlatformConfig,
): AdaptivePresentationHints {
  const reduceMotion = config.presentation.preferReducedMotion &&
    capabilities.display.prefersReducedMotion;
  const constrained = capabilities.deviceClass === "mobile" ||
    capabilities.inputs.pointerAccuracy === "coarse";
  return {
    devicePixelRatio: Math.min(
      capabilities.display.devicePixelRatio,
      config.presentation.maxDevicePixelRatio,
    ),
    reduceMotion,
    quality: config.presentation.adaptiveQuality
      ? constrained
        ? "low"
        : "adaptive"
      : "high",
    useOffscreenCanvas:
      capabilities.runtime.worker && capabilities.runtime.offscreenCanvas,
  };
}
