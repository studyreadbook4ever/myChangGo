import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  ProgressScheduler,
} from "../src/progress-scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ProgressScheduler", () => {
  it("reports at the 1,000 ms default cadence", async () => {
    vi.useFakeTimers();
    const reporter = vi.fn();
    const scheduler = new ProgressScheduler(() => ({ score: 4 }), reporter);

    expect(scheduler.intervalMs).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(reporter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reporter).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("rejects unsafe interval overrides", () => {
    expect(
      () => new ProgressScheduler(() => undefined, () => undefined, { intervalMs: 0 }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ProgressScheduler(() => undefined, () => undefined, {
          intervalMs: Number.NaN,
        }),
    ).toThrow(RangeError);
  });

  it("does not overlap async progress sampling", async () => {
    let release: (() => void) | undefined;
    const provider = vi.fn(
      () => new Promise<{ score: number }>((resolve) => {
        release = () => resolve({ score: 1 });
      }),
    );
    const reporter = vi.fn();
    const scheduler = new ProgressScheduler(provider, reporter);

    const first = scheduler.flush();
    expect(await scheduler.flush()).toBe(false);
    expect(provider).toHaveBeenCalledOnce();
    release?.();
    expect(await first).toBe(true);
    expect(reporter).toHaveBeenCalledOnce();
  });
});
