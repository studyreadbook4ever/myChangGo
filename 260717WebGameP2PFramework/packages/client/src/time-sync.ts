export interface Clock {
  now(): number;
}

export const monotonicEpochClock: Clock = {
  now: () => {
    const performance = globalThis.performance;
    if (
      performance !== undefined &&
      Number.isFinite(performance.timeOrigin) &&
      typeof performance.now === "function"
    ) {
      return performance.timeOrigin + performance.now();
    }
    return Date.now();
  },
};

export interface TimeSyncSample {
  readonly id: string;
  readonly clientSentAt: number;
  readonly clientReceivedAt: number;
  readonly serverTime: number;
  readonly roundTripMs: number;
  readonly offsetMs: number;
}

export interface TimeSyncEstimate {
  readonly offsetMs: number;
  readonly roundTripMs: number;
  readonly sampleCount: number;
}

export interface TimeSynchronizerOptions {
  clock?: Clock;
  maxSamples?: number;
  maxRoundTripMs?: number;
}

/** NTP-style server clock estimation, biased toward the lowest-RTT samples. */
export class TimeSynchronizer {
  readonly #clock: Clock;
  readonly #maxSamples: number;
  readonly #maxRoundTripMs: number;
  readonly #pending = new Map<string, number>();
  readonly #samples: TimeSyncSample[] = [];

  constructor(options: TimeSynchronizerOptions = {}) {
    this.#clock = options.clock ?? monotonicEpochClock;
    const maxSamples = options.maxSamples ?? 8;
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
      throw new RangeError("maxSamples must be a positive safe integer.");
    }
    this.#maxSamples = maxSamples;
    const maxRoundTripMs =
      options.maxRoundTripMs ?? Number.POSITIVE_INFINITY;
    if (Number.isNaN(maxRoundTripMs) || maxRoundTripMs < 0) {
      throw new RangeError("maxRoundTripMs must be non-negative.");
    }
    this.#maxRoundTripMs = maxRoundTripMs;
  }

  get estimate(): TimeSyncEstimate | undefined {
    if (this.#samples.length === 0) {
      return undefined;
    }

    const byRoundTrip = [...this.#samples].sort(
      (left, right) => left.roundTripMs - right.roundTripMs,
    );
    const selected = byRoundTrip.slice(
      0,
      Math.max(1, Math.ceil(byRoundTrip.length / 2)),
    );
    const offsets = selected
      .map((sample) => sample.offsetMs)
      .sort((left, right) => left - right);
    const middle = Math.floor(offsets.length / 2);
    const medianOffset =
      offsets.length % 2 === 0
        ? ((offsets[middle - 1] ?? 0) + (offsets[middle] ?? 0)) / 2
        : (offsets[middle] ?? 0);

    return {
      offsetMs: medianOffset,
      roundTripMs: selected[0]?.roundTripMs ?? 0,
      sampleCount: this.#samples.length,
    };
  }

  get offsetMs(): number {
    return this.estimate?.offsetMs ?? 0;
  }

  get roundTripMs(): number | undefined {
    return this.estimate?.roundTripMs;
  }

  begin(id: string, sentAt = this.#clock.now()): number {
    if (id.length === 0) {
      throw new TypeError("Ping id must not be empty.");
    }
    this.#pending.set(id, sentAt);
    return sentAt;
  }

  complete(
    id: string,
    serverTime: number,
    receivedAt = this.#clock.now(),
  ): TimeSyncSample | undefined {
    const sentAt = this.#pending.get(id);
    if (sentAt === undefined) {
      return undefined;
    }
    this.#pending.delete(id);

    if (!Number.isFinite(serverTime) || receivedAt < sentAt) {
      return undefined;
    }

    const roundTripMs = receivedAt - sentAt;
    if (roundTripMs > this.#maxRoundTripMs) {
      return undefined;
    }
    const offsetMs = serverTime - (sentAt + receivedAt) / 2;
    const sample: TimeSyncSample = {
      id,
      clientSentAt: sentAt,
      clientReceivedAt: receivedAt,
      serverTime,
      roundTripMs,
      offsetMs,
    };
    this.#samples.push(sample);
    if (this.#samples.length > this.#maxSamples) {
      this.#samples.shift();
    }
    return sample;
  }

  serverNow(): number {
    return this.toServerTime(this.#clock.now());
  }

  localNow(): number {
    return this.#clock.now();
  }

  toServerTime(localTime: number): number {
    return localTime + this.offsetMs;
  }

  toLocalTime(serverTime: number): number {
    return serverTime - this.offsetMs;
  }

  reset(): void {
    this.#pending.clear();
    this.#samples.length = 0;
  }
}
