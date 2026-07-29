import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  safeDecodeClientMessage,
  type ClientMessage,
} from "@relayplay/core";
import {
  asRoomEngineError,
  RoomEngine,
  RoomEngineError,
} from "@relayplay/server";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { AnonymousRoomError, AnonymousRoomService } from "./anonymous-rooms.js";
import { NodeRoomBroadcaster } from "./broadcaster.js";
import { guestCookieName, readCookie } from "./cookies.js";
import { NodeMetrics } from "./metrics.js";
import type { ResolvedNodeServerOptions } from "./options.js";
import { LocalTokenBucketLimiter } from "./rate-limit.js";
import { RoomAlarmScheduler } from "./room-alarms.js";

const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{8,128})\/ws$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const WEBSOCKET_QUERY_KEYS = new Set([
  "afterSequence",
  "playerId",
  "resumeEpoch",
  "sessionId",
]);

function connectionId(): string {
  return `connection_${randomBytes(16).toString("base64url")}`;
}

function queryInteger(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new RoomEngineError("INVALID_MESSAGE", `${key} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RoomEngineError("INVALID_MESSAGE", `${key} must be a safe integer`);
  }
  return value;
}

function queryIdentifier(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  if (!IDENTIFIER_PATTERN.test(raw)) {
    throw new RoomEngineError("INVALID_MESSAGE", `${key} must be an opaque identifier`);
  }
  return raw;
}

function assertAllowedQuery(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (!WEBSOCKET_QUERY_KEYS.has(key)) {
      throw new RoomEngineError("INVALID_MESSAGE", "unsupported WebSocket query parameter");
    }
  }
  for (const key of WEBSOCKET_QUERY_KEYS) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new RoomEngineError("INVALID_MESSAGE", "duplicate WebSocket query parameter");
    }
  }
}

function requestIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = raw?.split(",")[0]?.trim();
    if (candidate !== undefined && candidate.length > 0 && candidate.length <= 64) {
      return candidate;
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

function rejectUpgrade(socket: Duplex, status: number, code: string, retryAfterMs?: number): void {
  const body = JSON.stringify({ error: code });
  const reason = status === 401
    ? "Unauthorized"
    : status === 403
      ? "Forbidden"
      : status === 429
        ? "Too Many Requests"
        : status === 503
          ? "Service Unavailable"
          : "Bad Request";
  const retry = retryAfterMs === undefined
    ? ""
    : `Retry-After: ${String(Math.max(1, Math.ceil(retryAfterMs / 1_000)))}\r\n`;
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      "Cache-Control: no-store\r\n" +
      retry +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
  );
}

function textFrame(data: RawData, isBinary: boolean, maximumBytes: number): string {
  if (isBinary) throw new RoomEngineError("INVALID_MESSAGE", "binary messages are not accepted");
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.byteLength > maximumBytes) {
    throw new RoomEngineError("MESSAGE_TOO_LARGE", "WebSocket message exceeds the configured limit");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

export interface NodeWebSocketGatewayOptions {
  readonly engine: RoomEngine;
  readonly anonymousRooms: AnonymousRoomService;
  readonly broadcaster: NodeRoomBroadcaster;
  readonly alarms: RoomAlarmScheduler;
  readonly metrics: NodeMetrics;
  readonly server: ResolvedNodeServerOptions;
  readonly isReady: () => boolean;
}

/** Strict HTTP-upgrade boundary; game and room policy stay in RoomEngine. */
export class NodeWebSocketGateway {
  readonly #engine: RoomEngine;
  readonly #anonymousRooms: AnonymousRoomService;
  readonly #broadcaster: NodeRoomBroadcaster;
  readonly #alarms: RoomAlarmScheduler;
  readonly #metrics: NodeMetrics;
  readonly #options: ResolvedNodeServerOptions;
  readonly #isReady: () => boolean;
  readonly #webSockets: WebSocketServer;
  readonly #upgradeLimiter = new LocalTokenBucketLimiter({ capacity: 12, refillPerSecond: 2 });
  readonly #frameLimiter = new LocalTokenBucketLimiter({ capacity: 40, refillPerSecond: 20 });
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #connectionTasks = new Set<Promise<void>>();
  readonly #disconnectTasks = new Set<Promise<void>>();
  readonly #idleWaiters = new Set<() => void>();
  #closing = false;

  public constructor(options: NodeWebSocketGatewayOptions) {
    this.#engine = options.engine;
    this.#anonymousRooms = options.anonymousRooms;
    this.#broadcaster = options.broadcaster;
    this.#alarms = options.alarms;
    this.#metrics = options.metrics;
    this.#options = options.server;
    this.#isReady = options.isReady;
    this.#webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: this.#options.config.security.maxMessageBytes,
      perMessageDeflate: false,
      skipUTF8Validation: false,
    });
    this.#heartbeat = setInterval(
      () => this.#broadcaster.heartbeat(),
      this.#options.heartbeatIntervalMs,
    );
    this.#heartbeat.unref();
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = requestIp(request, this.#options.trustProxy);
    try {
      if (this.#closing || !this.#isReady()) {
        rejectUpgrade(socket, 503, "not_ready");
        return;
      }
      const origin = request.headers.origin;
      if (origin === undefined || !this.#options.allowedOrigins.has(origin)) {
        this.#metrics.increment("websocket_rejected");
        rejectUpgrade(socket, 403, "origin_not_allowed");
        return;
      }
      const retryAfter = this.#upgradeLimiter.consume(ip);
      if (retryAfter !== undefined) {
        this.#metrics.increment("websocket_rejected");
        rejectUpgrade(socket, 429, "upgrade_rate_limited", retryAfter);
        return;
      }
      if (
        this.#broadcaster.size >= this.#options.maxConnections ||
        this.#broadcaster.countIp(ip) >= this.#options.maxConnectionsPerIp
      ) {
        this.#metrics.increment("websocket_rejected");
        rejectUpgrade(socket, 429, "connection_limit");
        return;
      }
      const url = new URL(request.url ?? "/", "http://relayplay.invalid");
      assertAllowedQuery(url);
      const match = ROOM_PATH.exec(url.pathname);
      if (match?.[1] === undefined) {
        rejectUpgrade(socket, 400, "invalid_websocket_path");
        return;
      }
      const roomId = match[1];
      const cookie = readCookie(
        request.headers.cookie,
        guestCookieName(this.#options.secureCookies, this.#options.cookieName),
      );
      const guest = this.#anonymousRooms.authenticate(cookie);
      if (guest.roomId !== roomId) {
        rejectUpgrade(socket, 401, "credential_room_mismatch");
        return;
      }
      const resumeEpoch = queryInteger(url, "resumeEpoch");
      const afterSequence = queryInteger(url, "afterSequence");
      const requestedPlayerId = queryIdentifier(url, "playerId");
      const requestedSessionId = queryIdentifier(url, "sessionId");
      const nextConnectionId = connectionId();

      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#broadcaster.attachPending({
          connectionId: nextConnectionId,
          roomId,
          ip,
          socket: webSocket,
        });
        this.#metrics.increment("websocket_opened");
        webSocket.on("pong", () => this.#broadcaster.markAlive(nextConnectionId));

        const sessionPromise = this.#engine.connect({
          roomId,
          credential: cookie,
          connectionId: nextConnectionId,
          ...(requestedPlayerId === undefined ? {} : { requestedPlayerId }),
          ...(requestedSessionId === undefined ? {} : { requestedSessionId }),
          ...(resumeEpoch === undefined ? {} : { resumeEpoch }),
          ...(afterSequence === undefined ? {} : { afterSequence }),
          activateConnection: (session, replacedConnectionId) => {
            this.#broadcaster.activate(nextConnectionId, session, replacedConnectionId);
          },
        });
        this.#trackConnection(sessionPromise);

        webSocket.on("message", (data, isBinary) => {
          void sessionPromise
            .then(async (session) => {
              const frameRetry = this.#frameLimiter.consume(nextConnectionId);
              if (frameRetry !== undefined) {
                throw new RoomEngineError("RATE_LIMITED", "WebSocket frame rate exceeded", {
                  retriable: true,
                  retryAfterMs: frameRetry,
                });
              }
              const encoded = textFrame(
                data,
                isBinary,
                this.#options.config.security.maxMessageBytes,
              );
              const parsed = safeDecodeClientMessage(encoded, {
                maxMessageBytes: this.#options.config.security.maxMessageBytes,
                maxPayloadBytes: this.#options.config.security.maxPayloadBytes,
                maxReplayEvents: this.#options.config.room.eventLogCapacity,
              });
              if (!parsed.success) {
                const tooLarge = parsed.issues.some((issue) => issue.code === "too_large");
                throw new RoomEngineError(
                  tooLarge ? "MESSAGE_TOO_LARGE" : "INVALID_MESSAGE",
                  "WebSocket message failed strict protocol validation",
                );
              }
              await this.#engine.handle(session, parsed.data as ClientMessage);
              await this.#alarms.schedule(roomId);
            })
            .catch((error: unknown) => {
              this.#metrics.increment("frames_rejected");
              const roomError = asRoomEngineError(error);
              if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify(roomError.toSignal()), { compress: false });
                webSocket.close(1008, "invalid RelayPlay message");
              }
            });
        });

        let detached = false;
        const disconnect = (): void => {
          if (detached) return;
          detached = true;
          this.#disconnectConnection(nextConnectionId, roomId);
        };
        webSocket.once("close", disconnect);
        webSocket.once("error", () => {
          try {
            webSocket.terminate();
          } finally {
            disconnect();
          }
        });

        void sessionPromise
          .then(() => this.#alarms.schedule(roomId))
          .catch((error: unknown) => {
            const roomError = asRoomEngineError(error);
            if (webSocket.readyState === WebSocket.OPEN) {
              webSocket.send(JSON.stringify(roomError.toSignal()), { compress: false });
              webSocket.close(1008, "RelayPlay connection rejected");
            }
          });
      });
    } catch (error) {
      this.#metrics.increment("websocket_rejected");
      if (error instanceof AnonymousRoomError) {
        rejectUpgrade(socket, 401, "credential_invalid");
        return;
      }
      const roomError = asRoomEngineError(error);
      rejectUpgrade(socket, roomError.code === "AUTH_FAILED" ? 401 : 400, roomError.code);
    }
  }

  public close(): void {
    if (this.#closing) return;
    this.#closing = true;
    clearInterval(this.#heartbeat);
    this.#webSockets.close();
  }

  /** Resolves only after every socket and connect/disconnect storage task is gone. */
  public waitForIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  /** Last-resort shutdown path used after the graceful drain deadline. */
  public async forceDisconnectAll(): Promise<void> {
    for (const record of this.#broadcaster.records()) {
      try {
        record.socket.terminate();
      } finally {
        this.#disconnectConnection(record.connectionId, record.roomId);
      }
    }
    await this.waitForIdle();
  }

  #trackConnection(connection: Promise<unknown>): void {
    const tracked = connection.then(
      () => undefined,
      () => undefined,
    );
    this.#connectionTasks.add(tracked);
    void tracked.then(() => {
      this.#connectionTasks.delete(tracked);
      this.#notifyIdle();
    });
  }

  #disconnectConnection(connectionId: string, roomId: string): void {
    const record = this.#broadcaster.detach(connectionId);
    const session = record?.session;
    if (record === undefined || session === undefined || record.superseded) {
      this.#notifyIdle();
      return;
    }
    const task = (async (): Promise<void> => {
      try {
        await this.#engine.disconnect(session);
        await this.#alarms.schedule(roomId);
      } catch {
        this.#options.logger.error("websocket_disconnect_failed", { roomId });
      }
    })();
    this.#disconnectTasks.add(task);
    void task.then(() => {
      this.#disconnectTasks.delete(task);
      this.#notifyIdle();
    });
  }

  #isIdle(): boolean {
    return this.#broadcaster.size === 0 &&
      this.#connectionTasks.size === 0 &&
      this.#disconnectTasks.size === 0;
  }

  #notifyIdle(): void {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
