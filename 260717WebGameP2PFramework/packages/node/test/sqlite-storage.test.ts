import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnonymousRoomError,
  AnonymousRoomService,
  RelayPlaySqliteDatabase,
  SqliteRoomStorage,
} from "../src/index.js";

const directories: string[] = [];

function fileDatabase(now = 10_000): {
  readonly directory: string;
  readonly path: string;
  readonly database: RelayPlaySqliteDatabase;
  readonly storage: SqliteRoomStorage;
} {
  const directory = mkdtempSync(join(tmpdir(), "relayplay-node-test-"));
  directories.push(directory);
  const path = join(directory, "relayplay.sqlite");
  const database = new RelayPlaySqliteDatabase({ path, now: () => now });
  return { directory, path, database, storage: new SqliteRoomStorage(database) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteRoomStorage", () => {
  it("persists canonical ordering and idempotency across a process restart", () => {
    const { path, database, storage } = fileDatabase();
    storage.ensureRoom("room_persist_01", 10_000);
    const commit = {
      roomId: "room_persist_01",
      roomEpoch: 1,
      eventId: "event_persist_01",
      kind: "start" as const,
      createdAt: 10_000,
      payload: { seed: 7 },
      idempotencyScope: "room",
      idempotencyKey: "start:persist:01",
      eventLogCapacity: 8,
    };
    expect(storage.commitCanonical(commit)).toMatchObject({
      duplicate: false,
      event: { sequence: 1 },
    });
    database.close();

    const reopened = new RelayPlaySqliteDatabase({ path, now: () => 11_000 });
    const nextStorage = new SqliteRoomStorage(reopened);
    expect(nextStorage.commitCanonical({ ...commit, eventId: "event_other_02" })).toMatchObject({
      duplicate: true,
      event: { eventId: "event_persist_01", sequence: 1 },
    });
    expect(nextStorage.readCanonical("room_persist_01", 1, 0)).toMatchObject({
      latestSequence: 1,
      events: [{ sequence: 1, payload: { seed: 7 } }],
    });
    reopened.close();
  });

  it("bounds canonical and idempotency retention together", () => {
    const { database, storage } = fileDatabase();
    storage.ensureRoom("room_retention", 10_000);
    for (let index = 1; index <= 3; index += 1) {
      storage.commitCanonical({
        roomId: "room_retention",
        roomEpoch: 1,
        eventId: `event_keep_${String(index).padStart(2, "0")}`,
        kind: "interaction",
        createdAt: 10_000 + index,
        action: "pulse",
        payload: { index },
        idempotencyScope: "player_keep",
        idempotencyKey: `intent:keep:${String(index).padStart(2, "0")}`,
        eventLogCapacity: 2,
      });
    }
    expect(storage.readCanonical("room_retention", 1, 0).events.map((event) => event.sequence))
      .toEqual([2, 3]);
    expect(
      storage.findCanonicalByIdempotency(
        "room_retention",
        1,
        "player_keep",
        "intent:keep:01",
      ),
    ).toBeUndefined();
    database.close();
  });
});

describe("AnonymousRoomService", () => {
  it("issues room-bound hashed credentials and enforces the four-player cap", () => {
    const { path, database, storage } = fileDatabase();
    const service = new AnonymousRoomService(database, storage, { maxPlayers: 4 });
    const host = service.createRoom();
    const guests = [service.joinRoom(host.invite), service.joinRoom(host.invite), service.joinRoom(host.invite)];

    expect(host.invite).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(host.credential.length).toBeGreaterThanOrEqual(40);
    expect(new Set([host.playerId, ...guests.map((guest) => guest.playerId)]).size).toBe(4);
    expect(() => service.joinRoom(host.invite)).toThrowError(
      expect.objectContaining({ code: "ROOM_FULL" }) as AnonymousRoomError,
    );
    expect(service.authenticate(host.credential)).toMatchObject({
      roomId: host.roomId,
      playerId: host.playerId,
      sessionId: host.sessionId,
      role: "host",
    });
    expect(() => service.authenticate("not-a-real-credential-value-00000000")).toThrow();
    database.close();

    const file = readFileSync(path);
    expect(file.includes(Buffer.from(host.credential))).toBe(false);
    expect(file.includes(Buffer.from(host.invite))).toBe(false);
  });

  it("requires credentials to bind the requested room, player, and session", () => {
    const { database, storage } = fileDatabase();
    const service = new AnonymousRoomService(database, storage, { maxPlayers: 4 });
    const host = service.createRoom();
    expect(
      service.authenticateRoomRequest({
        roomId: host.roomId,
        credential: host.credential,
        connectionId: "connection_auth_01",
        requestedPlayerId: host.playerId,
        requestedSessionId: host.sessionId,
        metadata: {},
      }),
    ).toMatchObject({ playerId: host.playerId, sessionId: host.sessionId, roles: ["host"] });
    expect(() =>
      service.authenticateRoomRequest({
        roomId: host.roomId,
        credential: host.credential,
        connectionId: "connection_auth_02",
        requestedPlayerId: "player_attacker_01",
        metadata: {},
      }),
    ).toThrowError(/not bound/u);
    database.close();
  });
});
