export interface ClientResumeState {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly roomEpoch: number;
  readonly resumeEpoch: number;
  readonly lastEventSequence: number;
}

export interface ResumeStore {
  load(roomId: string): ClientResumeState | undefined | Promise<ClientResumeState | undefined>;
  save(state: ClientResumeState): void | Promise<void>;
  clear(roomId: string): void | Promise<void>;
}

export class MemoryResumeStore implements ResumeStore {
  readonly #states = new Map<string, ClientResumeState>();

  load(roomId: string): ClientResumeState | undefined {
    return this.#states.get(roomId);
  }

  save(state: ClientResumeState): void {
    this.#states.set(state.roomId, state);
  }

  clear(roomId: string): void {
    this.#states.delete(roomId);
  }
}

export interface SessionStorageResumeStoreOptions {
  readonly storage?: Storage;
  readonly keyPrefix?: string;
}

function isResumeState(value: unknown, roomId: string): value is ClientResumeState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Record<keyof ClientResumeState, unknown>>;
  return (
    candidate.roomId === roomId &&
    typeof candidate.playerId === "string" && candidate.playerId.length > 0 &&
    typeof candidate.sessionId === "string" && candidate.sessionId.length > 0 &&
    typeof candidate.roomEpoch === "number" &&
    Number.isSafeInteger(candidate.roomEpoch) && candidate.roomEpoch >= 0 &&
    typeof candidate.resumeEpoch === "number" &&
    Number.isSafeInteger(candidate.resumeEpoch) && candidate.resumeEpoch >= 1 &&
    typeof candidate.lastEventSequence === "number" &&
    Number.isSafeInteger(candidate.lastEventSequence) &&
    candidate.lastEventSequence >= 0
  );
}

export class SessionStorageResumeStore implements ResumeStore {
  readonly #storage: Storage;
  readonly #keyPrefix: string;

  constructor(options: SessionStorageResumeStoreOptions = {}) {
    const storage = options.storage ?? globalThis.sessionStorage;
    if (storage === undefined) {
      throw new Error("sessionStorage is unavailable. Supply a Storage implementation.");
    }
    this.#storage = storage;
    this.#keyPrefix = options.keyPrefix ?? "relayplay:resume:";
  }

  load(roomId: string): ClientResumeState | undefined {
    const serialized = this.#storage.getItem(this.#key(roomId));
    if (serialized === null) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isResumeState(parsed, roomId)) {
        return parsed;
      }
    } catch {
      // Corrupt state is removed below and treated as a fresh join.
    }
    this.clear(roomId);
    return undefined;
  }

  save(state: ClientResumeState): void {
    this.#storage.setItem(this.#key(state.roomId), JSON.stringify(state));
  }

  clear(roomId: string): void {
    this.#storage.removeItem(this.#key(roomId));
  }

  #key(roomId: string): string {
    return `${this.#keyPrefix}${roomId}`;
  }
}
