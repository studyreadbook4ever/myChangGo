import type { RoomEngine } from "@relayplay/server";

export interface RoomAlarmLogger {
  error(event: string, data?: Readonly<Record<string, string | number | boolean>>): void;
}

/** Sparse one-shot room timers; no server frame loop or periodic room polling. */
export class RoomAlarmScheduler {
  readonly #engine: RoomEngine;
  readonly #logger: RoomAlarmLogger;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #running = new Set<Promise<void>>();
  #stopped = false;

  public constructor(engine: RoomEngine, logger: RoomAlarmLogger) {
    this.#engine = engine;
    this.#logger = logger;
  }

  public async schedule(roomId: string): Promise<void> {
    if (this.#stopped) return;
    const previous = this.#timers.get(roomId);
    if (previous !== undefined) clearTimeout(previous);
    const next = await this.#engine.nextAlarmAt(roomId);
    if (next === undefined) {
      this.#timers.delete(roomId);
      return;
    }
    const delay = Math.max(1, next - Date.now());
    const timer = setTimeout(() => {
      this.#timers.delete(roomId);
      const running = this.#run(roomId);
      this.#running.add(running);
      void running.then(() => this.#running.delete(running));
    }, delay);
    timer.unref();
    this.#timers.set(roomId, timer);
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all(this.#running);
  }

  async #run(roomId: string): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#engine.sweep(roomId);
      await this.schedule(roomId);
    } catch {
      this.#logger.error("room_alarm_failed");
    }
  }
}
