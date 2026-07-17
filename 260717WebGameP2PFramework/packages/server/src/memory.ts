import type {
  BroadcastOptions,
  CanonicalCommit,
  CanonicalCommitResult,
  CanonicalEvent,
  CanonicalRange,
  RateLimitRequest,
  RateLimitResult,
  RoomBroadcaster,
  RoomSignal,
  RoomStorage,
  StoredRoom,
  StoredSession,
} from "./types.js";

interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
}

function roomKey(roomId: string, roomEpoch: number): string {
  return `${roomId}\u0000${String(roomEpoch)}`;
}

function sessionKey(roomId: string, playerId: string): string {
  return `${roomId}\u0000${playerId}`;
}

function idempotencyKey(commit: CanonicalCommit): string {
  return [
    commit.roomId,
    String(commit.roomEpoch),
    commit.idempotencyScope,
    commit.idempotencyKey,
  ].join("\u0000");
}

function createEvent(commit: CanonicalCommit, sequence: number): CanonicalEvent {
  return {
    roomId: commit.roomId,
    roomEpoch: commit.roomEpoch,
    eventId: commit.eventId,
    sequence,
    kind: commit.kind,
    createdAt: commit.createdAt,
    ...(commit.effectiveAt === undefined ? {} : { effectiveAt: commit.effectiveAt }),
    ...(commit.playerId === undefined ? {} : { playerId: commit.playerId }),
    ...(commit.targetPlayerId === undefined
      ? {}
      : { targetPlayerId: commit.targetPlayerId }),
    ...(commit.action === undefined ? {} : { action: commit.action }),
    payload: commit.payload,
  };
}

export interface InMemoryStorageOptions {
  readonly audit?: string[];
}

/** Deterministic storage implementation for local development and tests. */
export class InMemoryRoomStorage implements RoomStorage {
  readonly #rooms = new Map<string, StoredRoom>();
  readonly #sessions = new Map<string, StoredSession>();
  readonly #events = new Map<string, CanonicalEvent[]>();
  readonly #idempotency = new Map<string, CanonicalEvent>();
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #audit: string[] | undefined;

  public constructor(options: InMemoryStorageOptions = {}) {
    this.#audit = options.audit;
  }

  public initialize(): void {}

  public ensureRoom(roomId: string, now: number): StoredRoom {
    const existing = this.#rooms.get(roomId);
    if (existing !== undefined) {
      return existing;
    }
    const room: StoredRoom = {
      roomId,
      roomEpoch: 1,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
    };
    this.#rooms.set(roomId, room);
    return room;
  }

  public getRoom(roomId: string): StoredRoom | undefined {
    return this.#rooms.get(roomId);
  }

  public putRoom(room: StoredRoom): void {
    this.#rooms.set(room.roomId, room);
  }

  public putSession(session: StoredSession): void {
    this.#sessions.set(sessionKey(session.roomId, session.playerId), session);
  }

  public getSession(roomId: string, playerId: string): StoredSession | undefined {
    return this.#sessions.get(sessionKey(roomId, playerId));
  }

  public listSessions(roomId: string): readonly StoredSession[] {
    return [...this.#sessions.values()]
      .filter((session) => session.roomId === roomId)
      .sort((left, right) => left.joinedAt - right.joinedAt);
  }

  public deleteSession(roomId: string, playerId: string): void {
    this.#sessions.delete(sessionKey(roomId, playerId));
  }

  public findCanonicalByIdempotency(
    roomId: string,
    roomEpoch: number,
    idempotencyScope: string,
    key: string,
  ): CanonicalEvent | undefined {
    return this.#idempotency.get(
      [roomId, String(roomEpoch), idempotencyScope, key].join("\u0000"),
    );
  }

  public commitCanonical(commit: CanonicalCommit): CanonicalCommitResult {
    const duplicate = this.#idempotency.get(idempotencyKey(commit));
    if (duplicate !== undefined) {
      return { event: duplicate, duplicate: true };
    }

    const room = this.#rooms.get(commit.roomId);
    if (room === undefined) {
      throw new Error(`room ${commit.roomId} does not exist`);
    }
    if (room.roomEpoch !== commit.roomEpoch) {
      throw new Error("room epoch changed during canonical commit");
    }

    const sequence = room.lastSequence + 1;
    const event = createEvent(commit, sequence);
    const roomUpdate = commit.roomUpdate;
    const updatedRoom: StoredRoom = {
      ...room,
      status: roomUpdate?.status ?? room.status,
      updatedAt: roomUpdate?.updatedAt ?? commit.createdAt,
      lastSequence: sequence,
      ...(roomUpdate?.startAt === undefined
        ? room.startAt === undefined
          ? {}
          : { startAt: room.startAt }
        : { startAt: roomUpdate.startAt }),
    };

    const key = roomKey(commit.roomId, commit.roomEpoch);
    const events = this.#events.get(key) ?? [];
    events.push(event);
    if (events.length > commit.eventLogCapacity) {
      events.splice(0, events.length - commit.eventLogCapacity);
    }

    this.#events.set(key, events);
    this.#rooms.set(commit.roomId, updatedRoom);
    this.#idempotency.set(idempotencyKey(commit), event);
    this.#audit?.push(`persist:${event.sequence}:${event.kind}`);
    return { event, duplicate: false };
  }

