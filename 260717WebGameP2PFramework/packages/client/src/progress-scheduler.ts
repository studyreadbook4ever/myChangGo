import {
  assertPositiveInterval,
  browserTimerApi,
  type TimerApi,
  type TimerHandle,
} from "./timers.js";

export const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;

export type ProgressProvider<Progress> =
  () => Progress | undefined | Promise<Progress | undefined>;

export type ProgressReporter<Progress> =
  (progress: Progress) => void | Promise<void>;

export interface ProgressSchedulerOptions {
  intervalMs?: number;
  reportImmediately?: boolean;
  timers?: TimerApi;
  onError?: (error: unknown) => void;
}

/** Periodically samples replaceable progress without overlapping async samples. */
export class ProgressScheduler<Progress> {
  readonly #provider: ProgressProvider<Progress>;
  readonly #reporter: ProgressReporter<Progress>;
  readonly #timers: TimerApi;
  readonly #onError: (error: unknown) => void;
  readonly #reportImmediately: boolean;
  #intervalMs: number;
  #timer: TimerHandle | undefined;
  #running = false;
  #sampling = false;

  constructor(
    provider: ProgressProvider<Progress>,
    reporter: ProgressReporter<Progress>,
    options: ProgressSchedulerOptions = {},
  ) {
    this.#provider = provider;
    this.#reporter = reporter;
    this.#intervalMs = assertPositiveInterval(
      options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
      "progress interval",
    );
    this.#reportImmediately = options.reportImmediately ?? false;
    this.#timers = options.timers ?? browserTimerApi;
    this.#onError = options.onError ?? (() => undefined);
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  get running(): boolean {
    return this.#running;
  }

  setIntervalMs(intervalMs: number): void {
    this.#intervalMs = assertPositiveInterval(intervalMs, "progress interval");
    if (this.#running) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#timer = this.#timers.setInterval(() => {
      void this.flush();
    }, this.#intervalMs);
    if (this.#reportImmediately) {
      void this.flush();
    }
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#timers.clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async flush(): Promise<boolean> {
    if (this.#sampling) {
      return false;
    }

    this.#sampling = true;
    try {
      const progress = await this.#provider();
      if (progress === undefined) {
        return false;
      }
      await this.#reporter(progress);
      return true;
    } catch (error) {
      this.#onError(error);
      return false;
    } finally {
      this.#sampling = false;
    }
  }
}
