import type { JsonValue } from "@relayplay/core";
import type {
  CanonicalCommit,
  CanonicalCommitResult,
  CanonicalEvent,
  CanonicalRange,
  EffectiveAt,
  RateLimitRequest,
  RateLimitResult,
  RoomStorage,
  StoredRoom,
  StoredSession,
} from "@relayplay/server";

type SqlValue = ArrayBuffer | string | number | null;
type SqlRow = Record<string, SqlValue>;

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`invalid persisted string column: ${key}`);
  }
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`invalid persisted numeric column: ${key}`);
  }
  return value;
}

function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`invalid persisted numeric column: ${key}`);
  }
  return value;
}

function parseJson<T>(encoded: string): T {
  return JSON.parse(encoded) as T;
}

function roomFromRow(row: SqlRow): StoredRoom {
  const startAt = optionalNumber(row, "start_at");
  return {
    roomId: requiredString(row, "room_id"),
    roomEpoch: requiredNumber(row, "room_epoch"),
    status: requiredString(row, "status") as StoredRoom["status"],
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
    ...(startAt === undefined ? {} : { startAt }),
    lastSequence: requiredNumber(row, "last_sequence"),
  };
}

function sessionFromRow(row: SqlRow): StoredSession {
  const disconnectedAt = optionalNumber(row, "disconnected_at");
  return {
    roomId: requiredString(row, "room_id"),
    playerId: requiredString(row, "player_id"),
    sessionId: requiredString(row, "session_id"),
    resumeEpoch: requiredNumber(row, "resume_epoch"),
    connectionId: requiredString(row, "connection_id"),
    ready: requiredNumber(row, "ready") === 1,
    connected: requiredNumber(row, "connected") === 1,
    joinedAt: requiredNumber(row, "joined_at"),
    lastSeenAt: requiredNumber(row, "last_seen_at"),
    ...(disconnectedAt === undefined ? {} : { disconnectedAt }),
    lastAcknowledgedSequence: requiredNumber(row, "last_ack_sequence"),
    lastProgressSequence: requiredNumber(row, "last_progress_sequence"),
    roles: parseJson<readonly string[]>(requiredString(row, "roles_json")),
    metadata: parseJson<Readonly<Record<string, JsonValue>>>(
      requiredString(row, "metadata_json"),
    ),
  };
}

function eventFromJson(encoded: string): CanonicalEvent {
  return parseJson<CanonicalEvent>(encoded);
}

