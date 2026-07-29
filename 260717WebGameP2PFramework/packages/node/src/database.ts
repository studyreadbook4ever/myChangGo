import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS relayplay_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

const SCHEMA = `
${META_SCHEMA}

CREATE TABLE IF NOT EXISTS relayplay_rooms (
  room_id TEXT PRIMARY KEY,
  room_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  start_at REAL,
  last_sequence INTEGER NOT NULL,
  participant_ids_json TEXT,
  completed_player_ids_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS relayplay_sessions (
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  resume_epoch INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  ready INTEGER NOT NULL,
  connected INTEGER NOT NULL,
  joined_at REAL NOT NULL,
  last_seen_at REAL NOT NULL,
  disconnected_at REAL,
  last_ack_sequence INTEGER NOT NULL,
  last_progress_sequence INTEGER NOT NULL,
  roles_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (room_id, player_id),
  UNIQUE (room_id, session_id),
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS relayplay_sessions_room_joined
  ON relayplay_sessions(room_id, joined_at, player_id);

CREATE TABLE IF NOT EXISTS relayplay_events (
  room_id TEXT NOT NULL,
  room_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (room_id, room_epoch, sequence),
  UNIQUE (room_id, room_epoch, event_id),
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS relayplay_idempotency (
  room_id TEXT NOT NULL,
  room_epoch INTEGER NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (room_id, room_epoch, idempotency_scope, idempotency_key),
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS relayplay_idempotency_sequence
  ON relayplay_idempotency(room_id, room_epoch, sequence);

CREATE TABLE IF NOT EXISTS relayplay_rate_limits (
  room_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  tokens REAL NOT NULL,
  last_refill_at REAL NOT NULL,
  PRIMARY KEY (room_id, rate_key),
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS relayplay_anonymous_rooms (
  room_id TEXT PRIMARY KEY,
  invite_hash TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS relayplay_anonymous_rooms_expiry
  ON relayplay_anonymous_rooms(expires_at);

CREATE TABLE IF NOT EXISTS relayplay_guest_credentials (
  credential_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  revoked_at REAL,
  UNIQUE (room_id, player_id),
  UNIQUE (room_id, session_id),
  FOREIGN KEY (room_id) REFERENCES relayplay_rooms(room_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS relayplay_guest_credentials_room
  ON relayplay_guest_credentials(room_id, expires_at, revoked_at);
`;

export interface SqliteDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Owns the SQLite connection and schema. Higher-level repositories receive this
 * narrow transaction boundary instead of importing each other.
 */
export class RelayPlaySqliteDatabase {
  readonly connection: DatabaseSync;
  readonly #now: () => number;
  #closed = false;

  public constructor(options: SqliteDatabaseOptions) {
    if (
      typeof options.path !== "string" ||
      options.path.length === 0 ||
      options.path.includes("\u0000")
    ) {
      throw new TypeError("SQLite path must not be empty");
    }
    if (
      options.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0)
    ) {
      throw new RangeError("SQLite busy timeout must be a non-negative integer");
    }
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o750 });
    }
    this.#now = options.now ?? Date.now;
    this.connection = new DatabaseSync(options.path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: options.busyTimeoutMs ?? 5_000,
    });
    try {
      this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec("PRAGMA synchronous = FULL");
      this.connection.exec("PRAGMA foreign_keys = ON");
      this.connection.exec("PRAGMA trusted_schema = OFF");
      this.#initializeSchema();
    } catch (error) {
      this.connection.close();
      this.#closed = true;
      throw error;
    }
  }

  public now(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("database clock returned an invalid time");
    }
    return value;
  }

  public transaction<Value>(operation: () => Value): Value {
    this.#assertOpen();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.connection.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  }

  public reconcileOpenSessions(): readonly string[] {
    const now = this.now();
    return this.transaction(() => {
      const rows = this.connection
        .prepare("SELECT DISTINCT room_id FROM relayplay_sessions WHERE connected = 1")
        .all();
      this.connection
        .prepare(
          `UPDATE relayplay_sessions
           SET connected = 0, disconnected_at = ?, last_seen_at = ?
           WHERE connected = 1`,
        )
        .run(now, now);
      return rows.flatMap((row) =>
        typeof row["room_id"] === "string" ? [row["room_id"]] : [],
      );
    });
  }

  public listRoomIds(): readonly string[] {
    this.#assertOpen();
    return this.connection
      .prepare("SELECT room_id FROM relayplay_rooms ORDER BY created_at")
      .all()
      .flatMap((row) => (typeof row["room_id"] === "string" ? [row["room_id"]] : []));
  }

  public cleanup(now: number, idleRateLimitMs = 3_600_000): number {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("cleanup time must be finite and non-negative");
    }
    return this.transaction(() => {
      this.connection
        .prepare("DELETE FROM relayplay_rate_limits WHERE last_refill_at < ?")
        .run(now - idleRateLimitMs);
      this.connection
        .prepare("DELETE FROM relayplay_guest_credentials WHERE expires_at <= ? OR revoked_at IS NOT NULL")
        .run(now);
      const result = this.connection
        .prepare(
          `DELETE FROM relayplay_rooms
           WHERE room_id IN (
             SELECT room_id FROM relayplay_anonymous_rooms WHERE expires_at <= ?
           )`,
        )
        .run(now);
      return Number(result.changes);
    });
  }

  public ping(): boolean {
    if (this.#closed) return false;
    try {
      return this.connection.prepare("SELECT 1 AS ok").get()?.["ok"] === 1;
    } catch {
      return false;
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.connection.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite database is closed");
    }
  }

  #initializeSchema(): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(META_SCHEMA);
      const row = this.connection
        .prepare("SELECT value FROM relayplay_meta WHERE key = 'schema_version'")
        .get();
      if (row === undefined) {
        const existing = this.connection
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_schema
             WHERE type = 'table' AND name GLOB 'relayplay_*'
               AND name <> 'relayplay_meta'`,
          )
          .get()?.["count"];
        if (typeof existing !== "number" || existing !== 0) {
          throw new Error("refusing to adopt an unversioned RelayPlay SQLite schema");
        }
        this.connection.exec(SCHEMA);
        this.connection
          .prepare("INSERT INTO relayplay_meta (key, value) VALUES ('schema_version', ?)")
          .run(String(SCHEMA_VERSION));
      } else {
        const storedVersion = row["value"];
        if (storedVersion !== String(SCHEMA_VERSION)) {
          throw new Error(
            `unsupported RelayPlay SQLite schema version: ${String(storedVersion)}`,
          );
        }
        this.connection.exec(SCHEMA);
      }

      // Early draft databases used schema version 1 before these roster
      // columns were introduced. They are nullable and safe to add in place.
      const roomColumns = new Set(
        this.connection
          .prepare("PRAGMA table_info(relayplay_rooms)")
          .all()
          .flatMap((column) =>
            typeof column["name"] === "string" ? [column["name"]] : [],
          ),
      );
      if (!roomColumns.has("participant_ids_json")) {
        this.connection.exec(
          "ALTER TABLE relayplay_rooms ADD COLUMN participant_ids_json TEXT",
        );
      }
      if (!roomColumns.has("completed_player_ids_json")) {
        this.connection.exec(
          "ALTER TABLE relayplay_rooms ADD COLUMN completed_player_ids_json TEXT",
        );
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the schema validation or migration failure.
      }
      throw error;
    }
  }
}
