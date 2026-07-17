import { ConfigValidationError } from "./errors.js";
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

export type ClockMode = "monotonic" | "fixed-tick" | "audio";
export type LateEventPolicy = "apply-immediately" | "drop" | "next-boundary";
export type PlatformTarget = "universal" | "mobile-first" | "desktop-first";
export type RankedInputPool = "unified" | "same-input-preferred" | "separate";

export interface RateLimitConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface FeatureFlags {
  readonly progress: {
    readonly enabled: boolean;
  };
  readonly interactions: {
    readonly enabled: boolean;
    readonly targeted: boolean;
    readonly scheduled: boolean;
  };
  readonly reconnect: {
    readonly enabled: boolean;
    readonly replayCanonicalEvents: boolean;
  };
  readonly evidence: {
    readonly replayChunks: boolean;
    readonly stateHashes: boolean;
  };
  readonly verification: {
    readonly interactionClaims: boolean;
    readonly finalResults: boolean;
  };
}

export interface TimeConfig {
  readonly clockMode: ClockMode;
  readonly sync: {
    readonly enabled: boolean;
    readonly sampleCount: number;
    readonly resyncIntervalMs: number;
    readonly maxRttMs: number;
  };
  readonly startLeadMs: number;
  readonly interactionLeadMs: number;
  readonly lateEventPolicy: LateEventPolicy;
  readonly tickRateHz: number;
  readonly audioLookAheadMs: number;
}

export interface PlatformConfig {
  readonly target: PlatformTarget;
  readonly inputs: {
    readonly touch: boolean;
    readonly keyboard: boolean;
    readonly pointer: boolean;
    readonly gamepad: boolean;
  };
  readonly crossPlay: {
    readonly enabled: boolean;
    readonly rankedPool: RankedInputPool;
    readonly allowInputSwitch: boolean;
  };
  readonly presentation: {
    readonly adaptiveQuality: boolean;
    readonly maxDevicePixelRatio: number;
    readonly preferReducedMotion: boolean;
  };
}

export interface RelayPlayConfig {
  readonly protocolVersion: 1;
  readonly room: {
    readonly maxPlayers: number;
    readonly disconnectGraceMs: number;
    readonly eventLogCapacity: number;
  };
  readonly features: FeatureFlags;
  readonly progress: {
    readonly intervalMs: number;
    readonly broadcast: boolean;
  };
  readonly time: TimeConfig;
  readonly platform: PlatformConfig;
  readonly security: {
    readonly peerToPeer: false;
    readonly strictMessageValidation: true;
    readonly maxMessageBytes: number;
    readonly maxPayloadBytes: number;
    readonly opaqueIdentifiers: true;
    readonly requireIdempotencyKeys: true;
    readonly requireResumeEpoch: true;
    readonly auth: {
      readonly requiredInProduction: true;
    };
    readonly rateLimits: {
      readonly default: RateLimitConfig;
      readonly actions: Readonly<Record<string, RateLimitConfig>>;
    };
  };
}

type Atomic = string | number | boolean | bigint | symbol | null | undefined;
export type DeepPartial<T> = T extends Atomic
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepPartial<Item>[]
    : { readonly [Key in keyof T]?: DeepPartial<T[Key]> };

export type RelayPlayConfigInput = DeepPartial<RelayPlayConfig>;

