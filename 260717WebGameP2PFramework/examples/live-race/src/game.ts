export type GamePhase = "lobby" | "countdown" | "running" | "finished";

export interface LiveRaceProgress {
  readonly score: number;
  readonly normalizedProgress: number;
  readonly combo: number;
  readonly phase: GamePhase;
}

export interface ScheduledFreeze {
  readonly eventId: string;
  readonly startsAtLocalMs: number;
  readonly durationMs: number;
}

export class LiveRaceGame {
  readonly #finishScore: number;
  #score = 0;
  #combo = 0;
  #phase: GamePhase = "lobby";
  #startsAtLocalMs: number | undefined;
  #freezeUntilLocalMs = 0;
  #scheduledFreezes = new Map<string, ScheduledFreeze>();

  constructor(finishScore = 100) {
    if (!Number.isSafeInteger(finishScore) || finishScore <= 0) {
      throw new RangeError("finishScore must be a positive safe integer");
    }

    this.#finishScore = finishScore;
  }

  get phase(): GamePhase {
    return this.#phase;
  }

  get score(): number {
    return this.#score;
  }

  get combo(): number {
    return this.#combo;
  }

  get normalizedProgress(): number {
    return Math.min(1, this.#score / this.#finishScore);
  }

  get freezeUntilLocalMs(): number {
    return this.#freezeUntilLocalMs;
  }

  scheduleStart(startsAtLocalMs: number): void {
    if (!Number.isFinite(startsAtLocalMs)) {
      throw new RangeError("startsAtLocalMs must be finite");
    }

    this.#score = 0;
    this.#combo = 0;
    this.#freezeUntilLocalMs = 0;
    this.#scheduledFreezes.clear();
    this.#startsAtLocalMs = startsAtLocalMs;
    this.#phase = "countdown";
  }

  scheduleFreeze(freeze: ScheduledFreeze): boolean {
    if (
      this.#scheduledFreezes.has(freeze.eventId) ||
      !Number.isFinite(freeze.startsAtLocalMs) ||
      !Number.isFinite(freeze.durationMs) ||
      freeze.durationMs <= 0
    ) {
      return false;
    }

    this.#scheduledFreezes.set(freeze.eventId, freeze);
    return true;
  }

  advance(localNowMs: number): void {
    if (this.#phase === "countdown" && localNowMs >= (this.#startsAtLocalMs ?? Infinity)) {
      this.#phase = "running";
    }

    for (const [eventId, freeze] of this.#scheduledFreezes) {
      if (freeze.startsAtLocalMs <= localNowMs) {
        this.#freezeUntilLocalMs = Math.max(
          this.#freezeUntilLocalMs,
          freeze.startsAtLocalMs + freeze.durationMs,
        );
        this.#scheduledFreezes.delete(eventId);
      }
    }
  }

  sprint(localNowMs: number): boolean {
    this.advance(localNowMs);
    if (this.#phase !== "running" || localNowMs < this.#freezeUntilLocalMs) {
      return false;
    }

    this.#combo += 1;
    this.#score = Math.min(this.#finishScore, this.#score + 1 + Math.floor(this.#combo / 12));
    if (this.#score >= this.#finishScore) {
      this.#phase = "finished";
    }
    return true;
  }

  breakCombo(): void {
    this.#combo = 0;
  }

  snapshot(): LiveRaceProgress {
    return {
      score: this.#score,
      normalizedProgress: this.normalizedProgress,
      combo: this.#combo,
      phase: this.#phase,
    };
  }
}