function eventFromCommit(commit: CanonicalCommit, sequence: number): CanonicalEvent {
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

function roomRows(sql: SqlStorage, roomId: string): SqlRow[] {
  return sql
    .exec<SqlRow>(
      `SELECT room_id, room_epoch, status, created_at, updated_at, start_at, last_sequence
       FROM relayplay_rooms WHERE room_id = ?`,
      roomId,
    )
    .toArray();
}

/** SQLite-backed RoomStorage for a SQLite Durable Object class. */
export class CloudflareRoomStorage implements RoomStorage {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  public constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  public initialize(): void {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS relayplay_rooms (
        room_id TEXT PRIMARY KEY,
        room_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        start_at INTEGER,
        last_sequence INTEGER NOT NULL
      )
    `);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS relayplay_sessions (
        room_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resume_epoch INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        ready INTEGER NOT NULL,
        connected INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        disconnected_at INTEGER,
        last_ack_sequence INTEGER NOT NULL,
        last_progress_sequence INTEGER NOT NULL,
        roles_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (room_id, player_id)
      )
    `);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS relayplay_events (
        room_id TEXT NOT NULL,
        room_epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        PRIMARY KEY (room_id, room_epoch, sequence)
      )
    `);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS relayplay_idempotency (
        room_id TEXT NOT NULL,
        room_epoch INTEGER NOT NULL,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (room_id, room_epoch, idempotency_scope, idempotency_key)
      )
    `);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS relayplay_rate_limits (
        room_id TEXT NOT NULL,
        rate_key TEXT NOT NULL,
        tokens REAL NOT NULL,
        last_refill_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, rate_key)
      )
    `);
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS relayplay_events_lookup
       ON relayplay_events (room_id, room_epoch, sequence)`,
    );
  }

  public ensureRoom(roomId: string, now: number): StoredRoom {
    return this.#storage.transactionSync(() => {
      const existing = roomRows(this.#sql, roomId)[0];
      if (existing !== undefined) {
        return roomFromRow(existing);
      }
      this.#sql.exec(
        `INSERT INTO relayplay_rooms
         (room_id, room_epoch, status, created_at, updated_at, start_at, last_sequence)
         VALUES (?, 1, 'waiting', ?, ?, NULL, 0)`,
        roomId,
        now,
        now,
      );
      return {
        roomId,
        roomEpoch: 1,
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        lastSequence: 0,
      };
    });
  }

  public getRoom(roomId: string): StoredRoom | undefined {
    const row = roomRows(this.#sql, roomId)[0];
    return row === undefined ? undefined : roomFromRow(row);
  }

  public putRoom(room: StoredRoom): void {
    this.#sql.exec(
      `INSERT INTO relayplay_rooms
       (room_id, room_epoch, status, created_at, updated_at, start_at, last_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         room_epoch = excluded.room_epoch,
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         start_at = excluded.start_at,
         last_sequence = excluded.last_sequence`,
      room.roomId,
      room.roomEpoch,
      room.status,
      room.createdAt,
      room.updatedAt,
      room.startAt ?? null,
      room.lastSequence,
    );
  }

  public putSession(session: StoredSession): void {
    this.#sql.exec(
      `INSERT INTO relayplay_sessions
       (room_id, player_id, session_id, resume_epoch, connection_id, ready, connected,
        joined_at, last_seen_at, disconnected_at, last_ack_sequence, last_progress_sequence,
        roles_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, player_id) DO UPDATE SET
         session_id = excluded.session_id,
         resume_epoch = excluded.resume_epoch,
         connection_id = excluded.connection_id,
         ready = excluded.ready,
         connected = excluded.connected,
         joined_at = excluded.joined_at,
         last_seen_at = excluded.last_seen_at,
         disconnected_at = excluded.disconnected_at,
         last_ack_sequence = excluded.last_ack_sequence,
         last_progress_sequence = excluded.last_progress_sequence,
         roles_json = excluded.roles_json,
         metadata_json = excluded.metadata_json`,
      session.roomId,
      session.playerId,
      session.sessionId,
      session.resumeEpoch,
      session.connectionId,
      session.ready ? 1 : 0,
      session.connected ? 1 : 0,
      session.joinedAt,
      session.lastSeenAt,
      session.disconnectedAt ?? null,
      session.lastAcknowledgedSequence,
      session.lastProgressSequence,
      JSON.stringify(session.roles),
      JSON.stringify(session.metadata),
    );
  }

  public getSession(roomId: string, playerId: string): StoredSession | undefined {
    const row = this.#sql
      .exec<SqlRow>(
        `SELECT room_id, player_id, session_id, resume_epoch, connection_id, ready,
                connected, joined_at, last_seen_at, disconnected_at, last_ack_sequence,
                last_progress_sequence,
                roles_json, metadata_json
         FROM relayplay_sessions WHERE room_id = ? AND player_id = ?`,
        roomId,
        playerId,
      )
      .toArray()[0];
    return row === undefined ? undefined : sessionFromRow(row);
  }

  public listSessions(roomId: string): readonly StoredSession[] {
    return this.#sql
      .exec<SqlRow>(
        `SELECT room_id, player_id, session_id, resume_epoch, connection_id, ready,
                connected, joined_at, last_seen_at, disconnected_at, last_ack_sequence,
                last_progress_sequence,
                roles_json, metadata_json
         FROM relayplay_sessions WHERE room_id = ? ORDER BY joined_at, player_id`,
        roomId,
      )
      .toArray()
      .map(sessionFromRow);
  }

  public deleteSession(roomId: string, playerId: string): void {
    this.#sql.exec(
      "DELETE FROM relayplay_sessions WHERE room_id = ? AND player_id = ?",
      roomId,
      playerId,
    );
  }

  public findCanonicalByIdempotency(
    roomId: string,
    roomEpoch: number,
    idempotencyScope: string,
    idempotencyKey: string,
  ): CanonicalEvent | undefined {
    const row = this.#sql
      .exec<SqlRow>(
        `SELECT event_json FROM relayplay_idempotency
         WHERE room_id = ? AND room_epoch = ?
           AND idempotency_scope = ? AND idempotency_key = ?`,
        roomId,
        roomEpoch,
        idempotencyScope,
        idempotencyKey,
      )
      .toArray()[0];
    return row === undefined ? undefined : eventFromJson(requiredString(row, "event_json"));
  }

  public commitCanonical(commit: CanonicalCommit): CanonicalCommitResult {
    return this.#storage.transactionSync(() => {
      const previous = this.findCanonicalByIdempotency(
        commit.roomId,
        commit.roomEpoch,
        commit.idempotencyScope,
        commit.idempotencyKey,
      );
      if (previous !== undefined) {
        return { event: previous, duplicate: true };
      }

      const roomRow = roomRows(this.#sql, commit.roomId)[0];
      if (roomRow === undefined) {
        throw new Error(`room ${commit.roomId} does not exist`);
      }
      const room = roomFromRow(roomRow);
      if (room.roomEpoch !== commit.roomEpoch) {
        throw new Error("room epoch changed during canonical commit");
      }
      const sequence = room.lastSequence + 1;
      const event = eventFromCommit(commit, sequence);
      const encoded = JSON.stringify(event);
      const status = commit.roomUpdate?.status ?? room.status;
      const updatedAt = commit.roomUpdate?.updatedAt ?? commit.createdAt;
      const startAt = commit.roomUpdate?.startAt ?? room.startAt ?? null;

      this.#sql.exec(
        `INSERT INTO relayplay_events
         (room_id, room_epoch, sequence, event_id, event_json)
         VALUES (?, ?, ?, ?, ?)`,
        commit.roomId,
        commit.roomEpoch,
        sequence,
        commit.eventId,
        encoded,
      );
      this.#sql.exec(
        `INSERT INTO relayplay_idempotency
         (room_id, room_epoch, idempotency_scope, idempotency_key, sequence, event_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        commit.roomId,
        commit.roomEpoch,
        commit.idempotencyScope,
        commit.idempotencyKey,
        sequence,
        encoded,
      );
      this.#sql.exec(
        `UPDATE relayplay_rooms
         SET status = ?, updated_at = ?, start_at = ?, last_sequence = ?
         WHERE room_id = ? AND room_epoch = ?`,
        status,
        updatedAt,
        startAt,
        sequence,
        commit.roomId,
        commit.roomEpoch,
      );
      this.#sql.exec(
        `DELETE FROM relayplay_events
         WHERE room_id = ? AND room_epoch = ? AND sequence <= ?`,
        commit.roomId,
        commit.roomEpoch,
        sequence - commit.eventLogCapacity,
      );
      return { event, duplicate: false };
    });
  }

  public readCanonical(
    roomId: string,
    roomEpoch: number,
    afterSequence: number,
    limit = 2_147_483_647,
  ): CanonicalRange {
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, 2_147_483_647))
      : 2_147_483_647;
    const events = this.#sql
      .exec<SqlRow>(
        `SELECT event_json FROM relayplay_events
         WHERE room_id = ? AND room_epoch = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`,
        roomId,
        roomEpoch,
        afterSequence,
        boundedLimit,
      )
      .toArray()
      .map((row) => eventFromJson(requiredString(row, "event_json")));
    const oldestRow = this.#sql
      .exec<SqlRow>(
        `SELECT MIN(sequence) AS oldest_sequence FROM relayplay_events
         WHERE room_id = ? AND room_epoch = ?`,
        roomId,
        roomEpoch,
      )
      .toArray()[0];
    const oldestSequence =
      oldestRow === undefined ? undefined : optionalNumber(oldestRow, "oldest_sequence");
    const room = this.getRoom(roomId);
    return {
      events,
      oldestSequence,
      latestSequence: room?.roomEpoch === roomEpoch ? room.lastSequence : 0,
    };
  }

  public consumeRateLimit(request: RateLimitRequest): RateLimitResult {
    return this.#storage.transactionSync(() => {
      const row = this.#sql
        .exec<SqlRow>(
          `SELECT tokens, last_refill_at FROM relayplay_rate_limits
           WHERE room_id = ? AND rate_key = ?`,
          request.roomId,
          request.key,
        )
        .toArray()[0];
      const previousTokens =
        row === undefined ? request.policy.capacity : requiredNumber(row, "tokens");
      const previousRefillAt =
        row === undefined ? request.now : requiredNumber(row, "last_refill_at");
      const elapsedSeconds = Math.max(0, request.now - previousRefillAt) / 1_000;
      const tokens = Math.min(
        request.policy.capacity,
        previousTokens + elapsedSeconds * request.policy.refillPerSecond,
      );
      const cost = request.cost ?? 1;
      const allowed = tokens >= cost;
      const remaining = allowed ? tokens - cost : tokens;
      this.#sql.exec(
        `INSERT INTO relayplay_rate_limits (room_id, rate_key, tokens, last_refill_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, rate_key) DO UPDATE SET
           tokens = excluded.tokens,
           last_refill_at = excluded.last_refill_at`,
        request.roomId,
        request.key,
        remaining,
        request.now,
      );
      if (allowed) {
        return { allowed: true, remaining };
      }
      return {
        allowed: false,
        retryAfterMs: Math.ceil(
          ((cost - remaining) / request.policy.refillPerSecond) * 1_000,
        ),
        remaining,
      };
    });
  }
}

export type { EffectiveAt };
