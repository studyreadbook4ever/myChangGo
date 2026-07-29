import type {
  CanonicalEvent,
  ClientMessage,
  ServerMessage,
} from "@relayplay/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RelayPlayClient,
  type RelayPlayClientOptions,
} from "../src/client.js";
import type { ClientIdGenerator } from "../src/ids.js";
import type { Clock } from "../src/time-sync.js";
import {
  WebSocketReadyState,
  type WebSocketEventMap,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/websocket.js";

class TestClock implements Clock {
  value = 1_000;

  now(): number {
    return this.value;
  }
}

class TestIds implements ClientIdGenerator {
  #sequence = 0;

  next(prefix: "ping" | "interaction" | "ready" | "evidence" | "finish"): string {
    this.#sequence += 1;
    return `${prefix}_test_${String(this.#sequence).padStart(4, "0")}`;
  }
}

class MockWebSocket implements WebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  bufferedAmount = 0;
  #readyState: number = WebSocketReadyState.CONNECTING;
  readonly #listeners = new Map<
    keyof WebSocketEventMap,
    Set<(event: WebSocketEventMap[keyof WebSocketEventMap]) => void>
  >();

  constructor(url: string) {
    this.url = url;
  }

  get readyState(): number {
    return this.#readyState;
  }

  addEventListener<Key extends keyof WebSocketEventMap>(
    type: Key,
    listener: (event: WebSocketEventMap[Key]) => void,
  ): void {
    let listeners = this.#listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(
      listener as (event: WebSocketEventMap[keyof WebSocketEventMap]) => void,
    );
  }

  removeEventListener<Key extends keyof WebSocketEventMap>(
    type: Key,
    listener: (event: WebSocketEventMap[Key]) => void,
  ): void {
    this.#listeners
      .get(type)
      ?.delete(
        listener as (event: WebSocketEventMap[keyof WebSocketEventMap]) => void,
      );
  }

  send(data: string): void {
    if (this.#readyState !== WebSocketReadyState.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.#readyState === WebSocketReadyState.CLOSED) {
      return;
    }
    this.#readyState = WebSocketReadyState.CLOSED;
    this.#emit("close", {
      code,
      reason,
      wasClean: code === 1000,
    } as CloseEvent);
  }

  open(): void {
    this.#readyState = WebSocketReadyState.OPEN;
    this.#emit("open", new Event("open"));
  }

  receive(message: ServerMessage | unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.#emit("message", { data } as MessageEvent<unknown>);
  }

  receiveData(data: unknown): void {
    this.#emit("message", { data } as MessageEvent<unknown>);
  }

  serverClose(code = 1006, reason = "network lost"): void {
    this.#readyState = WebSocketReadyState.CLOSED;
    this.#emit("close", { code, reason, wasClean: false } as CloseEvent);
  }

  #emit<Key extends keyof WebSocketEventMap>(
    type: Key,
    event: WebSocketEventMap[Key],
  ): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

class MockSocketFactory {
  readonly sockets: MockWebSocket[] = [];
  readonly create: WebSocketFactory = (url) => {
    const socket = new MockWebSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  get latest(): MockWebSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) {
      throw new Error("no mock socket has been created");
    }
    return socket;
  }
}

const session: ServerMessage = {
  version: 1,
  type: "session",
  roomId: "room_0001",
  roomEpoch: 1,
  playerId: "player_0001",
  sessionId: "session_0001",
  resumeEpoch: 1,
  resumed: false,
  status: "waiting",
  lastSequence: 0,
  lastProgressSequence: -1,
};

function canonical(
  sequence: number,
  kind: CanonicalEvent["kind"] = "interaction",
): CanonicalEvent {
  return {
    roomId: "room_0001",
    roomEpoch: 1,
    eventId: `event_${String(sequence).padStart(4, "0")}`,
    sequence,
    kind,
    createdAt: 2_000 + sequence,
    ...(kind === "start"
      ? { effectiveAt: { kind: "server-time" as const, serverTimeMs: 3_000 } }
      : {}),
    ...(kind === "interaction"
      ? { playerId: "player_0002", action: "freeze" }
      : kind === "finish"
        ? { playerId: "player_0002" }
        : {}),
    payload: kind === "interaction" ? { durationMs: 500 } : {},
  };
}

