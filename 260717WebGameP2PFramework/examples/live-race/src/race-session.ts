import { isPlainObject, type JsonValue } from "@relayplay/core";

import {
  LIVE_RACE_FINISH_SCORE,
  LIVE_RACE_MAX_PLAYERS,
  LIVE_RACE_MAX_RESULT_ELAPSED_MS,
} from "./config.js";
import type { LiveRaceProgress } from "./game.js";

export interface OpponentState {
  readonly playerId: string;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly progress?: LiveRaceProgress;
  readonly receivedAtLocalMs?: number;
  readonly placement?: number;
}

/** Small bounded projection of remote room state for the example UI. */
export class OpponentRoster {
  readonly #maximumOpponents: number;
  readonly #opponents = new Map<string, OpponentState>();

  public constructor(maximumOpponents: number) {
    if (!Number.isSafeInteger(maximumOpponents) || maximumOpponents < 1) {
      throw new RangeError("maximumOpponents must be a positive safe integer");
    }
    this.#maximumOpponents = maximumOpponents;
  }

  public clear(): void {
    this.#opponents.clear();
  }

  public reconcilePresence(
    players: readonly {
      readonly playerId: string;
      readonly connected: boolean;
      readonly ready: boolean;
    }[],
  ): void {
    const currentPlayerIds = new Set(players.map(({ playerId }) => playerId));
    for (const playerId of this.#opponents.keys()) {
      if (!currentPlayerIds.has(playerId)) this.#opponents.delete(playerId);
    }
    for (const player of players) {
      this.updatePresence(player.playerId, player.connected, player.ready);
    }
  }

  public updatePresence(playerId: string, connected: boolean, ready: boolean): void {
    this.#update(playerId, (previous) => ({
      ...previous,
      playerId,
      connected,
      ready,
    }));
  }

  public updateReady(playerId: string, ready: boolean): void {
    this.#update(playerId, (previous) => ({
      ...previous,
      playerId,
      connected: previous?.connected ?? true,
      ready,
    }));
  }

  public updateProgress(
    playerId: string,
    progress: LiveRaceProgress,
    receivedAtLocalMs: number,
  ): void {
    this.#update(playerId, (previous) => ({
      ...previous,
      playerId,
      connected: previous?.connected ?? true,
      ready: previous?.ready ?? false,
      progress,
      receivedAtLocalMs,
    }));
  }

  public setPlacement(playerId: string, placement: number): void {
    if (!Number.isSafeInteger(placement) || placement < 1) return;
    this.#update(playerId, (previous) => ({
      ...previous,
      playerId,
      connected: previous?.connected ?? true,
      ready: previous?.ready ?? false,
      placement,
    }));
  }

  public markFinished(playerId: string, receivedAtLocalMs: number): void {
    this.#update(playerId, (previous) => ({
      ...previous,
      playerId,
      connected: previous?.connected ?? true,
      ready: previous?.ready ?? true,
      progress: {
        score: LIVE_RACE_FINISH_SCORE,
        normalizedProgress: 1,
        combo: previous?.progress?.combo ?? 0,
        phase: "finished",
      },
      receivedAtLocalMs,
    }));
  }

  public resetPlacements(): void {
    for (const [playerId, opponent] of this.#opponents) {
      const { placement: _placement, ...withoutPlacement } = opponent;
      this.#opponents.set(playerId, withoutPlacement);
    }
  }

  public firstConnectedPlayerId(): string | undefined {
    return this.values().find(
      (opponent) => opponent.connected && opponent.progress?.phase !== "finished",
    )?.playerId;
  }

  public values(): readonly OpponentState[] {
    return [...this.#opponents.values()].sort((left, right) => {
      const leftPlacement = left.placement ?? Number.POSITIVE_INFINITY;
      const rightPlacement = right.placement ?? Number.POSITIVE_INFINITY;
      return (
        leftPlacement - rightPlacement ||
        Number(right.connected) - Number(left.connected) ||
        left.playerId.localeCompare(right.playerId)
      );
    });
  }

  #update(
    playerId: string,
    updater: (previous: OpponentState | undefined) => OpponentState,
  ): void {
    const previous = this.#opponents.get(playerId);
    if (previous === undefined && this.#opponents.size >= this.#maximumOpponents) {
      const replaceablePlayerId = this.values().find(
        (opponent) => !opponent.connected,
      )?.playerId;
      if (replaceablePlayerId === undefined) return;
      this.#opponents.delete(replaceablePlayerId);
    }
    this.#opponents.set(playerId, updater(previous));
  }
}

/** Resets for each canonical start and permits one local finish submission. */
export class RoundFinishGate {
  #submitted = false;

  public get submitted(): boolean {
    return this.#submitted;
  }

  public reset(): void {
    this.#submitted = false;
  }

  public runOnce(submit: () => void): boolean {
    if (this.#submitted) return false;
    submit();
    this.#submitted = true;
    return true;
  }
}

/** Canonical sequence order is the fallback placement when no rank is supplied. */
export class FinishPlacements {
  readonly #placements = new Map<string, number>();

  public clear(): void {
    this.#placements.clear();
  }

  public record(playerId: string, serverPlacement?: number): number {
    const previous = this.#placements.get(playerId);
    if (previous !== undefined) return previous;
    const placement =
      serverPlacement !== undefined &&
      Number.isSafeInteger(serverPlacement) &&
      serverPlacement > 0
        ? serverPlacement
        : this.#placements.size + 1;
    this.#placements.set(playerId, placement);
    return placement;
  }
}

/**
 * Only a compact, bounded summary crosses the trust boundary. It remains an
 * untrusted client claim; ranked games must verify evidence server-side.
 */
export function createBoundedFinishResult(
  progress: LiveRaceProgress,
  startsAtLocalMs: number | undefined,
  finishedAtLocalMs: number,
): JsonValue {
  const rawScore = Number.isFinite(progress.score) ? Math.trunc(progress.score) : 0;
  const score = Math.max(
    0,
    Math.min(LIVE_RACE_FINISH_SCORE, rawScore),
  );
  const rawElapsedMs =
    startsAtLocalMs === undefined ||
    !Number.isFinite(startsAtLocalMs) ||
    !Number.isFinite(finishedAtLocalMs)
      ? 0
      : finishedAtLocalMs - startsAtLocalMs;
  const elapsedMs = Math.max(
    0,
    Math.min(LIVE_RACE_MAX_RESULT_ELAPSED_MS, Math.round(rawElapsedMs)),
  );
  return { score, elapsedMs };
}

export function finishPlacement(payload: JsonValue): number | undefined {
  if (!isPlainObject(payload)) return undefined;
  const placement = payload.placement;
  return typeof placement === "number" &&
    Number.isSafeInteger(placement) &&
    placement >= 1 &&
    placement <= LIVE_RACE_MAX_PLAYERS
    ? placement
    : undefined;
}
