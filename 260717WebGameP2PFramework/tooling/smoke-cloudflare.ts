#!/usr/bin/env node

import {
  decodeServerMessage,
  encodeProtocolMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerSessionMessage,
} from "../packages/core/src/index.js";

const httpBase = process.env.RELAYPLAY_SMOKE_HTTP_URL ?? "http://127.0.0.1:8787";
const roomId = `smoke_${Date.now().toString(36)}`;
const token = "relayplay-local-only";

interface MessageWaiter {
  readonly predicate: (message: ServerMessage) => boolean;
  resolve(message: ServerMessage): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

class Inbox {
  readonly #messages: ServerMessage[] = [];
  readonly #waiters = new Set<MessageWaiter>();

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") {
          throw new Error("smoke test expected a text WebSocket frame");
        }
        const message = decodeServerMessage(event.data);
        this.#messages.push(message);
        for (const waiter of this.#waiters) {
          if (waiter.predicate(message)) {
            clearTimeout(waiter.timer);
            this.#waiters.delete(waiter);
            waiter.resolve(message);
          }
        }
      } catch (error) {
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.#waiters.clear();
      }
    });
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> {
    const existing = this.#messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }
}

interface ConnectedSocket {
  readonly socket: WebSocket;
  readonly inbox: Inbox;
  readonly session: ServerSessionMessage;
}

function webSocketUrl(
  playerId: string,
  resume?: Pick<ServerSessionMessage, "sessionId" | "resumeEpoch"> & {
    readonly afterSequence: number;
  },
): string {
  const url = new URL(`/rooms/${roomId}/ws`, httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("playerId", playerId);
  if (resume !== undefined) {
    url.searchParams.set("sessionId", resume.sessionId);
    url.searchParams.set("resumeEpoch", String(resume.resumeEpoch));
    url.searchParams.set("afterSequence", String(resume.afterSequence));
  }
  return url.toString();
}

async function connect(
  playerId: string,
  resume?: Pick<ServerSessionMessage, "sessionId" | "resumeEpoch"> & {
    readonly afterSequence: number;
  },
): Promise<ConnectedSocket> {
  const socket = new WebSocket(webSocketUrl(playerId, resume));
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
  const message = await inbox.waitFor(
    (candidate) => candidate.type === "session",
    "session message",
  );
  if (message.type !== "session") throw new Error("unreachable session predicate mismatch");
  return { socket, inbox, session: message };
}

function send(socket: WebSocket, message: ClientMessage): void {
  socket.send(encodeProtocolMessage(message));
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close(1000, "smoke complete");
  await closed;
}

async function main(): Promise<void> {
  const health = await fetch(`${httpBase}/health`);
  if (!health.ok) throw new Error(`health check failed with ${health.status}`);

  const playerA = await connect("smoke_player_a");
  const playerB = await connect("smoke_player_b");

  send(playerA.socket, {
    version: 1,
    type: "ready",
    ready: true,
    idempotencyKey: "ready-smoke-a",
  });
  send(playerB.socket, {
    version: 1,
    type: "ready",
    ready: true,
    idempotencyKey: "ready-smoke-b",
  });
  const start = await playerA.inbox.waitFor(
    (message) => message.type === "canonical" && message.event.kind === "start",
    "canonical start",
  );
  if (start.type !== "canonical") throw new Error("unreachable start predicate mismatch");

  send(playerA.socket, {
    version: 1,
    type: "progress",
    sequence: 1,
    payload: { score: 7, normalizedProgress: 0.07, combo: 3, phase: "countdown" },
  });
  await playerB.inbox.waitFor(
    (message) => message.type === "progress" && message.playerId === "smoke_player_a",
    "relayed progress",
  );

  send(playerA.socket, {
    version: 1,
    type: "interaction",
    idempotencyKey: "freeze-smoke-a",
    action: "freeze",
    targetPlayerId: "smoke_player_b",
    payload: { durationMs: 1_250 },
  });
  const interaction = await playerB.inbox.waitFor(
    (message) =>
      message.type === "canonical" &&
      message.event.kind === "interaction" &&
      message.event.action === "freeze",
    "canonical freeze",
  );
  if (interaction.type !== "canonical") {
    throw new Error("unreachable interaction predicate mismatch");
  }
  if (interaction.event.sequence <= start.event.sequence) {
    throw new Error("canonical interaction sequence did not advance");
  }

  const oldSession = playerB.session;
  await close(playerB.socket);
  const resumedB = await connect("smoke_player_b", {
    sessionId: oldSession.sessionId,
    resumeEpoch: oldSession.resumeEpoch,
    afterSequence: 0,
  });
  const replay = await resumedB.inbox.waitFor(
    (message) => message.type === "replay" && message.events.length >= 2,
    "canonical replay after resume",
  );
  if (replay.type !== "replay") throw new Error("unreachable replay predicate mismatch");
  if (
    replay.events[0]?.kind !== "start" ||
    replay.events[1]?.kind !== "interaction" ||
    resumedB.session.resumeEpoch !== oldSession.resumeEpoch + 1
  ) {
    throw new Error("resume did not preserve ordered canonical history or epoch");
  }

  await Promise.all([close(playerA.socket), close(resumedB.socket)]);
  process.stdout.write(
    `Cloudflare smoke passed: room=${roomId}, canonical=${replay.events.length}, resumeEpoch=${resumedB.session.resumeEpoch}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
