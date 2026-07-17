import { describe, expect, it } from "vitest";

import {
  InMemoryBroadcaster,
  InMemoryRoomStorage,
  RoomEngine,
  type AuthRequest,
  type AuthResult,
  type IdGenerator,
  type RoomEngineOptions,
  type RoomSession,
} from "../src/index.js";

class TestClock {
  public value = 10_000;

  public now(): number {
    return this.value;
  }
}

function testIds(): IdGenerator {
  let event = 0;
  let session = 0;
  return {
    eventId: () => `event_${String(++event).padStart(4, "0")}`,
    sessionId: () => `session_${String(++session).padStart(4, "0")}`,
  };
}

function authenticate(request: AuthRequest): AuthResult {
  if (request.credential !== "valid-token" || request.requestedPlayerId === undefined) {
    throw new Error("unauthorized");
  }
  return {
    playerId: request.requestedPlayerId,
    ...(request.requestedSessionId === undefined
      ? {}
      : { sessionId: request.requestedSessionId }),
  };
}

function setup(overrides: Partial<RoomEngineOptions> = {}) {
  const audit: string[] = [];
  const storage = new InMemoryRoomStorage({ audit });
  const broadcaster = new InMemoryBroadcaster({ audit });
  const clock = new TestClock();
  const engine = new RoomEngine({
    storage,
    broadcaster,
    authenticate,
    clock,
    ids: testIds(),
    config: {
      time: { startLeadMs: 1_000, interactionLeadMs: 100 },
    },
    ...overrides,
  });
  return { audit, storage, broadcaster, clock, engine };
}

async function join(
  engine: RoomEngine,
  broadcaster: InMemoryBroadcaster,
  playerId: string,
  connectionId: string,
  options: { resumeEpoch?: number; sessionId?: string; afterSequence?: number } = {},
): Promise<RoomSession> {
  broadcaster.attach(connectionId, "room_alpha", playerId);
  return engine.connect({
    roomId: "room_alpha",
    credential: "valid-token",
    connectionId,
    requestedPlayerId: playerId,
    ...(options.resumeEpoch === undefined ? {} : { resumeEpoch: options.resumeEpoch }),
    ...(options.sessionId === undefined ? {} : { requestedSessionId: options.sessionId }),
    ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
  });
}

async function startTwoPlayers(
  engine: RoomEngine,
  broadcaster: InMemoryBroadcaster,
): Promise<readonly [RoomSession, RoomSession]> {
  const first = await join(engine, broadcaster, "player_one", "connection_one");
  const second = await join(engine, broadcaster, "player_two", "connection_two");
  await engine.handle(first, {
    version: 1,
    type: "ready",
    idempotencyKey: "ready-key-01",
    ready: true,
  });
  await engine.handle(second, {
    version: 1,
    type: "ready",
    idempotencyKey: "ready-key-02",
    ready: true,
  });
  return [first, second];
}

