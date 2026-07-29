import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "@relayplay/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createRelayPlayNodeServer, type RelayPlayNodeServer } from "../src/index.js";

const ORIGIN = "http://127.0.0.1:5173";
const directories: string[] = [];
const servers: RelayPlayNodeServer[] = [];

interface GuestResponse {
  readonly roomId: string;
  readonly playerId: string;
  readonly invite?: string;
  readonly webSocketPath: string;
}

interface GuestHttpResult {
  readonly guest: GuestResponse;
  readonly cookie: string;
}

interface TestSocket {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
}

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "relayplay-server-test-"));
  directories.push(directory);
  return join(directory, "relayplay.sqlite");
}

async function startServer(): Promise<RelayPlayNodeServer> {
  const server = createRelayPlayNodeServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: tempDatabase(),
    allowedOrigins: [ORIGIN],
    insecureDevelopment: true,
    secureCookies: false,
    heartbeatIntervalMs: 5_000,
    config: {
      room: { maxPlayers: 4, disconnectGraceMs: 100 },
      time: { startLeadMs: 20, sync: { enabled: false } },
      security: {
        rateLimits: {
          default: { capacity: 100, refillPerSecond: 100 },
          actions: {
            message: { capacity: 100, refillPerSecond: 100 },
            progress: { capacity: 100, refillPerSecond: 100 },
            finish: { capacity: 100, refillPerSecond: 100 },
          },
        },
      },
    },
  });
  servers.push(server);
  await server.start();
  return server;
}

async function post(
  server: RelayPlayNodeServer,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly response: Response; readonly json: Record<string, unknown> }> {
  const response = await fetch(`${server.address().origin}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() as Record<string, unknown> };
}

function guestResult(
  response: Response,
  json: Record<string, unknown>,
): GuestHttpResult {
  const setCookie = response.headers.get("set-cookie");
  if (
    setCookie === null ||
    typeof json["roomId"] !== "string" ||
    typeof json["playerId"] !== "string" ||
    typeof json["webSocketPath"] !== "string"
  ) {
    throw new Error("invalid guest response");
  }
  const invite = typeof json["invite"] === "string" ? json["invite"] : undefined;
  return {
    guest: {
      roomId: json["roomId"],
      playerId: json["playerId"],
      webSocketPath: json["webSocketPath"],
      ...(invite === undefined ? {} : { invite }),
    },
    cookie: setCookie.split(";", 1)[0] ?? "",
  };
}

async function createGuest(server: RelayPlayNodeServer): Promise<GuestHttpResult> {
  const { response, json } = await post(server, "/api/rooms", {});
  expect(response.status).toBe(201);
  return guestResult(response, json);
}

async function joinGuest(server: RelayPlayNodeServer, invite: string): Promise<GuestHttpResult> {
  const { response, json } = await post(server, "/api/join", { invite });
  expect(response.status).toBe(201);
  return guestResult(response, json);
}

async function openGuestSocket(
  server: RelayPlayNodeServer,
  guest: GuestHttpResult,
  query = "",
): Promise<TestSocket> {
  const address = server.address();
  const url = `ws://127.0.0.1:${String(address.port)}${guest.guest.webSocketPath}${query}`;
  const socket = new WebSocket(url, {
    origin: ORIGIN,
    headers: { Cookie: guest.cookie },
    perMessageDeflate: false,
  });
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor(
  client: TestSocket,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 2_000,
): Promise<ServerMessage> {
  const existing = client.messages.find(predicate);
  if (existing !== undefined) return existing;
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off("message", onMessage);
      reject(
        new Error(
          `timed out waiting for server message; received ${JSON.stringify(client.messages)}`,
        ),
      );
    }, timeoutMs);
    const onMessage = (): void => {
      const found = client.messages.find(predicate);
      if (found === undefined) return;
      clearTimeout(timer);
      client.socket.off("message", onMessage);
      resolve(found);
    };
    client.socket.on("message", onMessage);
  });
}

