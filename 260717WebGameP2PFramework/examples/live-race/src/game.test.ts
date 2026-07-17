import { describe, expect, it } from "vitest";

import { LiveRaceGame } from "./game.js";

describe("LiveRaceGame", () => {
  it("keeps local gameplay independent from network progress", () => {
    const game = new LiveRaceGame(3);
    game.scheduleStart(1_000);

    expect(game.sprint(999)).toBe(false);
    expect(game.sprint(1_000)).toBe(true);
    expect(game.sprint(1_001)).toBe(true);
    expect(game.snapshot()).toMatchObject({ phase: "running", score: 2 });
    expect(game.sprint(1_002)).toBe(true);
    expect(game.phase).toBe("finished");
  });

  it("deduplicates freezes and applies them at the scheduled boundary", () => {
    const game = new LiveRaceGame();
    game.scheduleStart(0);
    game.advance(0);

    const freeze = {
      eventId: "event-1",
      startsAtLocalMs: 2_000,
      durationMs: 750,
    } as const;

    expect(game.scheduleFreeze(freeze)).toBe(true);
    expect(game.scheduleFreeze(freeze)).toBe(false);
    expect(game.sprint(1_999)).toBe(true);
    expect(game.sprint(2_000)).toBe(false);
    expect(game.sprint(2_749)).toBe(false);
    expect(game.sprint(2_750)).toBe(true);
  });
});
