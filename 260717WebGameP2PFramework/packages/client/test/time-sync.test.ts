import { describe, expect, it } from "vitest";
import { TimeSynchronizer, type Clock } from "../src/time-sync.js";

class TestClock implements Clock {
  value = 0;

  now(): number {
    return this.value;
  }
}

describe("TimeSynchronizer", () => {
  it("estimates offset from the midpoint of a ping round trip", () => {
    const clock = new TestClock();
    const sync = new TimeSynchronizer({ clock });
    clock.value = 1_000;
    sync.begin("p1");
    clock.value = 1_020;

    const sample = sync.complete("p1", 1_510);
    expect(sample).toMatchObject({ roundTripMs: 20, offsetMs: 500 });
    expect(sync.estimate).toEqual({
      offsetMs: 500,
      roundTripMs: 20,
      sampleCount: 1,
    });
    expect(sync.serverNow()).toBe(1_520);
  });

  it("ignores a pong without a matching ping", () => {
    const sync = new TimeSynchronizer();
    expect(sync.complete("missing", Date.now())).toBeUndefined();
  });
});
