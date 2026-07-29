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
  it("sends session identity and an authoritative room snapshot before presence", async () => {
    const { broadcaster, engine } = setup();
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    await engine.handle(first, {
      version: 1,
      type: "ready",
      idempotencyKey: "ready-key-01",
      ready: true,
    });
    broadcaster.drain("connection_one");

    await join(engine, broadcaster, "player_two", "connection_two");
    expect(broadcaster.messages("connection_two").slice(0, 2)).toEqual([
      expect.objectContaining({
        type: "session",
        resumed: false,
        lastProgressSequence: -1,
      }),
      expect.objectContaining({
        type: "snapshot",
        status: "waiting",
        serverTime: 10_000,
        lastSequence: 0,
        players: [
          expect.objectContaining({
            playerId: "player_one",
            connected: true,
            ready: true,
            lastProgressSequence: -1,
          }),
          expect.objectContaining({
            playerId: "player_two",
            connected: true,
            ready: false,
            lastProgressSequence: -1,
          }),
        ],
      }),
    ]);
    expect(broadcaster.messages("connection_one")).toContainEqual(
      expect.objectContaining({ type: "presence", playerId: "player_two" }),
    );
    expect(
      broadcaster
        .messages("connection_two")
        .some((message) => message.type === "presence" && message.playerId === "player_two"),
    ).toBe(false);
  });

  it("requires reconnect credentials to bind the stored session and ignores client metadata", async () => {
    const { storage, broadcaster, engine } = setup({
      authenticate: (request) => {
        if (request.credential !== "valid-token" || request.requestedPlayerId === undefined) {
          throw new Error("unauthorized");
        }
        return {
          playerId: request.requestedPlayerId,
          metadata: { trusted: true },
        };
      },
    });
    broadcaster.attach("connection_one", "room_alpha", "player_one");
    const first = await engine.connect({
      roomId: "room_alpha",
      credential: "valid-token",
      connectionId: "connection_one",
      requestedPlayerId: "player_one",
      metadata: { injectedRole: "host" },
    });
    expect(storage.getSession("room_alpha", "player_one")?.metadata).toEqual({ trusted: true });

    broadcaster.attach("connection_two", "room_alpha", "player_one");
    await expect(
      engine.connect({
        roomId: "room_alpha",
        credential: "valid-token",
        connectionId: "connection_two",
        requestedPlayerId: "player_one",
        requestedSessionId: first.sessionId,
        resumeEpoch: first.resumeEpoch,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("activates a persisted reconnect before sends and identifies the replaced transport", async () => {
    const { storage, broadcaster, engine } = setup();
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    broadcaster.drain("connection_one");
    const activation: string[] = [];

    const resumed = await engine.connect({
      roomId: "room_alpha",
      credential: "valid-token",
      connectionId: "connection_two",
      requestedPlayerId: "player_one",
      requestedSessionId: first.sessionId,
      resumeEpoch: first.resumeEpoch,
      activateConnection: (session, replacedConnectionId) => {
        activation.push(
          `${storage.getSession("room_alpha", "player_one")?.connectionId ?? "missing"}:${replacedConnectionId ?? "none"}:${String(broadcaster.messages(session.connectionId).length)}`,
        );
        broadcaster.detach(replacedConnectionId ?? "missing");
        broadcaster.attach(session.connectionId, session.roomId, session.playerId);
      },
    });

    expect(activation).toEqual(["connection_two:connection_one:0"]);
    expect(resumed.resumeEpoch).toBe(2);
    expect(broadcaster.messages("connection_two").slice(0, 3)).toMatchObject([
      { type: "session", resumed: true },
      { type: "snapshot" },
      {
        type: "replay",
        afterSequence: 0,
        throughSequence: 0,
        hasMore: false,
        events: [],
      },
    ]);
    expect(broadcaster.messages("connection_one")).toEqual([]);
  });

  it("restores the previous authoritative session when transport activation fails", async () => {
    const { storage, broadcaster, engine } = setup();
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    broadcaster.drain("connection_one");

    await expect(
      engine.connect({
        roomId: "room_alpha",
        credential: "valid-token",
        connectionId: "connection_two",
        requestedPlayerId: "player_one",
        requestedSessionId: first.sessionId,
        resumeEpoch: first.resumeEpoch,
        activateConnection: () => {
          throw new Error("socket registry unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", retriable: true });

    expect(storage.getSession("room_alpha", "player_one")).toMatchObject({
      connectionId: "connection_one",
      resumeEpoch: 1,
      connected: true,
    });
    await engine.handle(first, {
      version: 1,
      type: "ping",
      pingId: "ping-key-01",
      clientTime: 10_000,
    });
    expect(broadcaster.messages("connection_one")).toContainEqual(
      expect.objectContaining({ type: "pong", pingId: "ping-key-01" }),
    );
  });

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

  it("validates and normalizes semantic progress before persistence and broadcast", async () => {
    const { storage, broadcaster, engine } = setup({
      validateProgress: (command) =>
        typeof command.payload === "number" && command.payload >= 0 && command.payload <= 10
          ? { accepted: true, payload: { checkpoint: command.payload } }
          : { accepted: false, message: "checkpoint is outside the course" },
    });
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    await join(engine, broadcaster, "player_two", "connection_two");
    broadcaster.drain("connection_two");

    await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 1,
      payload: 3,
    });
    expect(broadcaster.messages("connection_two")).toContainEqual(
      expect.objectContaining({
        type: "progress",
        sequence: 1,
        payload: { checkpoint: 3 },
      }),
    );

    const error = await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 2,
      payload: 99,
    });
    expect(error).toMatchObject({ code: "PROGRESS_REJECTED" });
    expect(storage.getSession("room_alpha", "player_one")?.lastProgressSequence).toBe(1);
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
    expect(broadcaster.messages("connection_two")).toEqual([]);
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

  it("applies a generic session bucket to ping and other otherwise-ephemeral commands", async () => {
    const { broadcaster, engine } = setup({
      config: {
        security: {
          rateLimits: {
            default: { capacity: 2, refillPerSecond: 1 },
          },
        },
      },
    });
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    broadcaster.drain("connection_one");

    for (const pingId of ["ping-key-01", "ping-key-02"]) {
      await engine.handle(first, {
        version: 1,
        type: "ping",
        pingId,
        clientTime: 10_000,
      });
    }
    const error = await engine.handle(first, {
      version: 1,
      type: "ping",
      pingId: "ping-key-03",
      clientTime: 10_000,
    });

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 1_000,
    });
    expect(
      broadcaster.messages("connection_one").filter((message) => message.type === "pong"),
    ).toHaveLength(2);
  });

  it("charges ack, resume, progress, and duplicate messages to the generic bucket", async () => {
    const { broadcaster, engine } = setup({
      config: {
        security: {
          rateLimits: {
            default: { capacity: 4, refillPerSecond: 1 },
          },
        },
      },
    });
    const first = await join(engine, broadcaster, "player_one", "connection_one");
    broadcaster.drain("connection_one");

    await engine.handle(first, { version: 1, type: "ack", sequence: 0 });
    await engine.handle(first, {
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 0,
    });
    await engine.handle(first, {
      version: 1,
      type: "ping",
      pingId: "ping-key-01",
      clientTime: 10_000,
    });
    await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 1,
      payload: { checkpoint: 1 },
    });
    const error = await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 1,
      payload: { checkpoint: 1 },
    });

    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 1_000 });
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
    await engine.handle(second, {
      version: 1,
      type: "progress",
      sequence: 7,
      payload: { checkpoint: 3 },
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
    expect(broadcaster.messages("connection_two_new")).toContainEqual(
      expect.objectContaining({
        type: "session",
        resumed: true,
        lastProgressSequence: 7,
      }),
    );
    expect(broadcaster.messages("connection_two_new")).toContainEqual({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 1,
      throughSequence: 2,
      hasMore: false,
      events: [expect.objectContaining({ sequence: 2, kind: "interaction" })],
    });
  });

  it("paginates replay with an exact contiguous through-sequence cursor", async () => {
    const { broadcaster, engine } = setup({ replayBatchSize: 1 });
    const [first] = await startTwoPlayers(engine, broadcaster);
    for (const [idempotencyKey, lines] of [
      ["attack-key-01", 1],
      ["attack-key-02", 2],
    ] as const) {
      await engine.handle(first, {
        version: 1,
        type: "interaction",
        idempotencyKey,
        action: "garbage",
        targetPlayerId: "player_two",
        payload: { lines },
      });
    }
    broadcaster.drain("connection_one");

    await engine.handle(first, {
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 0,
    });
    expect(broadcaster.drain("connection_one")).toContainEqual(
      expect.objectContaining({
        type: "replay",
        afterSequence: 0,
        throughSequence: 1,
        hasMore: true,
        events: [expect.objectContaining({ sequence: 1 })],
      }),
    );

    await engine.handle(first, {
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 1,
    });
    expect(broadcaster.drain("connection_one")).toContainEqual(
      expect.objectContaining({
        type: "replay",
        afterSequence: 1,
        throughSequence: 2,
        hasMore: true,
        events: [expect.objectContaining({ sequence: 2 })],
      }),
    );

    await engine.handle(first, {
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 2,
    });
    expect(broadcaster.drain("connection_one")).toContainEqual(
      expect.objectContaining({
        type: "replay",
        afterSequence: 2,
        throughSequence: 3,
        hasMore: false,
        events: [expect.objectContaining({ sequence: 3 })],
      }),
    );
  });

  it("fails closed when the requested replay cursor predates retained history", async () => {
    const { broadcaster, engine } = setup({
      config: { room: { eventLogCapacity: 1 } },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    for (const idempotencyKey of ["attack-key-01", "attack-key-02"]) {
      await engine.handle(first, {
        version: 1,
        type: "interaction",
        idempotencyKey,
        action: "garbage",
        targetPlayerId: "player_two",
        payload: null,
      });
    }
    broadcaster.drain("connection_one");

    const error = await engine.handle(first, {
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 0,
    });
    expect(error).toMatchObject({ code: "REPLAY_UNAVAILABLE" });
    expect(
      broadcaster.messages("connection_one").some((message) => message.type === "replay"),
    ).toBe(false);
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
    expect(storage.getSession("room_alpha", "player_two")).toMatchObject({
      connected: false,
      playerId: "player_two",
    });
    expect(audit.indexOf("persist:2:finish")).toBeLessThan(
      audit.indexOf("broadcast:2:finish"),
    );
  });

  it("orders validated finishes, deduplicates per player, and completes the room", async () => {
    const finishContexts: Array<{ elapsedMs: number; placement: number }> = [];
    const { audit, storage, broadcaster, clock, engine } = setup({
      validateFinish: (command, context) => {
        finishContexts.push({ elapsedMs: context.elapsedMs, placement: context.placement });
        return { accepted: true, payload: { verified: command.payload } };
      },
    });
    const [first, second] = await startTwoPlayers(engine, broadcaster);
    clock.value = 12_000;
    broadcaster.drain("connection_one");
    broadcaster.drain("connection_two");

    await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-01",
      payload: { score: 90 },
    });
    expect((await engine.getSnapshot("room_alpha")).room.status).toBe("running");
    expect(storage.readCanonical("room_alpha", 1, 1).events[0]).toMatchObject({
      sequence: 2,
      kind: "finish",
      playerId: "player_one",
      payload: {
        reason: "completed",
        elapsedMs: 1_000,
        placement: 1,
        result: { verified: { score: 90 } },
      },
    });
    const lateProgress = await engine.handle(first, {
      version: 1,
      type: "progress",
      sequence: 1,
      payload: { checkpoint: 99 },
    });
    const lateInteraction = await engine.handle(first, {
      version: 1,
      type: "interaction",
      idempotencyKey: "attack-key-late-01",
      action: "garbage",
      targetPlayerId: "player_two",
      payload: null,
    });
    expect(lateProgress).toMatchObject({ code: "PROGRESS_REJECTED" });
    expect(lateInteraction).toMatchObject({ code: "INTERACTION_REJECTED" });

    broadcaster.drain("connection_one");
    broadcaster.drain("connection_two");
    await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "different-key-01",
      payload: { score: 999 },
    });
    expect(storage.readCanonical("room_alpha", 1, 0).events).toHaveLength(2);
    expect(broadcaster.messages("connection_one")).toMatchObject([
      { type: "canonical", duplicate: true, event: { sequence: 2 } },
    ]);
    expect(broadcaster.messages("connection_two")).toEqual([]);

    clock.value = 13_000;
    await engine.handle(second, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-02",
      payload: { score: 80 },
    });
    const snapshot = await engine.getSnapshot("room_alpha");
    expect(snapshot.room.status).toBe("finished");
    expect(snapshot.room.completedPlayerIds).toEqual(["player_one", "player_two"]);
    expect(storage.readCanonical("room_alpha", 1, 0).events.at(-1)).toMatchObject({
      sequence: 3,
      kind: "finish",
      playerId: "player_two",
      payload: { elapsedMs: 2_000, placement: 2 },
    });
    expect(finishContexts).toEqual([
      { elapsedMs: 1_000, placement: 1 },
      { elapsedMs: 2_000, placement: 2 },
    ]);
    expect(audit.indexOf("persist:3:finish")).toBeLessThan(
      audit.indexOf("broadcast:3:finish"),
    );
  });

  it("rejects a normal finish until the authoritative start time has elapsed", async () => {
    const { storage, broadcaster, clock, engine } = setup();
    const [first] = await startTwoPlayers(engine, broadcaster);

    const early = await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-01",
      payload: { score: 100 },
    });
    expect(early).toMatchObject({ code: "FINISH_REJECTED" });
    expect(storage.readCanonical("room_alpha", 1, 0).events).toHaveLength(1);

    clock.value = 11_000;
    await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-02",
      payload: { score: 100 },
    });
    expect(storage.readCanonical("room_alpha", 1, 1).events[0]).toMatchObject({
      kind: "finish",
      payload: { elapsedMs: 0, placement: 1 },
    });
  });

  it("requires a finish validator when ranked or verified results are enabled", async () => {
    const { broadcaster, clock, engine } = setup({
      config: {
        features: { ranking: { enabled: true } },
        time: { startLeadMs: 1_000 },
      },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    clock.value = 12_000;

    const error = await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-01",
      payload: { score: 100 },
    });
    expect(error).toMatchObject({ code: "FINISH_REJECTED" });
  });

  it("also requires a finish validator for final-result verification", async () => {
    const { broadcaster, clock, engine } = setup({
      config: {
        features: { verification: { finalResults: true } },
        time: { startLeadMs: 1_000 },
      },
    });
    const [first] = await startTwoPlayers(engine, broadcaster);
    clock.value = 12_000;

    const error = await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-01",
      payload: { score: 100 },
    });
    expect(error).toMatchObject({ code: "FINISH_REJECTED" });
  });

  it("counts an expired participant forfeit toward room completion", async () => {
    const { storage, broadcaster, clock, engine } = setup();
    const [first, second] = await startTwoPlayers(engine, broadcaster);
    clock.value = 12_000;
    await engine.handle(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish-key-01",
      payload: null,
    });
    await engine.disconnect(second);
    clock.value = 27_000;

    const events = await engine.sweep("room_alpha");
    expect(events).toMatchObject([
      {
        sequence: 3,
        kind: "finish",
        playerId: "player_two",
        payload: { reason: "disconnect-timeout", placement: 2 },
      },
    ]);
    expect(storage.getRoom("room_alpha")?.status).toBe("finished");
  });

  it("completes a match when every remaining participant expires in one sweep", async () => {
    const { storage, broadcaster, clock, engine } = setup();
    const [first, second] = await startTwoPlayers(engine, broadcaster);
    await engine.disconnect(first);
    await engine.disconnect(second);
    clock.value = 25_000;

    const events = await engine.sweep("room_alpha");
    expect(events).toMatchObject([
      { kind: "finish", playerId: "player_one", payload: { placement: 1 } },
      { kind: "finish", playerId: "player_two", payload: { placement: 2 } },
    ]);
    expect(storage.getRoom("room_alpha")?.status).toBe("finished");
    expect(storage.getSession("room_alpha", "player_one")).toBeUndefined();
    expect(storage.getSession("room_alpha", "player_two")).toBeUndefined();
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