  public readCanonical(
    roomId: string,
    roomEpoch: number,
    afterSequence: number,
    limit = Number.POSITIVE_INFINITY,
  ): CanonicalRange {
    const events = this.#events.get(roomKey(roomId, roomEpoch)) ?? [];
    const room = this.#rooms.get(roomId);
    return {
      events: events.filter((event) => event.sequence > afterSequence).slice(0, limit),
      oldestSequence: events[0]?.sequence,
      latestSequence: room?.roomEpoch === roomEpoch ? room.lastSequence : 0,
    };
  }

  public consumeRateLimit(request: RateLimitRequest): RateLimitResult {
    const cost = request.cost ?? 1;
    const key = `${request.roomId}\u0000${request.key}`;
    const previous = this.#buckets.get(key) ?? {
      tokens: request.policy.capacity,
      lastRefillAt: request.now,
    };
    const elapsedSeconds = Math.max(0, request.now - previous.lastRefillAt) / 1_000;
    const tokens = Math.min(
      request.policy.capacity,
      previous.tokens + elapsedSeconds * request.policy.refillPerSecond,
    );

    if (tokens >= cost) {
      const remaining = tokens - cost;
      this.#buckets.set(key, { tokens: remaining, lastRefillAt: request.now });
      return { allowed: true, remaining };
    }

    this.#buckets.set(key, { tokens, lastRefillAt: request.now });
    const retryAfterMs = Math.ceil(
      ((cost - tokens) / request.policy.refillPerSecond) * 1_000,
    );
    return { allowed: false, retryAfterMs, remaining: tokens };
  }
}

interface ConnectionRecord {
  readonly roomId: string;
  readonly playerId: string;
  readonly messages: RoomSignal[];
}

export interface InMemoryBroadcasterOptions {
  readonly audit?: string[];
}

/** Captures messages per logical connection while preserving the production port. */
export class InMemoryBroadcaster implements RoomBroadcaster {
  readonly #connections = new Map<string, ConnectionRecord>();
  readonly #audit: string[] | undefined;

  public constructor(options: InMemoryBroadcasterOptions = {}) {
    this.#audit = options.audit;
  }

  public attach(connectionId: string, roomId: string, playerId: string): void {
    this.#connections.set(connectionId, { roomId, playerId, messages: [] });
  }

  public detach(connectionId: string): void {
    this.#connections.delete(connectionId);
  }

  public messages(connectionId: string): readonly RoomSignal[] {
    return this.#connections.get(connectionId)?.messages ?? [];
  }

  public drain(connectionId: string): readonly RoomSignal[] {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      return [];
    }
    return connection.messages.splice(0, connection.messages.length);
  }

  public send(connectionId: string, signal: RoomSignal): void {
    this.#connections.get(connectionId)?.messages.push(signal);
    this.#record(signal);
  }

  public sendToPlayer(roomId: string, playerId: string, signal: RoomSignal): void {
    for (const connection of this.#connections.values()) {
      if (connection.roomId === roomId && connection.playerId === playerId) {
        connection.messages.push(signal);
      }
    }
    this.#record(signal);
  }

  public broadcast(roomId: string, signal: RoomSignal, options: BroadcastOptions = {}): void {
    const players = options.playerIds === undefined ? undefined : new Set(options.playerIds);
    for (const [connectionId, connection] of this.#connections) {
      if (
        connection.roomId === roomId &&
        connectionId !== options.exceptConnectionId &&
        (players === undefined || players.has(connection.playerId))
      ) {
        connection.messages.push(signal);
      }
    }
    this.#record(signal);
  }

  #record(signal: RoomSignal): void {
    if (signal.type === "canonical") {
      this.#audit?.push(`broadcast:${signal.event.sequence}:${signal.event.kind}`);
    }
  }
}