function messages(socket: MockWebSocket): ClientMessage[] {
  return socket.sent.map((value) => JSON.parse(value) as ClientMessage);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createClient(
  factory: MockSocketFactory,
  clock: TestClock,
  overrides: Partial<RelayPlayClientOptions> = {},
): RelayPlayClient {
  return new RelayPlayClient({
    url: "https://relay.test/rooms/{roomId}/ws",
    roomId: "room_0001",
    token: "test-token",
    playerId: "player_0001",
    webSocketFactory: factory.create,
    clock,
    idGenerator: new TestIds(),
    config: { time: { sync: { enabled: false } } },
    reconnect: { jitterRatio: 0 },
    ...overrides,
  });
}

async function connectClient(
  client: RelayPlayClient,
  factory: MockSocketFactory,
): Promise<MockWebSocket> {
  const connected = client.connect();
  await settle();
  const socket = factory.latest;
  socket.open();
  expect(socket.sent).toEqual([]);
  socket.receive(session);
  await connected;
  await settle();
  return socket;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("RelayPlayClient", () => {
  it("waits for session and sends ready, progress, and interaction messages", async () => {
    const factory = new MockSocketFactory();
    const clock = new TestClock();
    const client = createClient(factory, clock);
    const socket = await connectClient(client, factory);

    const url = new URL(socket.url);
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("token")).toBe("test-token");
    expect(client.state).toBe("connected");
    socket.bufferedAmount = 128;
    expect(client.bufferedAmount).toBe(128);

    expect(client.setReady(true)).toBe(true);
    expect(client.reportProgress({ score: 9 })).toBe(true);
    const interactionId = client.sendInteraction({
      action: "freeze",
      targetPlayerId: "player_0002",
      effectiveAt: { kind: "server-time", serverTimeMs: 3_000 },
      payload: { durationMs: 500 },
    });

    expect(messages(socket)).toEqual([
      {
        version: 1,
        type: "ready",
        ready: true,
        idempotencyKey: "ready_test_0001",
      },
      { version: 1, type: "progress", sequence: 0, payload: { score: 9 } },
      {
        version: 1,
        type: "interaction",
        idempotencyKey: interactionId,
        action: "freeze",
        targetPlayerId: "player_0002",
        effectiveAt: { kind: "server-time", serverTimeMs: 3_000 },
        payload: { durationMs: 500 },
      },
    ]);
  });

  it("emits canonical start once, deduplicates it, and cumulatively acknowledges", async () => {
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const start = vi.fn();
    const duplicate = vi.fn();
    client.on("start", start);
    client.on("duplicate", duplicate);
    const socket = await connectClient(client, factory);
    const event = canonical(1, "start");

    socket.receive({ version: 1, type: "canonical", event });
    await settle();
    socket.receive({ version: 1, type: "canonical", event, duplicate: true });
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();
    expect(messages(socket)).toContainEqual({
      version: 1,
      type: "ack",
      sequence: 1,
    });
    expect(client.lastEventSequence).toBe(1);
  });

  it("requests replay for a persistent gap and releases buffered events in order", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const received: number[] = [];
    client.on("canonical", (event) => received.push(event.sequence));
    const socket = await connectClient(client, factory);

    socket.receive({ version: 1, type: "canonical", event: canonical(2) });
    await settle();
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(messages(socket)).toContainEqual({
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 0,
    });

    socket.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 0,
      throughSequence: 1,
      hasMore: false,
      events: [canonical(1)],
    });
    await settle();

    expect(received).toEqual([1, 2]);
    expect(client.lastEventSequence).toBe(2);
    expect(messages(socket)).toContainEqual({
      version: 1,
      type: "ack",
      sequence: 2,
    });
  });

  it("keeps gap recovery alive across replay pages without racing its timeout", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const received: number[] = [];
    client.on("canonical", (event) => received.push(event.sequence));
    const socket = await connectClient(client, factory);

    socket.receive({ version: 1, type: "canonical", event: canonical(3) });
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    socket.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 0,
      throughSequence: 1,
      hasMore: true,
      events: [canonical(1)],
    });
    await settle();
    expect(messages(socket)).toContainEqual({
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 1,
    });

    socket.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 1,
      throughSequence: 2,
      hasMore: false,
      events: [canonical(2)],
    });
    await settle();

    expect(received).toEqual([1, 2, 3]);
    expect(socket.readyState).toBe(WebSocketReadyState.OPEN);
  });

  it("estimates server time from ping and pong", async () => {
    const factory = new MockSocketFactory();
    const clock = new TestClock();
    const client = createClient(factory, clock);
    const synced = vi.fn();
    client.on("timeSync", synced);
    const socket = await connectClient(client, factory);

    const pingId = client.ping();
    clock.value = 1_020;
    socket.receive({
      version: 1,
      type: "pong",
      pingId,
      clientTime: 1_000,
      serverTime: 1_510,
    });
    await settle();

    expect(client.clockOffsetMs).toBe(500);
    expect(client.serverNow()).toBe(1_520);
    expect(synced).toHaveBeenCalledWith(
      expect.objectContaining({ uncertaintyMs: 10 }),
    );
  });

  it("emits authoritative snapshots and supports explicit finish intent and event", async () => {
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const snapshots = vi.fn();
    const finishes = vi.fn();
    client.on("snapshot", snapshots);
    client.on("finish", finishes);
    const socket = await connectClient(client, factory);
    const snapshot: ServerMessage = {
      version: 1,
      type: "snapshot",
      roomId: "room_0001",
      roomEpoch: 1,
      status: "waiting",
      serverTime: 2_000,
      lastSequence: 0,
      players: [
        {
          playerId: "player_0001",
          connected: true,
          ready: false,
          lastProgressSequence: -1,
        },
      ],
    };

    socket.receive(snapshot);
    await settle();
    const finishId = client.finish({ score: 99 });
    socket.receive({
      version: 1,
      type: "canonical",
      event: canonical(1, "finish"),
    });
    await settle();

    expect(snapshots).toHaveBeenCalledWith(snapshot);
    expect(messages(socket)).toContainEqual({
      version: 1,
      type: "finish",
      idempotencyKey: finishId,
      payload: { score: 99 },
    });
    expect(finishes).toHaveBeenCalledWith(canonical(1, "finish"));
  });

  it("rejects evidence when its configured channel is disabled", async () => {
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    await connectClient(client, factory);

    expect(() =>
      client.sendEvidence({ evidenceType: "state-hash", payload: { hash: "abc" } }),
    ).toThrow(/disabled/u);
    expect(() =>
      client.sendEvidence({ evidenceType: "result", payload: { score: 1 } }),
    ).toThrow(/disabled/u);
  });

  it("isolates application listener failures without closing the socket", async () => {
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const healthy = vi.fn();
    const errors = vi.fn();
    client.on("progress", () => {
      throw new Error("render failed");
    });
    client.on("progress", healthy);
    client.on("error", errors);
    const socket = await connectClient(client, factory);

    const progress: ServerMessage = {
      version: 1,
      type: "progress",
      playerId: "player_0002",
      sequence: 1,
      serverTime: 2_000,
      payload: { checkpoint: 3 },
    };
    socket.receive(progress);
    await settle();

    expect(healthy).toHaveBeenCalledWith(progress);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ source: "listener" }),
    );
    expect(socket.readyState).toBe(WebSocketReadyState.OPEN);
  });

  it("reconnects with session resume parameters and follows paginated canonical replay", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const resumed = vi.fn();
    client.on("resumed", resumed);
    const first = await connectClient(client, factory);
    first.receive({ version: 1, type: "canonical", event: canonical(1) });
    await settle();

    first.serverClose();
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    const second = factory.latest;
    const resumeUrl = new URL(second.url);
    expect(resumeUrl.searchParams.get("sessionId")).toBe("session_0001");
    expect(resumeUrl.searchParams.get("resumeEpoch")).toBe("1");
    expect(resumeUrl.searchParams.get("afterSequence")).toBe("1");

    second.open();
    second.receive({
      ...session,
      resumeEpoch: 2,
      resumed: true,
      lastSequence: 3,
      lastProgressSequence: 7,
    });
    await settle();
    second.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 1,
      throughSequence: 2,
      hasMore: true,
      events: [canonical(2)],
    });
    await settle();

    expect(messages(second)).toContainEqual({
      version: 1,
      type: "resume",
      roomEpoch: 1,
      afterSequence: 2,
    });
    second.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 2,
      throughSequence: 3,
      hasMore: false,
      events: [canonical(3)],
    });
    await settle();

    client.reportProgress({ score: 20 });

    expect(client.state).toBe("connected");
    expect(client.lastEventSequence).toBe(3);
    expect(messages(second)).toContainEqual({
      version: 1,
      type: "progress",
      sequence: 8,
      payload: { score: 20 },
    });
    expect(resumed).toHaveBeenCalledWith(
      expect.objectContaining({ resumed: true, replayedEvents: 2 }),
    );
  });

  it("cancels an automatic reconnect timer when connect is requested manually", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const first = await connectClient(client, factory);

    first.serverClose();
    const connecting = client.connect();
    await settle();
    expect(factory.sockets).toHaveLength(2);

    const second = factory.latest;
    second.open();
    second.receive({ ...session, resumed: true, resumeEpoch: 2 });
    await connecting;
    second.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 0,
      throughSequence: 0,
      hasMore: false,
      events: [],
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(factory.sockets).toHaveLength(2);
    expect(second.readyState).toBe(WebSocketReadyState.OPEN);
  });

  it("trusts an explicit fresh session instead of inferring resume from local state", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const connections = vi.fn();
    client.on("connected", connections);
    const first = await connectClient(client, factory);
    first.receive({ version: 1, type: "canonical", event: canonical(1) });
    await settle();

    first.serverClose();
    await vi.advanceTimersByTimeAsync(250);
    const second = factory.latest;
    second.open();
    second.receive({
      ...session,
      sessionId: "session_0002",
      resumed: false,
      lastSequence: 1,
    });
    await settle();

    expect(client.lastEventSequence).toBe(0);
    expect(connections).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumed: false, sessionId: "session_0002" }),
    );
  });

  it("clears canonical gap recovery when the affected socket closes", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const first = await connectClient(client, factory);
    first.receive({ version: 1, type: "canonical", event: canonical(2) });
    await settle();

    first.serverClose();
    await vi.advanceTimersByTimeAsync(250);
    const second = factory.latest;
    second.open();
    second.receive({
      ...session,
      resumed: true,
      resumeEpoch: 2,
      lastSequence: 2,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(500);

    expect(second.readyState).toBe(WebSocketReadyState.OPEN);
  });

  it("drops an asynchronously decoded message from a replaced socket generation", async () => {
    vi.useFakeTimers();
    const factory = new MockSocketFactory();
    const client = createClient(factory, new TestClock());
    const progress = vi.fn();
    client.on("progress", progress);
    const first = await connectClient(client, factory);
    let releaseText: ((text: string) => void) | undefined;
    const staleBlob = new Blob(["stale"]);
    vi.spyOn(staleBlob, "text").mockImplementation(
      () => new Promise<string>((resolve) => {
        releaseText = resolve;
      }),
    );
    first.receiveData(staleBlob);
    await settle();

    first.serverClose();
    await vi.advanceTimersByTimeAsync(250);
    const second = factory.latest;
    second.open();
    second.receive({ ...session, resumed: true, resumeEpoch: 2 });
    await settle();
    expect(client.state).toBe("connected");

    releaseText?.(JSON.stringify({
      version: 1,
      type: "progress",
      playerId: "player_0002",
      sequence: 1,
      serverTime: 2_000,
      payload: { checkpoint: 99 },
    }));
    await settle();

    expect(progress).not.toHaveBeenCalled();
    expect(client.state).toBe("connected");
    expect(second.readyState).toBe(WebSocketReadyState.OPEN);
  });

  it("does not resurrect a connection after an asynchronous endpoint resolves late", async () => {
    const factory = new MockSocketFactory();
    let resolveEndpoint: ((endpoint: string) => void) | undefined;
    const endpoint = new Promise<string>((resolve) => {
      resolveEndpoint = resolve;
    });
    const client = createClient(factory, new TestClock(), {
      url: () => endpoint,
    });
    const connecting = client.connect().catch((error: unknown) => error);
    await settle();

    await client.disconnect();
    resolveEndpoint?.("https://relay.test/rooms/{roomId}/ws");
    await settle();

    expect(await connecting).toBeInstanceOf(Error);
    expect(factory.sockets).toHaveLength(0);
    expect(client.state).toBe("closed");
  });
});
