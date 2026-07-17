import { describe, expect, it } from "vitest";
import {
  normalizeReconnectOptions,
  reconnectDelay,
} from "../src/reconnect.js";

describe("reconnect policy", () => {
  it("uses capped exponential backoff", () => {
    const policy = normalizeReconnectOptions({
      initialDelayMs: 100,
      maxDelayMs: 250,
      multiplier: 2,
      jitterRatio: 0,
    });
    expect(reconnectDelay(1, policy)).toBe(100);
    expect(reconnectDelay(2, policy)).toBe(200);
    expect(reconnectDelay(3, policy)).toBe(250);
  });

  it("validates the jitter range", () => {
    expect(() => normalizeReconnectOptions({ jitterRatio: 1.1 })).toThrow(
      RangeError,
    );
  });
});
