import type { JsonValue } from "@relayplay/core";
import type {
  CanonicalCommit,
  CanonicalCommitResult,
  CanonicalEvent,
  CanonicalRange,
  RateLimitRequest,
  RateLimitResult,
  RoomStorage,
  StoredRoom,
  StoredSession,
} from "@relayplay/server";

import { RelayPlaySqliteDatabase } from "./database.js";

type Row = Record<string, unknown>;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const ROOM_STATUSES = new Set<StoredRoom["status"]>([
  "waiting",
  "scheduled",
  "running",
  "finished",
]);

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`SQLite column ${key} is not text`);
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SQLite column ${key} is not numeric`);
  }
  return value;
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SQLite column ${key} is not nullable numeric data`);
  }
  return value;
}

function requiredInteger(row: Row, key: string, minimum = 0): number {
  const value = requiredNumber(row, key);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`SQLite column ${key} is not a supported integer`);
  }
  return value;
}

function requiredBoolean(row: Row, key: string): boolean {
  const value = requiredInteger(row, key);
  if (value !== 0 && value !== 1) {
    throw new Error(`SQLite column ${key} is not a boolean`);
  }
  return value === 1;
}

function parseJson<Value>(encoded: string): Value {
  return JSON.parse(encoded) as Value;
}

function parseIdentifierArray(encoded: string, label: string): readonly string[] {
  const value = parseJson<unknown>(encoded);
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some((identifier) =>
      typeof identifier !== "string" || !IDENTIFIER_PATTERN.test(identifier)
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`SQLite ${label} is not a valid player identifier array`);
  }
  return value as readonly string[];
}

function encodedRosters(
  participantIds: readonly string[] | undefined,
  completedPlayerIds: readonly string[] | undefined,
): readonly [string | null, string | null] {
  const participants = participantIds === undefined
    ? undefined
    : parseIdentifierArray(JSON.stringify(participantIds), "participant roster");
  const completed = completedPlayerIds === undefined
    ? undefined
    : parseIdentifierArray(JSON.stringify(completedPlayerIds), "completed-player roster");
  if (
    completed !== undefined &&
    (participants === undefined || completed.some((playerId) => !participants.includes(playerId)))
  ) {
    throw new Error("completed-player roster must be a subset of the participant roster");
  }
  return [
    participants === undefined ? null : JSON.stringify(participants),
    completed === undefined ? null : JSON.stringify(completed),
  ];
}

function roomFromRow(row: Row): StoredRoom {
  const rawStatus = requiredString(row, "status");
  if (!ROOM_STATUSES.has(rawStatus as StoredRoom["status"])) {
    throw new Error("SQLite room status is invalid");
  }
  const status = rawStatus as StoredRoom["status"];
  const startAt = optionalNumber(row, "start_at");
  const rawParticipantIds = row["participant_ids_json"];
  const rawCompletedPlayerIds = row["completed_player_ids_json"];
  if (
    rawParticipantIds !== null &&
    rawParticipantIds !== undefined &&
    typeof rawParticipantIds !== "string"
  ) {
    throw new Error("SQLite participant roster column is invalid");
  }
  if (
    rawCompletedPlayerIds !== null &&
    rawCompletedPlayerIds !== undefined &&
    typeof rawCompletedPlayerIds !== "string"
  ) {
    throw new Error("SQLite completed-player roster column is invalid");
  }
  const participantIds = typeof rawParticipantIds === "string"
    ? parseIdentifierArray(rawParticipantIds, "participant roster")
    : undefined;
  const completedPlayerIds = typeof rawCompletedPlayerIds === "string"
    ? parseIdentifierArray(rawCompletedPlayerIds, "completed-player roster")
    : undefined;
  if (
    completedPlayerIds !== undefined &&
    (participantIds === undefined ||
      completedPlayerIds.some((playerId) => !participantIds.includes(playerId)))
  ) {
    throw new Error("SQLite completed-player roster is not a participant subset");
  }
  return {
    roomId: requiredString(row, "room_id"),
    roomEpoch: requiredInteger(row, "room_epoch", 1),
    status,
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
    ...(startAt === undefined ? {} : { startAt }),
    lastSequence: requiredInteger(row, "last_sequence"),
    ...(participantIds === undefined ? {} : { participantIds }),
    ...(completedPlayerIds === undefined ? {} : { completedPlayerIds }),
  };
}