describe("RoomEngine", () => {
  it("allows a waiting player to withdraw readiness without scheduling a start", async () => {
    const { broadcaster, engine } = setup();
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    const second = await join(engine, broadcaster, "player_two", "connection_two");
    await engine.handle(first, {
      version: 1,
      type: "ready",
      idempotencyKey: "ready-key-01",
      ready: true,
    });
    await engine.handle(second, {
      version: 1,
      type: "ready",
      idempotencyKey: "ready-key-02",
      ready: false,
    });
    expect((await engine.getSnapshot("room_alpha")).room.status).toBe("waiting");

    await engine.handle(second, {
      version: 1,
      type: "ready",
      idempotencyKey: "ready-key-03",
      ready: true,
    });
    expect((await engine.getSnapshot("room_alpha")).room.status).toBe("scheduled");
  });

  it("persists a canonical synchronized start before broadcasting it", async () => {
    const { audit, storage, broadcaster, engine } = setup();
    await startTwoPlayers(engine, broadcaster);

    const snapshot = await engine.getSnapshot("room_alpha");
    expect(snapshot.room.status).toBe("scheduled");
    expect(snapshot.room.startAt).toBe(11_000);
    expect(snapshot.room.lastSequence).toBe(1);

    const range = storage.readCanonical("room_alpha", 1, 0);
    expect(range.events).toHaveLength(1);
    expect(range.events[0]).toMatchObject({
      kind: "start",
      sequence: 1,
      effectiveAt: { kind: "server-time", serverTimeMs: 11_000 },
    });
    expect(audit.indexOf("persist:1:start")).toBeLessThan(
      audit.indexOf("broadcast:1:start"),
    );
  });

  it("keeps progress ephemeral and relays canonical targeted interactions", async () => {
    const { storage, broadcaster, engine } = setup();
    const [first] = await startTwoPlayers(engine, broadcaster);
    broadcaster.drain("connection_one");
    broadcaster.drain("connection_two");

    await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 7,
      payload: { score: 42 },
    });
    expect(storage.readCanonical("room_alpha", 1, 0).events).toHaveLength(1);
    expect(broadcaster.messages("connection_one")).toEqual([]);
    expect(broadcaster.messages("connection_two")).toContainEqual({
      version: 1,
      type: "progress",
      playerId: "player_one",
      sequence: 7,
      serverTime: 10_000,
      payload: { score: 42 },
    });
    broadcaster.drain("connection_two");
    await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 7,
      payload: { score: 999 },
    });
    expect(broadcaster.messages("connection_two")).toEqual([]);

    await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-01",
      action: "garbage",
      targetPlayerId: "player_two",
      effectiveAt: { kind: "server-time", serverTimeMs: 10_001 },
      payload: { lines: 2 },
    });
    const event = storage.readCanonical("room_alpha", 1, 1).events[0];
    expect(event).toMatchObject({
      sequence: 2,
      kind: "interaction",
      playerId: "player_one",
      targetPlayerId: "player_two",
      effectiveAt: { kind: "server-time", serverTimeMs: 11_000 },
    });
    expect(broadcaster.messages("connection_two")).toContainEqual({
      version: 1,
      type: "canonical",
      event,
    });
  });

  it("deduplicates a retried intent without consuming sequence or applying twice", async () => {
    const { storage, broadcaster, engine } = setup();
    const [first] = await startTwoPlayers(engine, broadcaster);
    const intent = {
      version: 1 as const,
      type: "interaction" as const,
      idempotencyKey: "attack-key-01",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: { lines: 2 },
    };

    await engine.handle(first, intent);
    broadcaster.drain("connection_one");
    broadcaster.drain("connection_two");
    await engine.handle(first, intent);

    expect(storage.readCanonical("room_alpha", 1, 0).events).toHaveLength(2);
    expect(broadcaster.messages("connection_one")).toMatchObject([
      { type: "canonical", duplicate: true, event: { sequence: 2 } },
    ]);
    expect(broadcaster.messages("connection_two")).toMatchObject([
      { type: "canonical", duplicate: true, event: { sequence: 2 } },
    ]);
  });

  it("persists rate limits and exposes a safe retry delay", async () => {
    const { broadcaster, engine } = setup({
      config: {
        time: { startLeadMs: 1_000, interactionLeadMs: 100 },
        security: {
          rateLimits: {
            actions: {
              garbage: { capacity: 1, refillPerSecond: 0.5 },
            },
          },
        },
      },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-01",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: null,
    });
    const error = await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-02",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: null,
    });
    expect(error).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      retriable: true,
      retryAfterMs: 2_000,
    });
  });

  it("applies a fixed interaction scope bucket so action-name rotation cannot bypass limits", async () => {
    const { broadcaster, engine } = setup({
      config: {
        time: { startLeadMs: 1_000, interactionLeadMs: 100 },
        security: {
          rateLimits: {
            actions: {
              interaction: { capacity: 1, refillPerSecond: 0.5 },
            },
          },
        },
      },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-01",
      action: "first_action",
      targetPlayerId: "player_two",
      payload: null,
    });
    const error = await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-02",
      action: "second_action",
      targetPlayerId: "player_two",
      payload: null,
    });

    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 });
  });

  it("replays only missing canonical events into an authenticated resumed session", async () => {
    const { broadcaster, engine } = setup();
    const [first, second] = await startTwoPlayers(engine, broadcaster);
    await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-01",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: { lines: 1 },
    });
    await engine.disconnect(second);
    broadcaster.detach("connection_two");

    const resumed = await join(
      engine,
      broadcaster,
      "player_two",
      "connection_two_new",
      { resumeEpoch: 1, sessionId: second.sessionId, afterSequence: 1 },
    );
    expect(resumed.resumeEpoch).toBe(2);
    expect(broadcaster.messages("connection_two_new")).toContainEqual({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 1,
      events: [expect.objectContaining({ sequence: 2, kind: "interaction" })],
    });
  });

  it("turns an expired disconnect deadline into a persisted canonical forfeit", async () => {
    const { audit, storage, broadcaster, clock, engine } = setup();
    const [, second] = await startTwoPlayers(engine, broadcaster);
    await engine.disconnect(second);
    clock.value = 25_000;

    const events = await engine.sweep("room_alpha");
    expect(events).toMatchObject([
      {
        sequence: 2,
        kind: "finish",
        playerId: "player_two",
        payload: { reason: "disconnect-timeout" },
      },
    ]);
    expect(storage.getSession("room_alpha", "player_two")).toBeUndefined();
    expect(audit.indexOf("persist:2:finish")).toBeLessThan(
      audit.indexOf("broadcast:2:finish"),
    );
  });

  it("uses the replay verifier hook before recording enabled evidence", async () => {
    const { storage, broadcaster, engine } = setup({
      config: {
        time: { startLeadMs: 1_000, interactionLeadMs: 100 },
        features: { evidence: { replayChunks: true } },
      },
      verifyReplay: (command) => ({
        accepted: true,
        payload: { verifiedChunk: command.payload },
      }),
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    await engine.handle(first, {
      version: 1,
      type: "evidence",
      idempotencyKey: "evidence-key-01",
      evidenceType: "replay-chunk",
      payload: { frame: 60 },
    });

    expect(storage.readCanonical("room_alpha", 1, 1).events[0]).toMatchObject({
      sequence: 2,
      kind: "evidence",
      action: "replay-chunk",
      payload: { verifiedChunk: { frame: 60 } },
    });
  });

  it("runs policy and verification hooks before a canonical commit", async () => {
    const { storage, broadcaster, engine } = setup({
      validateInteraction: (command) =>
        command.payload === "allowed"
          ? { accepted: true, payload: { normalized: true } }
          : { accepted: false, message: "ruleset rejected the intent" },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    const error = await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-01",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: "denied",
    });
    expect(error).toMatchObject({ code: "INTERACTION_REJECTED" });
    expect(storage.readCanonical("room_alpha", 1, 0).events).toHaveLength(1);

    await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-02",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: "allowed",
    });
    expect(storage.readCanonical("room_alpha", 1, 1).events[0]?.payload).toEqual({
      normalized: true,
    });
  });

  it("fails authentication without creating a room", async () => {
    const { storage, broadcaster, engine } = setup();
    broadcaster.attach("connection_bad", "room_alpha", "player_bad");
    await expect(
      engine.connect({
        roomId: "room_alpha",
        credential: "wrong-token",
        connectionId: "connection_bad",
        requestedPlayerId: "player_bad",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(storage.getRoom("room_alpha")).toBeUndefined();
  });
});
