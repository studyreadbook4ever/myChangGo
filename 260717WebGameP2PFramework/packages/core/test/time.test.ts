import { describe, expect, it } from "vitest";

import { TimeSyncError } from "../src/errors.js";
import {
  audioTimeToPerformanceTime,
  calculateTimeSyncSample,
  clientTimeToServerTime,
  clientTimeToTick,
  currentTickAtServerTime,
  estimateTimeSync,
  performanceTimeToAudioTime,
  quantizeServerTimeToNextTick,
  selectBestTimeSyncSample,
  serverTimeToClientTime,
  serverTimeToTick,
  synchronizedStartDelayMs,
  tickToClientTime,
  tickToServerTime,
  type FixedTickClock,
} from "../src/time.js";

describe("time synchronization", () => {
  it("calculates NTP-style server-minus-client offset and network RTT", () => {
    const sample = calculateTimeSyncSample({
      clientSendTimeMs: 1_000,
      serverReceiveTimeMs: 1_070,
      serverSendTimeMs: 1_075,
      clientReceiveTimeMs: 1_045,
    });

    expect(sample.offsetMs).toBe(50);
    expect(sample.roundTripTimeMs).toBe(40);
    expect(sample.serverProcessingTimeMs).toBe(5);
    expect(sample.clientMidpointTimeMs).toBe(1_022.5);
  });

  it("selects low-RTT samples and uses their median offset", () => {
    const exchanges = [
      { clientSendTimeMs: 0, serverReceiveTimeMs: 60, serverSendTimeMs: 60, clientReceiveTimeMs: 20 },
      { clientSendTimeMs: 100, serverReceiveTimeMs: 159, serverSendTimeMs: 159, clientReceiveTimeMs: 118 },
      { clientSendTimeMs: 200, serverReceiveTimeMs: 260, serverSendTimeMs: 260, clientReceiveTimeMs: 220 },
      { clientSendTimeMs: 300, serverReceiveTimeMs: 900, serverSendTimeMs: 900, clientReceiveTimeMs: 1_300 },
    ].map(calculateTimeSyncSample);

    expect(selectBestTimeSyncSample(exchanges).roundTripTimeMs).toBe(18);
    const estimate = estimateTimeSync(exchanges, { sampleCount: 3, maxRttMs: 100 });
    expect(estimate.offsetMs).toBe(50);
    expect(estimate.roundTripTimeMs).toBe(18);
    expect(estimate.sampleCount).toBe(3);
    expect(estimate.uncertaintyMs).toBeGreaterThanOrEqual(9);
  });

  it("converts between client and server clocks with a documented offset sign", () => {
    expect(clientTimeToServerTime(1_000, 50)).toBe(1_050);
    expect(serverTimeToClientTime(1_050, 50)).toBe(1_000);
    expect(synchronizedStartDelayMs(1_250, 1_000, 50)).toBe(200);
    expect(synchronizedStartDelayMs(900, 1_000, 50)).toBe(0);
  });

  it("maps server and local time to deterministic fixed ticks", () => {
    const clock: FixedTickClock = {
      startServerTimeMs: 10_000,
      tickRateHz: 60,
    };

    expect(serverTimeToTick(9_999, clock)).toBe(-1);
    expect(currentTickAtServerTime(9_999, clock)).toBe(0);
    expect(serverTimeToTick(10_999, clock)).toBe(59);
    expect(tickToServerTime(60, clock)).toBe(11_000);
    expect(clientTimeToTick(10_950, clock, 50)).toBe(60);
    expect(tickToClientTime(60, clock, 50)).toBe(10_950);
    expect(quantizeServerTimeToNextTick(10_001, clock)).toBeCloseTo(
      10_016.666_666_667,
    );
  });

  it("maps DOM performance time to the audio clock and back", () => {
    const anchor = {
      performanceTimeMs: 2_000,
      audioContextTimeSeconds: 10,
    };
    expect(performanceTimeToAudioTime(2_250, anchor)).toBe(10.25);
    expect(audioTimeToPerformanceTime(10.25, anchor)).toBe(2_250);
  });

  it("rejects impossible exchanges and estimator inputs", () => {
    expect(() =>
      calculateTimeSyncSample({
        clientSendTimeMs: 100,
        serverReceiveTimeMs: 200,
        serverSendTimeMs: 220,
        clientReceiveTimeMs: 110,
      }),
    ).toThrow(TimeSyncError);
    expect(() => estimateTimeSync([], { sampleCount: 3 })).toThrow(TimeSyncError);
  });
});