function send(client: TestSocket, message: ClientMessage): void {
  client.socket.send(JSON.stringify(message));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RelayPlayNodeServer", () => {
  it("creates an anonymous max-four room without exposing the credential in JSON", async () => {
    const server = await startServer();
    const host = await createGuest(server);
    const invite = host.guest.invite;
    if (invite === undefined) throw new Error("creator response omitted invite");
    const joined = await Promise.all([
      joinGuest(server, invite),
      joinGuest(server, invite),
      joinGuest(server, invite),
    ]);
    expect(new Set([host.guest.playerId, ...joined.map((entry) => entry.guest.playerId)]).size)
      .toBe(4);
    const fifth = await post(server, "/api/join", { invite });
    expect(fifth.response.status).toBe(409);
    expect(fifth.json).toEqual({ ok: false, error: "room_full" });
    expect(host.cookie).toContain("relayplay_guest=");
    expect(host.cookie).not.toContain(invite);
  });

  it("rejects unapproved origins and query-string credentials", async () => {
    const server = await startServer();
    const denied = await fetch(`${server.address().origin}/api/rooms`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    const host = await createGuest(server);
    const address = server.address();
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(address.port)}${host.guest.webSocketPath}?token=forbidden`,
        { origin: ORIGIN, headers: { Cookie: host.cookie } },
      );
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    });
    expect(status).toBe(400);
  });

  it("runs a real two-WebSocket start, progress, and authoritative finish lifecycle", async () => {
    const server = await startServer();
    const host = await createGuest(server);
    const invite = host.guest.invite;
    if (invite === undefined) throw new Error("creator response omitted invite");
    const guest = await joinGuest(server, invite);
    const first = await openGuestSocket(server, host);
    const second = await openGuestSocket(server, guest);
    const firstSession = await waitFor(first, (message) => message.type === "session");
    const secondSession = await waitFor(second, (message) => message.type === "session");
    expect(firstSession).toMatchObject({ type: "session", resumed: false, lastProgressSequence: -1 });
    expect(secondSession).toMatchObject({ type: "session", resumed: false, lastProgressSequence: -1 });
    expect(await waitFor(second, (message) => message.type === "snapshot")).toMatchObject({
      type: "snapshot",
      players: expect.arrayContaining([
        expect.objectContaining({ playerId: host.guest.playerId }),
        expect.objectContaining({ playerId: guest.guest.playerId }),
      ]),
    });

    send(first, { version: 1, type: "ready", ready: true, idempotencyKey: "ready:first:01" });
    send(second, { version: 1, type: "ready", ready: true, idempotencyKey: "ready:second:01" });
    await Promise.all([
      waitFor(first, (message) => message.type === "canonical" && message.event.kind === "start"),
      waitFor(second, (message) => message.type === "canonical" && message.event.kind === "start"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    send(first, { version: 1, type: "progress", sequence: 1, payload: { checkpoint: 3 } });
    expect(await waitFor(second, (message) => message.type === "progress")).toMatchObject({
      type: "progress",
      playerId: host.guest.playerId,
      sequence: 1,
      payload: { checkpoint: 3 },
    });

    send(first, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish:first:01",
      payload: { checkpoint: 10 },
    });
    const firstFinish = await waitFor(
      second,
      (message) => message.type === "canonical" && message.event.kind === "finish",
    );
    expect(firstFinish).toMatchObject({
      type: "canonical",
      event: { payload: { reason: "completed", placement: 1 } },
    });
    send(second, {
      version: 1,
      type: "finish",
      idempotencyKey: "finish:second:01",
      payload: { checkpoint: 10 },
    });
    await waitFor(
      first,
      (message) =>
        message.type === "canonical" &&
        message.event.kind === "finish" &&
        message.event.playerId === guest.guest.playerId,
    );
    expect((await server.engine.getSnapshot(host.guest.roomId)).room.status).toBe("finished");
    first.socket.close();
    second.socket.close();
  });
});
