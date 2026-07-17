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

  next(prefix: "ping" | "interaction" | "ready" | "evidence"): string {
    this.#sequence += 1;
    return `${prefix}_test_${String(this.#sequence).padStart(4, "0")}`;
  }
}

class MockWebSocket implements WebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
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
  status: "waiting",
  lastSequence: 0,
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
      { version: 1, type: "progress", sequence: 1, payload: { score: 9 } },
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

  it("reconnects with session resume parameters and replays the canonical tail", async () => {
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
    second.receive({ ...session, resumeEpoch: 2, lastSequence: 2 });
    await settle();
    second.receive({
      version: 1,
      type: "replay",
      roomEpoch: 1,
      afterSequence: 1,
      events: [canonical(2)],
    });
    await settle();

    expect(client.state).toBe("connected");
    expect(client.lastEventSequence).toBe(2);
    expect(resumed).toHaveBeenCalledWith(
      expect.objectContaining({ resumed: true, replayedEvents: 1 }),
    );
  });
});
