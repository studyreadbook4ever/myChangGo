export interface LocalRateLimitPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Bounded in-process limiter for pre-authentication HTTP and frame abuse. */
export class LocalTokenBucketLimiter {
  readonly #policy: LocalRateLimitPolicy;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  public constructor(policy: LocalRateLimitPolicy, maxKeys = 10_000) {
    if (
      !Number.isSafeInteger(policy.capacity) ||
      policy.capacity < 1 ||
      !Number.isFinite(policy.refillPerSecond) ||
      policy.refillPerSecond <= 0 ||
      !Number.isSafeInteger(maxKeys) ||
      maxKeys < 1
    ) {
      throw new RangeError("local rate-limit configuration is invalid");
    }
    this.#policy = policy;
    this.#maxKeys = maxKeys;
  }

  public consume(key: string, now = Date.now(), cost = 1): number | undefined {
    if (key.length === 0 || !Number.isFinite(now) || !Number.isFinite(cost) || cost <= 0) {
      throw new RangeError("rate-limit request is invalid");
    }
    const previous = this.#buckets.get(key) ?? {
      tokens: this.#policy.capacity,
      updatedAt: now,
    };
    const elapsedSeconds = Math.max(0, now - previous.updatedAt) / 1_000;
    const tokens = Math.min(
      this.#policy.capacity,
      previous.tokens + elapsedSeconds * this.#policy.refillPerSecond,
    );
    if (tokens >= cost) {
      this.#touch(key, { tokens: tokens - cost, updatedAt: now });
      return undefined;
    }
    this.#touch(key, { tokens, updatedAt: now });
    return Math.ceil(((cost - tokens) / this.#policy.refillPerSecond) * 1_000);
  }

  public prune(before: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.updatedAt < before) this.#buckets.delete(key);
    }
  }

  #touch(key: string, bucket: Bucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    while (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
  }
}
