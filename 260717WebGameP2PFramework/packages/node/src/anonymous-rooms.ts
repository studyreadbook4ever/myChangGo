import { createHash, randomBytes } from "node:crypto";
import type { AuthRequest, AuthResult } from "@relayplay/server";

import { RelayPlaySqliteDatabase } from "./database.js";
import { SqliteRoomStorage } from "./sqlite-storage.js";

type Row = Record<string, unknown>;

function opaqueId(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`credential column ${key} is invalid`);
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`credential column ${key} is invalid`);
  }
  return value;
}

export interface AnonymousRoomServiceOptions {
  readonly maxPlayers: number;
  readonly maxRooms?: number;
  readonly roomTtlMs?: number;
  readonly credentialTtlMs?: number;
}

export interface AnonymousGuestAccess {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly credential: string;
  readonly credentialExpiresAt: number;
  readonly role: "host" | "player";
}

export interface CreatedAnonymousRoom extends AnonymousGuestAccess {
  readonly invite: string;
  readonly roomExpiresAt: number;
}

export interface AuthenticatedGuest {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly role: "host" | "player";
  readonly expiresAt: number;
}

export class AnonymousRoomError extends Error {
  public constructor(
    readonly code:
      | "INVITE_INVALID"
      | "ROOM_FULL"
      | "ROOM_LIMIT"
      | "ROOM_UNAVAILABLE"
      | "CREDENTIAL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "AnonymousRoomError";
  }
}

/**
 * Signup-free control plane. Invite and guest secrets are capabilities; only
 * SHA-256 digests are persisted, and the raw guest secret is returned once.
 */
export class AnonymousRoomService {
  readonly #database: RelayPlaySqliteDatabase;
  readonly #storage: SqliteRoomStorage;
  readonly #maxPlayers: number;
  readonly #maxRooms: number;
  readonly #roomTtlMs: number;
  readonly #credentialTtlMs: number;

  public constructor(
    database: RelayPlaySqliteDatabase,
    storage: SqliteRoomStorage,
    options: AnonymousRoomServiceOptions,
  ) {
    if (!Number.isSafeInteger(options.maxPlayers) || options.maxPlayers < 1 || options.maxPlayers > 4) {
      throw new RangeError("anonymous rooms support one to four players");
    }
    this.#database = database;
    this.#storage = storage;
    this.#maxPlayers = options.maxPlayers;
    this.#maxRooms = options.maxRooms ?? 1_000;
    this.#roomTtlMs = options.roomTtlMs ?? 24 * 60 * 60 * 1_000;
    this.#credentialTtlMs = options.credentialTtlMs ?? 12 * 60 * 60 * 1_000;
  }

