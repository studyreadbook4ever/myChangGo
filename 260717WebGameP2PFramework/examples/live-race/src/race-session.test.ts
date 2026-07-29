import { describe, expect, it, vi } from "vitest";

import {
  LIVE_RACE_CONFIG,
  LIVE_RACE_MAX_OPPONENTS,
  LIVE_RACE_MINIMUM_PLAYERS_TO_START,
} from "./config.js";
import {
  createBoundedFinishResult,
  finishPlacement,
  FinishPlacements,
  OpponentRoster,
  RoundFinishGate,
} from "./race-session.js";

describe("example multiplayer session state", () => {
  it("shares a four-player room contract with a two-player start floor", () => {
    expect(LIVE_RACE_CONFIG.room.maxPlayers).toBe(4);
    expect(LIVE_RACE_CONFIG.features.ranking.enabled).toBe(false);
    expect(LIVE_RACE_CONFIG.features.verification.finalResults).toBe(false);
    expect(LIVE_RACE_MAX_OPPONENTS).toBe(3);
    expect(LIVE_RACE_MINIMUM_PLAYERS_TO_START).toBe(2);
  });

  it("tracks at most three opponents and preserves progress across presence changes", () => {
    const roster = new OpponentRoster(3);
    roster.updatePresence("player_alpha", true, false);
    roster.updateProgress(
      "player_alpha",
      { score: 12, normalizedProgress: 0.12, combo: 4, phase: "running" },
      1_000,
    );
    roster.updatePresence("player_alpha", false, true);
    expect(roster.values()[0]).toMatchObject({
      connected: false,
      ready: true,
      progress: { score: 12 },
    });
    roster.updatePresence("player_bravo", true, false);
    roster.updatePresence("player_charlie", true, false);
    roster.updatePresence("player_ignored", true, false);

    expect(roster.values()).toHaveLength(3);
    expect(roster.values().some(({ playerId }) => playerId === "player_alpha")).toBe(false);
    expect(roster.values().some(({ playerId }) => playerId === "player_ignored")).toBe(true);
    expect(roster.firstConnectedPlayerId()).toBe("player_bravo");

    roster.setPlacement("player_bravo", 1);
    roster.markFinished("player_bravo", 2_000);
    expect(roster.values()[0]).toMatchObject({ playerId: "player_bravo", placement: 1 });
    expect(roster.values()[0]).toMatchObject({
      progress: { score: 100, normalizedProgress: 1, phase: "finished" },
      receivedAtLocalMs: 2_000,
    });
    expect(roster.firstConnectedPlayerId()).toBe("player_charlie");
    roster.resetPlacements();
    expect(roster.values().every(({ placement }) => placement === undefined)).toBe(true);
  });

  it("reconciles a room snapshot without losing retained opponent progress", () => {
    const roster = new OpponentRoster(3);
    roster.updateProgress(
      "player_alpha",
      { score: 12, normalizedProgress: 0.12, combo: 4, phase: "running" },
      1_000,
    );
    roster.updatePresence("player_stale", true, true);

    roster.reconcilePresence([
      { playerId: "player_alpha", connected: false, ready: true },
      { playerId: "player_bravo", connected: true, ready: false },
    ]);

    expect(roster.values()).toHaveLength(2);
    expect(roster.values().find(({ playerId }) => playerId === "player_alpha")).toMatchObject({
      connected: false,
      ready: true,
      progress: { score: 12 },
    });
    expect(roster.values().some(({ playerId }) => playerId === "player_stale")).toBe(false);
  });

  it("submits a local finish once per canonical start", () => {
    const gate = new RoundFinishGate();
    const submit = vi.fn();

    expect(gate.runOnce(submit)).toBe(true);
    expect(gate.runOnce(submit)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);

    gate.reset();
    expect(gate.runOnce(submit)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("allows a finish retry when the transport call throws", () => {
    const gate = new RoundFinishGate();

    expect(() =>
      gate.runOnce(() => {
        throw new Error("socket closed");
      }),
    ).toThrow("socket closed");
    expect(gate.submitted).toBe(false);
  });

  it("deduplicates canonical placements and honors a server placement", () => {
    const placements = new FinishPlacements();
    expect(placements.record("player_alpha")).toBe(1);
    expect(placements.record("player_alpha")).toBe(1);
    expect(placements.record("player_bravo", 3)).toBe(3);
  });

  it("bounds the untrusted finish result and only reads valid server placements", () => {
    expect(
      createBoundedFinishResult(
        { score: 999, normalizedProgress: 1, combo: 10, phase: "finished" },
        1_000,
        7_500_000,
      ),
    ).toEqual({ score: 100, elapsedMs: 3_600_000 });
    expect(
      createBoundedFinishResult(
        { score: Number.NaN, normalizedProgress: 1, combo: 0, phase: "finished" },
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual({ score: 0, elapsedMs: 0 });
    expect(finishPlacement({ placement: 4 })).toBe(4);
    expect(finishPlacement({ placement: 5 })).toBeUndefined();
    expect(finishPlacement({ placement: "1" })).toBeUndefined();
  });
});
