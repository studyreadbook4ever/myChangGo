import { TimeSyncError } from "./errors.js";

/** Four timestamps from an NTP-style request/response exchange. */
export interface TimeSyncExchange {
  readonly clientSendTimeMs: number;
  readonly serverReceiveTimeMs: number;
  readonly serverSendTimeMs: number;
  readonly clientReceiveTimeMs: number;
}

/** A measured server-minus-client offset and its network uncertainty. */
export interface TimeSyncSample extends TimeSyncExchange {
  readonly offsetMs: number;
  readonly roundTripTimeMs: number;
  readonly serverProcessingTimeMs: number;
  readonly clientMidpointTimeMs: number;
}

export interface TimeSyncEstimate {
  /** Add this value to a client timestamp to express it on the server clock. */
  readonly offsetMs: number;
  readonly roundTripTimeMs: number;
  readonly uncertaintyMs: number;
  readonly sampleCount: number;
  readonly measuredAtClientTimeMs: number;
}

export interface TimeSyncEstimatorOptions {
  readonly maxRttMs?: number;
  readonly sampleCount?: number;
}

export interface FixedTickClock {
  readonly startServerTimeMs: number;
  readonly tickRateHz: number;
}

export interface AudioClockAnchor {
  readonly performanceTimeMs: number;
  readonly audioContextTimeSeconds: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TimeSyncError(`${name} must be finite`, { [name]: value });
  }
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) {
    throw new TimeSyncError(`${name} must not be negative`, { [name]: value });
  }
}

function validateExchange(exchange: TimeSyncExchange): void {
  requireFinite(exchange.clientSendTimeMs, "clientSendTimeMs");
  requireFinite(exchange.serverReceiveTimeMs, "serverReceiveTimeMs");
  requireFinite(exchange.serverSendTimeMs, "serverSendTimeMs");
  requireFinite(exchange.clientReceiveTimeMs, "clientReceiveTimeMs");

  if (exchange.clientReceiveTimeMs < exchange.clientSendTimeMs) {
    throw new TimeSyncError("client receive time precedes client send time", exchange);
  }
  if (exchange.serverSendTimeMs < exchange.serverReceiveTimeMs) {
    throw new TimeSyncError("server send time precedes server receive time", exchange);
  }
}

/**
 * Calculates the NTP offset θ=((t1-t0)+(t2-t3))/2 and delay
 * δ=(t3-t0)-(t2-t1). The offset sign is always server minus client.
 */
export function calculateTimeSyncSample(
  exchange: TimeSyncExchange,
): TimeSyncSample {
  validateExchange(exchange);
  const clientElapsed = exchange.clientReceiveTimeMs - exchange.clientSendTimeMs;
  const serverProcessingTimeMs =
    exchange.serverSendTimeMs - exchange.serverReceiveTimeMs;
  const rawRoundTripTimeMs = clientElapsed - serverProcessingTimeMs;

  // Timer quantization can make a near-zero delay slightly negative. A server
  // processing interval larger than the full client exchange is not usable.
  if (rawRoundTripTimeMs < -0.001) {
    throw new TimeSyncError(
      "server processing time exceeds the client round-trip duration",
      exchange,
    );
  }

  return {
    ...exchange,
    offsetMs:
      ((exchange.serverReceiveTimeMs - exchange.clientSendTimeMs) +
        (exchange.serverSendTimeMs - exchange.clientReceiveTimeMs)) /
      2,
    roundTripTimeMs: Math.max(0, rawRoundTripTimeMs),
    serverProcessingTimeMs,
    clientMidpointTimeMs:
      (exchange.clientSendTimeMs + exchange.clientReceiveTimeMs) / 2,
  };
}

/** Backwards-friendly verb for callers that construct samples incrementally. */
export const createTimeSyncSample = calculateTimeSyncSample;

export function selectBestTimeSyncSample(
  samples: readonly TimeSyncSample[],
  maxRttMs = Number.POSITIVE_INFINITY,
): TimeSyncSample {
  if (Number.isNaN(maxRttMs) || maxRttMs < 0) {
    throw new TimeSyncError("maxRttMs must not be negative or NaN", { maxRttMs });
  }
  const eligible = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.offsetMs) &&
        Number.isFinite(sample.roundTripTimeMs) &&
        sample.roundTripTimeMs >= 0 &&
        sample.roundTripTimeMs <= maxRttMs,
    )
    .toSorted(
      (left, right) =>
        left.roundTripTimeMs - right.roundTripTimeMs ||
        right.clientMidpointTimeMs - left.clientMidpointTimeMs,
    );

  const best = eligible[0];
  if (best === undefined) {
    throw new TimeSyncError("no usable time-sync samples", {
      sampleCount: samples.length,
      maxRttMs,
    });
  }
  return best;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new TimeSyncError("cannot take the median of an empty sample set");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new TimeSyncError("median sample unexpectedly missing");
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    throw new TimeSyncError("median sample unexpectedly missing");
  }
  return (lower + upper) / 2;
}

/**
 * Estimates the offset from the lowest-RTT samples and takes their median.
 * This rejects queueing outliers while retaining resistance to one bad sample.
 */
