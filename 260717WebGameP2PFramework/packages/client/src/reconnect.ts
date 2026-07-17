export interface ReconnectOptions {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
  readonly maxAttempts?: number;
}

export interface ReconnectPolicy {
  readonly enabled: boolean;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
  readonly maxAttempts: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  multiplier: 2,
  jitterRatio: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

function finiteAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

export function normalizeReconnectOptions(
  options: ReconnectOptions = {},
): ReconnectPolicy {
  const initialDelayMs = finiteAtLeast(
    options.initialDelayMs ?? DEFAULT_RECONNECT_POLICY.initialDelayMs,
    0,
    "initialDelayMs",
  );
  const maxDelayMs = finiteAtLeast(
    options.maxDelayMs ?? DEFAULT_RECONNECT_POLICY.maxDelayMs,
    initialDelayMs,
    "maxDelayMs",
  );
  const multiplier = finiteAtLeast(
    options.multiplier ?? DEFAULT_RECONNECT_POLICY.multiplier,
    1,
    "multiplier",
  );
  const jitterRatio = finiteAtLeast(
    options.jitterRatio ?? DEFAULT_RECONNECT_POLICY.jitterRatio,
    0,
    "jitterRatio",
  );
  if (jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1.");
  }

  const maxAttempts =
    options.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts;
  if (
    maxAttempts !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
  ) {
    throw new RangeError("maxAttempts must be a non-negative safe integer or Infinity.");
  }

  return {
    enabled: options.enabled ?? DEFAULT_RECONNECT_POLICY.enabled,
    initialDelayMs,
    maxDelayMs,
    multiplier,
    jitterRatio,
    maxAttempts,
  };
}

export function reconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random = Math.random,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Reconnect attempt must be a positive safe integer.");
  }
  const base = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.multiplier ** (attempt - 1),
  );
  const jitter = base * policy.jitterRatio;
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(Math.max(0, base - jitter + unit * jitter * 2));
}
