import { describe, expect, it } from "vitest";

import type { CanonicalCommit, StoredRoom } from "@relayplay/server";

import { CloudflareRoomStorage } from "../src/storage.js";

type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;

interface SqlCall {
  readonly query: string;
  readonly bindings: readonly unknown[];
}

class FakeSql {
  readonly calls: SqlCall[] = [];
  readonly columns = new Set([
    "room_id",
    "room_epoch",
    "status",
    "created_at",
    "updated_at",
    "start_at",
    "last_sequence",
  ]);
  roomRow: Row | undefined;

  exec<T extends Row>(query: string, ...bindings: readonly unknown[]) {
    const normalized = query.replaceAll(/\s+/gu, " ").trim();
    this.calls.push({ query: normalized, bindings });
    let rows: Row[] = [];
    if (normalized === "PRAGMA table_info(relayplay_rooms)") {
      rows = [...this.columns].map((name) => ({ name }));
    } else if (normalized.startsWith("SELECT room_id, room_epoch, status")) {
      rows = this.roomRow === undefined ? [] : [this.roomRow];
    }
    return {
      toArray: () => rows as T[],
    };
  }
}

function fakeStorage(sql: FakeSql): DurableObjectStorage {
  return {
    sql,
    transactionSync: <Result>(closure: () => Result) => closure(),
  } as unknown as DurableObjectStorage;
}

function persistedRoom(overrides: Partial<Row> = {}): Row {
  return {
    room_id: "room_0001",
    room_epoch: 1,
    status: "running",
    created_at: 1_000,
    updated_at: 2_000,
    start_at: 1_500,
    last_sequence: 2,
    participant_ids_json: JSON.stringify(["player_0001", "player_0002"]),
    completed_player_ids_json: JSON.stringify(["player_0001"]),
    ...overrides,
  };
}

describe("CloudflareRoomStorage room roster persistence", () => {
  it("migrates existing room tables with roster columns", () => {
    const sql = new FakeSql();
    const storage = new CloudflareRoomStorage(fakeStorage(sql));

    storage.initialize();

    expect(sql.calls.map((call) => call.query)).toEqual(
      expect.arrayContaining([
        "ALTER TABLE relayplay_rooms ADD COLUMN participant_ids_json TEXT",
        "ALTER TABLE relayplay_rooms ADD COLUMN completed_player_ids_json TEXT",
      ]),
    );
  });

  it("round-trips participant and completion rosters through room rows", () => {
    const sql = new FakeSql();
    sql.roomRow = persistedRoom();
    const storage = new CloudflareRoomStorage(fakeStorage(sql));

    expect(storage.getRoom("room_0001")).toMatchObject({
      participantIds: ["player_0001", "player_0002"],
      completedPlayerIds: ["player_0001"],
    });

    const room: StoredRoom = {
      roomId: "room_0001",
      roomEpoch: 1,
      status: "finished",
      createdAt: 1_000,
      updatedAt: 3_000,
      startAt: 1_500,
      lastSequence: 3,
      participantIds: ["player_0001", "player_0002"],
      completedPlayerIds: ["player_0001", "player_0002"],
    };
    storage.putRoom(room);
    const insert = sql.calls.find((call) =>
      call.query.startsWith("INSERT INTO relayplay_rooms"),
    );
    expect(insert?.bindings.slice(-2)).toEqual([
      JSON.stringify(room.participantIds),
      JSON.stringify(room.completedPlayerIds),
    ]);
  });

  it("persists roster changes atomically with a canonical commit", () => {
    const sql = new FakeSql();
    sql.roomRow = persistedRoom({
      status: "running",
      last_sequence: 2,
      completed_player_ids_json: JSON.stringify(["player_0001"]),
    });
    const storage = new CloudflareRoomStorage(fakeStorage(sql));
    const commit: CanonicalCommit = {
      roomId: "room_0001",
      roomEpoch: 1,
      eventId: "event_0003",
      kind: "finish",
      createdAt: 3_000,
      playerId: "player_0002",
      payload: { placement: 2 },
      idempotencyScope: "player_0002",
      idempotencyKey: "finish-key-0002",
      roomUpdate: {
        status: "finished",
        participantIds: ["player_0001", "player_0002"],
        completedPlayerIds: ["player_0001", "player_0002"],
        updatedAt: 3_000,
      },
      eventLogCapacity: 64,
    };

    const result = storage.commitCanonical(commit);

    expect(result.event.sequence).toBe(3);
    const update = sql.calls.find((call) =>
      call.query.startsWith("UPDATE relayplay_rooms SET status"),
    );
    expect(update?.bindings.slice(4, 6)).toEqual([
      JSON.stringify(commit.roomUpdate?.participantIds),
      JSON.stringify(commit.roomUpdate?.completedPlayerIds),
    ]);
  });
});