  public createRoom(): CreatedAnonymousRoom {
    const now = this.#database.now();
    return this.#database.transaction(() => {
      const active = this.#database.connection
        .prepare("SELECT COUNT(*) AS count FROM relayplay_anonymous_rooms WHERE expires_at > ?")
        .get(now)?.["count"];
      if (typeof active !== "number" || active >= this.#maxRooms) {
        throw new AnonymousRoomError("ROOM_LIMIT", "active room limit reached");
      }

      const roomId = opaqueId("room");
      const invite = secret(24);
      const roomExpiresAt = now + this.#roomTtlMs;
      this.#storage.ensureRoom(roomId, now);
      this.#database.connection
        .prepare(
          `INSERT INTO relayplay_anonymous_rooms
           (room_id, invite_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        )
        .run(roomId, digest(invite), now, roomExpiresAt);
      const guest = this.#issueGuest(roomId, "host", now, roomExpiresAt);
      return { ...guest, invite, roomExpiresAt };
    });
  }

  public joinRoom(invite: string): AnonymousGuestAccess {
    if (typeof invite !== "string" || invite.length < 24 || invite.length > 128) {
      throw new AnonymousRoomError("INVITE_INVALID", "invite is invalid or expired");
    }
    const now = this.#database.now();
    return this.#database.transaction(() => {
      const row = this.#database.connection
        .prepare(
          `SELECT r.room_id, r.expires_at, room.status
           FROM relayplay_anonymous_rooms AS r
           JOIN relayplay_rooms AS room ON room.room_id = r.room_id
           WHERE r.invite_hash = ? AND r.expires_at > ?`,
        )
        .get(digest(invite), now);
      if (row === undefined) {
        throw new AnonymousRoomError("INVITE_INVALID", "invite is invalid or expired");
      }
      if (text(row, "status") !== "waiting") {
        throw new AnonymousRoomError("ROOM_UNAVAILABLE", "room has already started");
      }
      const roomId = text(row, "room_id");
      const issued = this.#database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM relayplay_guest_credentials
           WHERE room_id = ? AND expires_at > ? AND revoked_at IS NULL`,
        )
        .get(roomId, now)?.["count"];
      if (typeof issued !== "number" || issued >= this.#maxPlayers) {
        throw new AnonymousRoomError("ROOM_FULL", "room has reached its four-player limit");
      }
      return this.#issueGuest(roomId, "player", now, number(row, "expires_at"));
    });
  }

  public authenticate(credential: string | undefined): AuthenticatedGuest {
    if (credential === undefined || credential.length < 32 || credential.length > 256) {
      throw new AnonymousRoomError("CREDENTIAL_INVALID", "guest credential is missing or invalid");
    }
    const now = this.#database.now();
    const row = this.#database.connection
      .prepare(
        `SELECT room_id, player_id, session_id, role, expires_at
         FROM relayplay_guest_credentials
         WHERE credential_hash = ? AND expires_at > ? AND revoked_at IS NULL`,
      )
      .get(digest(credential), now);
    if (row === undefined) {
      throw new AnonymousRoomError("CREDENTIAL_INVALID", "guest credential is missing or invalid");
    }
    const role = text(row, "role");
    if (role !== "host" && role !== "player") throw new Error("stored guest role is invalid");
    return {
      roomId: text(row, "room_id"),
      playerId: text(row, "player_id"),
      sessionId: text(row, "session_id"),
      role,
      expiresAt: number(row, "expires_at"),
    };
  }

  public authenticateRoomRequest(request: AuthRequest): AuthResult {
    const credential = typeof request.credential === "string" ? request.credential : undefined;
    const guest = this.authenticate(credential);
    if (
      guest.roomId !== request.roomId ||
      (request.requestedPlayerId !== undefined && request.requestedPlayerId !== guest.playerId) ||
      (request.requestedSessionId !== undefined && request.requestedSessionId !== guest.sessionId)
    ) {
      throw new AnonymousRoomError("CREDENTIAL_INVALID", "credential is not bound to this room session");
    }
    return {
      playerId: guest.playerId,
      sessionId: guest.sessionId,
      roles: [guest.role],
      metadata: { authentication: "anonymous-cookie" },
    };
  }

  public revoke(credential: string): boolean {
    const result = this.#database.connection
      .prepare(
        `UPDATE relayplay_guest_credentials SET revoked_at = ?
         WHERE credential_hash = ? AND revoked_at IS NULL`,
      )
      .run(this.#database.now(), digest(credential));
    return result.changes === 1;
  }

  #issueGuest(
    roomId: string,
    role: "host" | "player",
    now: number,
    roomExpiresAt: number,
  ): AnonymousGuestAccess {
    const playerId = opaqueId("player");
    const sessionId = opaqueId("session");
    const credential = secret();
    const credentialExpiresAt = Math.min(roomExpiresAt, now + this.#credentialTtlMs);
    this.#database.connection
      .prepare(
        `INSERT INTO relayplay_guest_credentials
         (credential_hash, room_id, player_id, session_id, role, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        digest(credential),
        roomId,
        playerId,
        sessionId,
        role,
        now,
        credentialExpiresAt,
      );
    return {
      roomId,
      playerId,
      sessionId,
      credential,
      credentialExpiresAt,
      role,
    };
  }
}