export function estimateTimeSync(
  samples: readonly TimeSyncSample[],
  options: TimeSyncEstimatorOptions = {},
): TimeSyncEstimate {
  const maxRttMs = options.maxRttMs ?? 2_000;
  const requestedCount = options.sampleCount ?? 3;
  requireNonNegative(maxRttMs, "maxRttMs");
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new TimeSyncError("sampleCount must be a positive integer", {
      sampleCount: requestedCount,
    });
  }

  const selected = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.offsetMs) &&
        Number.isFinite(sample.roundTripTimeMs) &&
        sample.roundTripTimeMs >= 0 &&
        sample.roundTripTimeMs <= maxRttMs,
    )
    .toSorted((left, right) => left.roundTripTimeMs - right.roundTripTimeMs)
    .slice(0, requestedCount);

  if (selected.length === 0) {
    throw new TimeSyncError("no usable time-sync samples", {
      sampleCount: samples.length,
      maxRttMs,
    });
  }

  const offsetMs = median(selected.map((sample) => sample.offsetMs));
  const bestRttMs = selected.reduce(
    (best, sample) => Math.min(best, sample.roundTripTimeMs),
    Number.POSITIVE_INFINITY,
  );
  const medianAbsoluteDeviation = median(
    selected.map((sample) => Math.abs(sample.offsetMs - offsetMs)),
  );

  return {
    offsetMs,
    roundTripTimeMs: bestRttMs,
    uncertaintyMs: bestRttMs / 2 + medianAbsoluteDeviation,
    sampleCount: selected.length,
    measuredAtClientTimeMs: selected.reduce(
      (latest, sample) => Math.max(latest, sample.clientMidpointTimeMs),
      Number.NEGATIVE_INFINITY,
    ),
  };
}

/** Alias that emphasizes the estimated value rather than the exchange. */
export const estimateClockOffset = estimateTimeSync;

function readOffset(estimateOrOffset: TimeSyncEstimate | number): number {
  const offsetMs =
    typeof estimateOrOffset === "number"
      ? estimateOrOffset
      : estimateOrOffset.offsetMs;
  requireFinite(offsetMs, "offsetMs");
  return offsetMs;
}

export function clientTimeToServerTime(
  clientTimeMs: number,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  requireFinite(clientTimeMs, "clientTimeMs");
  return clientTimeMs + readOffset(estimateOrOffset);
}

export function serverTimeToClientTime(
  serverTimeMs: number,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  requireFinite(serverTimeMs, "serverTimeMs");
  return serverTimeMs - readOffset(estimateOrOffset);
}

export const toServerTime = clientTimeToServerTime;
export const toClientTime = serverTimeToClientTime;

export function millisecondsUntilServerTime(
  targetServerTimeMs: number,
  nowClientTimeMs: number,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  return serverTimeToClientTime(targetServerTimeMs, estimateOrOffset) - nowClientTimeMs;
}

export function synchronizedStartDelayMs(
  targetServerTimeMs: number,
  nowClientTimeMs: number,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  return Math.max(
    0,
    millisecondsUntilServerTime(
      targetServerTimeMs,
      nowClientTimeMs,
      estimateOrOffset,
    ),
  );
}

function validateFixedTickClock(clock: FixedTickClock): void {
  requireFinite(clock.startServerTimeMs, "startServerTimeMs");
  requireFinite(clock.tickRateHz, "tickRateHz");
  if (clock.tickRateHz <= 0 || clock.tickRateHz > 1_000) {
    throw new TimeSyncError("tickRateHz must be greater than 0 and at most 1000", clock);
  }
}

/** Returns a signed tick; callers can clamp pre-start values when appropriate. */
export function serverTimeToTick(
  serverTimeMs: number,
  clock: FixedTickClock,
): number {
  requireFinite(serverTimeMs, "serverTimeMs");
  validateFixedTickClock(clock);
  return Math.floor(
    ((serverTimeMs - clock.startServerTimeMs) * clock.tickRateHz) / 1_000,
  );
}

export function currentTickAtServerTime(
  serverTimeMs: number,
  clock: FixedTickClock,
): number {
  return Math.max(0, serverTimeToTick(serverTimeMs, clock));
}

export function tickToServerTime(
  tick: number,
  clock: FixedTickClock,
): number {
  if (!Number.isSafeInteger(tick)) {
    throw new TimeSyncError("tick must be a safe integer", { tick });
  }
  validateFixedTickClock(clock);
  return clock.startServerTimeMs + (tick * 1_000) / clock.tickRateHz;
}

export function clientTimeToTick(
  clientTimeMs: number,
  clock: FixedTickClock,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  return serverTimeToTick(
    clientTimeToServerTime(clientTimeMs, estimateOrOffset),
    clock,
  );
}

export function tickToClientTime(
  tick: number,
  clock: FixedTickClock,
  estimateOrOffset: TimeSyncEstimate | number,
): number {
  return serverTimeToClientTime(
    tickToServerTime(tick, clock),
    estimateOrOffset,
  );
}

export function quantizeServerTimeToNextTick(
  serverTimeMs: number,
  clock: FixedTickClock,
): number {
  const exactTick =
    ((serverTimeMs - clock.startServerTimeMs) * clock.tickRateHz) / 1_000;
  return tickToServerTime(Math.ceil(exactTick), clock);
}

export function performanceTimeToAudioTime(
  performanceTimeMs: number,
  anchor: AudioClockAnchor,
): number {
  requireFinite(performanceTimeMs, "performanceTimeMs");
  requireFinite(anchor.performanceTimeMs, "anchor.performanceTimeMs");
  requireFinite(anchor.audioContextTimeSeconds, "anchor.audioContextTimeSeconds");
  return (
    anchor.audioContextTimeSeconds +
    (performanceTimeMs - anchor.performanceTimeMs) / 1_000
  );
}

export function audioTimeToPerformanceTime(
  audioContextTimeSeconds: number,
  anchor: AudioClockAnchor,
): number {
  requireFinite(audioContextTimeSeconds, "audioContextTimeSeconds");
  requireFinite(anchor.performanceTimeMs, "anchor.performanceTimeMs");
  requireFinite(anchor.audioContextTimeSeconds, "anchor.audioContextTimeSeconds");
  return (
    anchor.performanceTimeMs +
    (audioContextTimeSeconds - anchor.audioContextTimeSeconds) * 1_000
  );
}
