export type EventMap = object;

export type EventListener<Payload> = (payload: Payload) => void;

/** A small synchronous emitter that preserves each event payload type. */
export class TypedEventEmitter<Events extends EventMap> {
  readonly #listeners = new Map<keyof Events, Set<EventListener<never>>>();

  on<Key extends keyof Events>(
    event: Key,
    listener: EventListener<Events[Key]>,
  ): () => void {
    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set<EventListener<never>>();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as EventListener<never>);
    return () => this.off(event, listener);
  }

  once<Key extends keyof Events>(
    event: Key,
    listener: EventListener<Events[Key]>,
  ): () => void {
    const remove = this.on(event, (payload) => {
      remove();
      listener(payload);
    });
    return remove;
  }

  off<Key extends keyof Events>(
    event: Key,
    listener: EventListener<Events[Key]>,
  ): void {
    const listeners = this.#listeners.get(event);
    listeners?.delete(listener as EventListener<never>);
    if (listeners?.size === 0) {
      this.#listeners.delete(event);
    }
  }

  emit<Key extends keyof Events>(event: Key, payload: Events[Key]): boolean {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined || listeners.size === 0) {
      return false;
    }

    for (const listener of [...listeners]) {
      (listener as EventListener<Events[Key]>)(payload);
    }
    return true;
  }

  listenerCount<Key extends keyof Events>(event: Key): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAllListeners<Key extends keyof Events>(event?: Key): void {
    if (event === undefined) {
      this.#listeners.clear();
      return;
    }
    this.#listeners.delete(event);
  }
}