const defaultConfigValue: RelayPlayConfig = {
  protocolVersion: 1,
  room: {
    maxPlayers: 8,
    disconnectGraceMs: 15_000,
    eventLogCapacity: 4_096,
  },
  features: {
    progress: { enabled: true },
    interactions: {
      enabled: true,
      targeted: true,
      scheduled: true,
    },
    reconnect: {
      enabled: true,
      replayCanonicalEvents: true,
    },
    evidence: {
      replayChunks: false,
      stateHashes: false,
    },
    verification: {
      interactionClaims: false,
      finalResults: false,
    },
  },
  progress: {
    intervalMs: 1_000,
    broadcast: true,
  },
  time: {
    clockMode: "monotonic",
    sync: {
      enabled: true,
      sampleCount: 5,
      resyncIntervalMs: 30_000,
      maxRttMs: 2_000,
    },
    startLeadMs: 3_000,
    interactionLeadMs: 150,
    lateEventPolicy: "next-boundary",
    tickRateHz: 60,
    audioLookAheadMs: 100,
  },
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
    presentation: {
      adaptiveQuality: true,
      maxDevicePixelRatio: 2,
      preferReducedMotion: true,
    },
  },
  security: {
    peerToPeer: false,
    strictMessageValidation: true,
    maxMessageBytes: 65_536,
    maxPayloadBytes: 8_192,
    opaqueIdentifiers: true,
    requireIdempotencyKeys: true,
    requireResumeEpoch: true,
    auth: {
      requiredInProduction: true,
    },
    rateLimits: {
      default: { capacity: 20, refillPerSecond: 10 },
      actions: {
        interaction: { capacity: 8, refillPerSecond: 4 },
        progress: { capacity: 4, refillPerSecond: 2 },
        replay_chunk: { capacity: 16, refillPerSecond: 8 },
      },
    },
  },
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const DEFAULT_CONFIG: Readonly<RelayPlayConfig> = deepFreeze(defaultConfigValue);
export const DEFAULT_RELAYPLAY_CONFIG = DEFAULT_CONFIG;

function mergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = isPlainObject(value) ? mergeObjects(value, {}) : value;
  }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(value)
      ? mergeObjects(baseValue, value)
      : value;
  }
  return result;
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of findUnknownKeys(value, allowed)) {
    issues.push(issue(`${path}.${key}`, "unknown_key", "unknown configuration key", value[key]));
  }
}

function optionalObject(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  allowedKeys: readonly string[],
  issues: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (!hasOwn(parent, key)) {
    return undefined;
  }
  const value = parent[key];
  if (!isPlainObject(value)) {
    issues.push(issue(path, "invalid_type", "expected an object", value));
    return undefined;
  }
  addUnknownKeyIssues(value, allowedKeys, path, issues);
  return value;
}

function optionalBoolean(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  requiredLiteral?: boolean,
): void {
  if (!hasOwn(parent, key)) {
    return;
  }
  const value = parent[key];
  if (typeof value !== "boolean") {
    issues.push(issue(path, "invalid_type", "expected a boolean", value));
  } else if (requiredLiteral !== undefined && value !== requiredLiteral) {
    issues.push(
      issue(path, "invariant", `must remain ${String(requiredLiteral)}`, value),
    );
  }
}

interface NumberRules {
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

function optionalNumber(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  rules: NumberRules,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(parent, key)) {
    return;
  }
  const value = parent[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(issue(path, "invalid_type", "expected a finite number", value));
    return;
  }
  if (rules.integer === true && !Number.isInteger(value)) {
    issues.push(issue(path, "invalid_value", "expected an integer", value));
  }
  if (value < rules.min || value > rules.max) {
    issues.push(
      issue(path, "out_of_range", `expected ${rules.min}..${rules.max}`, value),
    );
  }
}

function optionalEnum(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly string[],
  issues: ValidationIssue[],
): void {
  if (!hasOwn(parent, key)) {
    return;
  }
  const value = parent[key];
  if (typeof value !== "string" || !values.includes(value)) {
    issues.push(issue(path, "invalid_value", `expected one of ${values.join(", ")}`, value));
  }
}

function validateRateLimit(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  addUnknownKeyIssues(value, ["capacity", "refillPerSecond"], path, issues);
  optionalNumber(value, "capacity", `${path}.capacity`, { min: 1, max: 10_000, integer: true }, issues);
  optionalNumber(
    value,
    "refillPerSecond",
    `${path}.refillPerSecond`,
    { min: 0.001, max: 10_000 },
    issues,
  );
}