function sessionFromRow(row: Row): StoredSession {
  const disconnectedAt = optionalNumber(row, "disconnected_at");
  return {
    roomId: requiredString(row, "room_id"),
    playerId: requiredString(row, "player_id"),
    sessionId: requiredString(row, "session_id"),
    resumeEpoch: requiredInteger(row, "resume_epoch", 1),
    connectionId: requiredString(row, "connection_id"),
    ready: requiredBoolean(row, "ready"),
    connected: requiredBoolean(row, "connected"),
    joinedAt: requiredNumber(row, "joined_at"),
    lastSeenAt: requiredNumber(row, "last_seen_at"),
    ...(disconnectedAt === undefined ? {} : { disconnectedAt }),
    lastAcknowledgedSequence: requiredInteger(row, "last_ack_sequence"),
    lastProgressSequence: requiredInteger(row, "last_progress_sequence", -1),
    roles: parseJson<readonly string[]>(requiredString(row, "roles_json")),
    metadata: parseJson<Readonly<Record<string, JsonValue>>>(
      requiredString(row, "metadata_json"),
    ),
  };
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

function sessionColumns(): string {
  return `room_id, player_id, session_id, resume_epoch, connection_id, ready,
          connected, joined_at, last_seen_at, disconnected_at, last_ack_sequence,
          last_progress_sequence, roles_json, metadata_json`;
}

/** Durable single-process RoomStorage backed by Node's built-in SQLite. */
export class SqliteRoomStorage implements RoomStorage {
  readonly #database: RelayPlaySqliteDatabase;

  public constructor(database: RelayPlaySqliteDatabase) {
    this.#database = database;
  }

  public initialize(): void {}

  public ensureRoom(roomId: string, now: number): StoredRoom {
    this.#database.connection
      .prepare(
        `INSERT INTO relayplay_rooms
         (room_id, room_epoch, status, created_at, updated_at, start_at, last_sequence)
         VALUES (?, 1, 'waiting', ?, ?, NULL, 0)
         ON CONFLICT(room_id) DO NOTHING`,
      )
      .run(roomId, now, now);
    const room = this.getRoom(roomId);
    if (room === undefined) throw new Error("failed to create room");
    return room;
  }

  public getRoom(roomId: string): StoredRoom | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT room_id, room_epoch, status, created_at, updated_at, start_at, last_sequence,
                participant_ids_json, completed_player_ids_json
         FROM relayplay_rooms WHERE room_id = ?`,
      )
      .get(roomId);
    return row === undefined ? undefined : roomFromRow(row);
  }

  public putRoom(room: StoredRoom): void {
    const [participantIds, completedPlayerIds] = encodedRosters(
      room.participantIds,
      room.completedPlayerIds,
    );
    const result = this.#database.connection
      .prepare(
        `UPDATE relayplay_rooms
         SET room_epoch = ?, status = ?, created_at = ?, updated_at = ?,
             start_at = ?, last_sequence = ?, participant_ids_json = ?,
             completed_player_ids_json = ?
         WHERE room_id = ?`,
      )
      .run(
        room.roomEpoch,
        room.status,
        room.createdAt,
        room.updatedAt,
        room.startAt ?? null,
        room.lastSequence,
        participantIds,
        completedPlayerIds,
        room.roomId,
      );
    if (result.changes !== 1) throw new Error(`room ${room.roomId} does not exist`);
  }

  public putSession(session: StoredSession): void {
    this.#database.connection
      .prepare(
        `INSERT INTO relayplay_sessions
         (${sessionColumns()}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      )
      .run(
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
    const row = this.#database.connection
      .prepare(`SELECT ${sessionColumns()} FROM relayplay_sessions WHERE room_id = ? AND player_id = ?`)
      .get(roomId, playerId);
    return row === undefined ? undefined : sessionFromRow(row);
  }

  public listSessions(roomId: string): readonly StoredSession[] {
    return this.#database.connection
      .prepare(
        `SELECT ${sessionColumns()} FROM relayplay_sessions
         WHERE room_id = ? ORDER BY joined_at, player_id`,
      )
      .all(roomId)
      .map(sessionFromRow);
  }

  public deleteSession(roomId: string, playerId: string): void {
    this.#database.connection
      .prepare("DELETE FROM relayplay_sessions WHERE room_id = ? AND player_id = ?")
      .run(roomId, playerId);
  }

  public findCanonicalByIdempotency(
    roomId: string,
    roomEpoch: number,
    idempotencyScope: string,
    idempotencyKey: string,
  ): CanonicalEvent | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT event_json FROM relayplay_idempotency
         WHERE room_id = ? AND room_epoch = ?
           AND idempotency_scope = ? AND idempotency_key = ?`,
      )
      .get(roomId, roomEpoch, idempotencyScope, idempotencyKey);
    return row === undefined
      ? undefined
      : parseJson<CanonicalEvent>(requiredString(row, "event_json"));
  }

  public commitCanonical(commit: CanonicalCommit): CanonicalCommitResult {
    return this.#database.transaction(() => {
      const previous = this.findCanonicalByIdempotency(
        commit.roomId,
        commit.roomEpoch,
        commit.idempotencyScope,
        commit.idempotencyKey,
      );
      if (previous !== undefined) return { event: previous, duplicate: true };

      const room = this.getRoom(commit.roomId);
      if (room === undefined) throw new Error(`room ${commit.roomId} does not exist`);
      if (room.roomEpoch !== commit.roomEpoch) {
        throw new Error("room epoch changed during canonical commit");
      }
      const sequence = room.lastSequence + 1;
      const event = eventFromCommit(commit, sequence);
      const encoded = JSON.stringify(event);
      const status = commit.roomUpdate?.status ?? room.status;
      const updatedAt = commit.roomUpdate?.updatedAt ?? commit.createdAt;
      const startAt = commit.roomUpdate?.startAt ?? room.startAt ?? null;
      const participantIds = commit.roomUpdate?.participantIds ?? room.participantIds;
      const completedPlayerIds = commit.roomUpdate?.completedPlayerIds ?? room.completedPlayerIds;
      const [encodedParticipantIds, encodedCompletedPlayerIds] = encodedRosters(
        participantIds,
        completedPlayerIds,
      );

      this.#database.connection
        .prepare(
          `INSERT INTO relayplay_events
           (room_id, room_epoch, sequence, event_id, kind, event_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commit.roomId,
          commit.roomEpoch,
          sequence,
          commit.eventId,
          commit.kind,
          encoded,
          commit.createdAt,
        );
      this.#database.connection
        .prepare(
          `INSERT INTO relayplay_idempotency
           (room_id, room_epoch, idempotency_scope, idempotency_key, sequence, event_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commit.roomId,
          commit.roomEpoch,
          commit.idempotencyScope,
          commit.idempotencyKey,
          sequence,
          encoded,
        );
      const update = this.#database.connection
        .prepare(
          `UPDATE relayplay_rooms
           SET status = ?, updated_at = ?, start_at = ?, last_sequence = ?,
               participant_ids_json = ?, completed_player_ids_json = ?
           WHERE room_id = ? AND room_epoch = ? AND last_sequence = ?`,
        )
        .run(
          status,
          updatedAt,
          startAt,
          sequence,
          encodedParticipantIds,
          encodedCompletedPlayerIds,
          commit.roomId,
          commit.roomEpoch,
          room.lastSequence,
        );
      if (update.changes !== 1) throw new Error("canonical sequence allocation raced");

      const cutoff = sequence - commit.eventLogCapacity;
      this.#database.connection
        .prepare(
          `DELETE FROM relayplay_events
           WHERE room_id = ? AND room_epoch = ? AND sequence <= ?`,
        )
        .run(commit.roomId, commit.roomEpoch, cutoff);
      this.#database.connection
        .prepare(
          `DELETE FROM relayplay_idempotency
           WHERE room_id = ? AND room_epoch = ? AND sequence <= ?`,
        )
        .run(commit.roomId, commit.roomEpoch, cutoff);
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
    const events = this.#database.connection
      .prepare(
        `SELECT event_json FROM relayplay_events
         WHERE room_id = ? AND room_epoch = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`,
      )
      .all(roomId, roomEpoch, afterSequence, boundedLimit)
      .map((row) => parseJson<CanonicalEvent>(requiredString(row, "event_json")));
    const oldest = this.#database.connection
      .prepare(
        `SELECT MIN(sequence) AS oldest_sequence FROM relayplay_events
         WHERE room_id = ? AND room_epoch = ?`,
      )
      .get(roomId, roomEpoch);
    const room = this.getRoom(roomId);
    return {
      events,
      oldestSequence: oldest === undefined
        ? undefined
        : optionalNumber(oldest, "oldest_sequence"),
      latestSequence: room?.roomEpoch === roomEpoch ? room.lastSequence : 0,
    };
  }

  public consumeRateLimit(request: RateLimitRequest): RateLimitResult {
    return this.#database.transaction(() => {
      const row = this.#database.connection
        .prepare(
          `SELECT tokens, last_refill_at FROM relayplay_rate_limits
           WHERE room_id = ? AND rate_key = ?`,
        )
        .get(request.roomId, request.key);
      const previousTokens = row === undefined
        ? request.policy.capacity
        : requiredNumber(row, "tokens");
      const previousRefillAt = row === undefined
        ? request.now
        : requiredNumber(row, "last_refill_at");
      const elapsedSeconds = Math.max(0, request.now - previousRefillAt) / 1_000;
      const tokens = Math.min(
        request.policy.capacity,
        previousTokens + elapsedSeconds * request.policy.refillPerSecond,
      );
      const cost = request.cost ?? 1;
      const allowed = tokens >= cost;
      const remaining = allowed ? tokens - cost : tokens;
      this.#database.connection
        .prepare(
          `INSERT INTO relayplay_rate_limits (room_id, rate_key, tokens, last_refill_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(room_id, rate_key) DO UPDATE SET
             tokens = excluded.tokens, last_refill_at = excluded.last_refill_at`,
        )
        .run(request.roomId, request.key, remaining, request.now);
      if (allowed) return { allowed: true, remaining };
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