function validateConfigInputShape(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return [issue("$", "invalid_type", "configuration must be an object", input)];
  }

  addUnknownKeyIssues(
    input,
    ["protocolVersion", "room", "features", "progress", "time", "platform", "security"],
    "$",
    issues,
  );
  if (hasOwn(input, "protocolVersion") && input.protocolVersion !== 1) {
    issues.push(issue("$.protocolVersion", "invalid_value", "only protocolVersion 1 is supported", input.protocolVersion));
  }

  const room = optionalObject(
    input,
    "room",
    "$.room",
    ["maxPlayers", "disconnectGraceMs", "eventLogCapacity"],
    issues,
  );
  if (room !== undefined) {
    optionalNumber(room, "maxPlayers", "$.room.maxPlayers", { min: 1, max: 256, integer: true }, issues);
    optionalNumber(room, "disconnectGraceMs", "$.room.disconnectGraceMs", { min: 0, max: 300_000, integer: true }, issues);
    optionalNumber(room, "eventLogCapacity", "$.room.eventLogCapacity", { min: 1, max: 1_000_000, integer: true }, issues);
  }

  const features = optionalObject(
    input,
    "features",
    "$.features",
    ["progress", "interactions", "reconnect", "evidence", "verification"],
    issues,
  );
  if (features !== undefined) {
    const progressFeature = optionalObject(features, "progress", "$.features.progress", ["enabled"], issues);
    if (progressFeature !== undefined) {
      optionalBoolean(progressFeature, "enabled", "$.features.progress.enabled", issues);
    }
    const interactions = optionalObject(
      features,
      "interactions",
      "$.features.interactions",
      ["enabled", "targeted", "scheduled"],
      issues,
    );
    if (interactions !== undefined) {
      optionalBoolean(interactions, "enabled", "$.features.interactions.enabled", issues);
      optionalBoolean(interactions, "targeted", "$.features.interactions.targeted", issues);
      optionalBoolean(interactions, "scheduled", "$.features.interactions.scheduled", issues);
    }
    const reconnect = optionalObject(
      features,
      "reconnect",
      "$.features.reconnect",
      ["enabled", "replayCanonicalEvents"],
      issues,
    );
    if (reconnect !== undefined) {
      optionalBoolean(reconnect, "enabled", "$.features.reconnect.enabled", issues);
      optionalBoolean(reconnect, "replayCanonicalEvents", "$.features.reconnect.replayCanonicalEvents", issues);
    }
    const evidence = optionalObject(
      features,
      "evidence",
      "$.features.evidence",
      ["replayChunks", "stateHashes"],
      issues,
    );
    if (evidence !== undefined) {
      optionalBoolean(evidence, "replayChunks", "$.features.evidence.replayChunks", issues);
      optionalBoolean(evidence, "stateHashes", "$.features.evidence.stateHashes", issues);
    }
    const verification = optionalObject(
      features,
      "verification",
      "$.features.verification",
      ["interactionClaims", "finalResults"],
      issues,
    );
    if (verification !== undefined) {
      optionalBoolean(verification, "interactionClaims", "$.features.verification.interactionClaims", issues);
      optionalBoolean(verification, "finalResults", "$.features.verification.finalResults", issues);
    }
  }

  const progress = optionalObject(input, "progress", "$.progress", ["intervalMs", "broadcast"], issues);
  if (progress !== undefined) {
    optionalNumber(progress, "intervalMs", "$.progress.intervalMs", { min: 100, max: 60_000, integer: true }, issues);
    optionalBoolean(progress, "broadcast", "$.progress.broadcast", issues);
  }

  const time = optionalObject(
    input,
    "time",
    "$.time",
    ["clockMode", "sync", "startLeadMs", "interactionLeadMs", "lateEventPolicy", "tickRateHz", "audioLookAheadMs"],
    issues,
  );
  if (time !== undefined) {
    optionalEnum(time, "clockMode", "$.time.clockMode", ["monotonic", "fixed-tick", "audio"], issues);
    optionalNumber(time, "startLeadMs", "$.time.startLeadMs", { min: 0, max: 120_000, integer: true }, issues);
    optionalNumber(time, "interactionLeadMs", "$.time.interactionLeadMs", { min: 0, max: 30_000, integer: true }, issues);
    optionalEnum(time, "lateEventPolicy", "$.time.lateEventPolicy", ["apply-immediately", "drop", "next-boundary"], issues);
    optionalNumber(time, "tickRateHz", "$.time.tickRateHz", { min: 1, max: 1_000, integer: true }, issues);
    optionalNumber(time, "audioLookAheadMs", "$.time.audioLookAheadMs", { min: 0, max: 2_000 }, issues);
    const sync = optionalObject(
      time,
      "sync",
      "$.time.sync",
      ["enabled", "sampleCount", "resyncIntervalMs", "maxRttMs"],
      issues,
    );
    if (sync !== undefined) {
      optionalBoolean(sync, "enabled", "$.time.sync.enabled", issues);
      optionalNumber(sync, "sampleCount", "$.time.sync.sampleCount", { min: 1, max: 64, integer: true }, issues);
      optionalNumber(sync, "resyncIntervalMs", "$.time.sync.resyncIntervalMs", { min: 1_000, max: 3_600_000, integer: true }, issues);
      optionalNumber(sync, "maxRttMs", "$.time.sync.maxRttMs", { min: 1, max: 60_000 }, issues);
    }
  }

  const platform = optionalObject(
    input,
    "platform",
    "$.platform",
    ["target", "inputs", "crossPlay", "presentation"],
    issues,
  );
  if (platform !== undefined) {
    optionalEnum(platform, "target", "$.platform.target", ["universal", "mobile-first", "desktop-first"], issues);
    const inputs = optionalObject(platform, "inputs", "$.platform.inputs", ["touch", "keyboard", "pointer", "gamepad"], issues);
    if (inputs !== undefined) {
      for (const inputName of ["touch", "keyboard", "pointer", "gamepad"] as const) {
        optionalBoolean(inputs, inputName, `$.platform.inputs.${inputName}`, issues);
      }
    }
    const crossPlay = optionalObject(
      platform,
      "crossPlay",
      "$.platform.crossPlay",
      ["enabled", "rankedPool", "allowInputSwitch"],
      issues,
    );
    if (crossPlay !== undefined) {
      optionalBoolean(crossPlay, "enabled", "$.platform.crossPlay.enabled", issues);
      optionalEnum(crossPlay, "rankedPool", "$.platform.crossPlay.rankedPool", ["unified", "same-input-preferred", "separate"], issues);
      optionalBoolean(crossPlay, "allowInputSwitch", "$.platform.crossPlay.allowInputSwitch", issues);
    }
    const presentation = optionalObject(
      platform,
      "presentation",
      "$.platform.presentation",
      ["adaptiveQuality", "maxDevicePixelRatio", "preferReducedMotion"],
      issues,
    );
    if (presentation !== undefined) {
      optionalBoolean(presentation, "adaptiveQuality", "$.platform.presentation.adaptiveQuality", issues);
      optionalNumber(presentation, "maxDevicePixelRatio", "$.platform.presentation.maxDevicePixelRatio", { min: 1, max: 4 }, issues);
      optionalBoolean(presentation, "preferReducedMotion", "$.platform.presentation.preferReducedMotion", issues);
    }
  }

  const security = optionalObject(
    input,
    "security",
    "$.security",
    ["peerToPeer", "strictMessageValidation", "maxMessageBytes", "maxPayloadBytes", "opaqueIdentifiers", "requireIdempotencyKeys", "requireResumeEpoch", "auth", "rateLimits"],
    issues,
  );
  if (security !== undefined) {
    optionalBoolean(security, "peerToPeer", "$.security.peerToPeer", issues, false);
    optionalBoolean(security, "strictMessageValidation", "$.security.strictMessageValidation", issues, true);
    optionalNumber(security, "maxMessageBytes", "$.security.maxMessageBytes", { min: 1_024, max: 4_194_304, integer: true }, issues);
    optionalNumber(security, "maxPayloadBytes", "$.security.maxPayloadBytes", { min: 0, max: 1_048_576, integer: true }, issues);
    optionalBoolean(security, "opaqueIdentifiers", "$.security.opaqueIdentifiers", issues, true);
    optionalBoolean(security, "requireIdempotencyKeys", "$.security.requireIdempotencyKeys", issues, true);
    optionalBoolean(security, "requireResumeEpoch", "$.security.requireResumeEpoch", issues, true);
    const auth = optionalObject(security, "auth", "$.security.auth", ["requiredInProduction"], issues);
    if (auth !== undefined) {
      optionalBoolean(auth, "requiredInProduction", "$.security.auth.requiredInProduction", issues, true);
    }
    const rateLimits = optionalObject(security, "rateLimits", "$.security.rateLimits", ["default", "actions"], issues);
    if (rateLimits !== undefined) {
      const defaultLimit = optionalObject(rateLimits, "default", "$.security.rateLimits.default", ["capacity", "refillPerSecond"], issues);
      if (defaultLimit !== undefined) {
        validateRateLimit(defaultLimit, "$.security.rateLimits.default", issues);
      }
      const actions = optionalObject(rateLimits, "actions", "$.security.rateLimits.actions", Object.keys((rateLimits.actions as Record<string, unknown> | undefined) ?? {}), issues);
      if (actions !== undefined) {
        for (const [action, rateLimit] of Object.entries(actions)) {
          if (!/^[a-z][a-z0-9_.:-]{0,63}$/u.test(action)) {
            issues.push(issue(`$.security.rateLimits.actions.${action}`, "invalid_format", "invalid action rate-limit key", action));
          }
          if (!isPlainObject(rateLimit)) {
            issues.push(issue(`$.security.rateLimits.actions.${action}`, "invalid_type", "expected a rate-limit object", rateLimit));
          } else {
            validateRateLimit(rateLimit, `$.security.rateLimits.actions.${action}`, issues);
          }
        }
      }
    }
  }

  return issues;
}

function validateResolvedInvariants(config: RelayPlayConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (config.security.maxPayloadBytes > config.security.maxMessageBytes) {
    issues.push(
      issue(
        "$.security.maxPayloadBytes",
        "invariant",
        "maxPayloadBytes must not exceed maxMessageBytes",
        config.security.maxPayloadBytes,
      ),
    );
  }
  if (
    !config.platform.inputs.touch &&
    !config.platform.inputs.keyboard &&
    !config.platform.inputs.pointer &&
    !config.platform.inputs.gamepad
  ) {
    issues.push(
      issue("$.platform.inputs", "invariant", "at least one input class must be enabled", config.platform.inputs),
    );
  }
  if (
    !config.features.interactions.enabled &&
    (config.features.interactions.targeted || config.features.interactions.scheduled)
  ) {
    issues.push(
      issue(
        "$.features.interactions",
        "invariant",
        "targeted and scheduled flags require interactions.enabled",
        config.features.interactions,
      ),
    );
  }
  if (!config.features.reconnect.enabled && config.features.reconnect.replayCanonicalEvents) {
    issues.push(
      issue(
        "$.features.reconnect.replayCanonicalEvents",
        "invariant",
        "canonical replay requires reconnect.enabled",
        true,
      ),
    );
  }
  for (const [action, limit] of Object.entries(config.security.rateLimits.actions)) {
    if (
      !Number.isInteger(limit.capacity) ||
      limit.capacity < 1 ||
      limit.capacity > 10_000 ||
      !Number.isFinite(limit.refillPerSecond) ||
      limit.refillPerSecond < 0.001 ||
      limit.refillPerSecond > 10_000
    ) {
      issues.push(
        issue(
          `$.security.rateLimits.actions.${action}`,
          "invariant",
          "each action rate limit requires valid capacity and refillPerSecond",
          limit,
        ),
      );
    }
  }
  return issues;
}

export function validateConfig(input: unknown = {}): ValidationResult<RelayPlayConfig> {
  const shapeIssues = validateConfigInputShape(input);
  if (shapeIssues.length > 0 || !isPlainObject(input)) {
    return validationFailure(shapeIssues);
  }

  const merged = mergeObjects(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    input,
  ) as unknown as RelayPlayConfig;
  const invariantIssues = validateResolvedInvariants(merged);
  return invariantIssues.length === 0
    ? validationSuccess(merged)
    : validationFailure(invariantIssues);
}

export function normalizeConfig(input: RelayPlayConfigInput = {}): RelayPlayConfig {
  const result = validateConfig(input);
  if (!result.success) {
    throw new ConfigValidationError(result.issues);
  }
  return result.data;
}

export function defineConfig(input: RelayPlayConfigInput = {}): RelayPlayConfig {
  return normalizeConfig(input);
}

export function mergeConfig(
  ...inputs: readonly RelayPlayConfigInput[]
): RelayPlayConfig {
  let merged: Record<string, unknown> = {};
  for (const input of inputs) {
    merged = mergeObjects(merged, input as Record<string, unknown>);
  }
  return normalizeConfig(merged as RelayPlayConfigInput);
}
