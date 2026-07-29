import type { IncomingMessage, ServerResponse } from "node:http";
import { isPlainObject } from "@relayplay/core";

import {
  AnonymousRoomError,
  AnonymousRoomService,
  type AnonymousGuestAccess,
} from "./anonymous-rooms.js";
import { serializeGuestCookie } from "./cookies.js";
import { NodeMetrics } from "./metrics.js";
import type { ResolvedNodeServerOptions } from "./options.js";
import { LocalTokenBucketLimiter } from "./rate-limit.js";

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
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

function applyBaseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): void {
  const encoded = JSON.stringify(body);
  applyBaseHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(encoded);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new HttpControlError(415, "json_required");
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new HttpControlError(413, "request_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new HttpControlError(413, "request_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpControlError(400, "invalid_json");
  }
}

class HttpControlError extends Error {
  public constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

function anonymousError(error: AnonymousRoomError): HttpControlError {
  switch (error.code) {
    case "INVITE_INVALID":
      return new HttpControlError(404, "invite_invalid");
    case "ROOM_FULL":
      return new HttpControlError(409, "room_full");
    case "ROOM_LIMIT":
      return new HttpControlError(503, "room_limit");
    case "ROOM_UNAVAILABLE":
      return new HttpControlError(409, "room_unavailable");
    case "CREDENTIAL_INVALID":
      return new HttpControlError(401, "credential_invalid");
  }
}

export interface HttpControlPlaneOptions {
  readonly anonymousRooms: AnonymousRoomService;
  readonly metrics: NodeMetrics;
  readonly server: ResolvedNodeServerOptions;
  readonly isReady: () => boolean;
  readonly activeConnections: () => number;
  readonly storageReady: () => boolean;
}

/** Accountless room HTTP API, deliberately separate from the WebSocket data plane. */
export class HttpControlPlane {
  readonly #anonymousRooms: AnonymousRoomService;
  readonly #metrics: NodeMetrics;
  readonly #options: ResolvedNodeServerOptions;
  readonly #isReady: () => boolean;
  readonly #activeConnections: () => number;
  readonly #storageReady: () => boolean;
  readonly #mutateLimiter = new LocalTokenBucketLimiter({ capacity: 20, refillPerSecond: 2 });
  readonly #joinLimiter = new LocalTokenBucketLimiter({ capacity: 8, refillPerSecond: 0.5 });

  public constructor(options: HttpControlPlaneOptions) {
    this.#anonymousRooms = options.anonymousRooms;
    this.#metrics = options.metrics;
    this.#options = options.server;
    this.#isReady = options.isReady;
    this.#activeConnections = options.activeConnections;
    this.#storageReady = options.storageReady;
  }

  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://relayplay.invalid");
      if (request.method === "GET" && url.pathname === "/livez") {
        writeJson(response, 200, { ok: true, service: "relayplay-node" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const ready = this.#isReady() && this.#storageReady();
        writeJson(response, ready ? 200 : 503, { ok: ready, service: "relayplay-node" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics" && this.#options.exposeMetrics) {
        const encoded = this.#metrics.prometheus(this.#activeConnections(), this.#isReady());
        applyBaseHeaders(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        response.setHeader("Content-Length", Buffer.byteLength(encoded));
        response.end(encoded);
        return;
      }

      const origin = request.headers.origin;
      if (origin === undefined || !this.#options.allowedOrigins.has(origin)) {
        throw new HttpControlError(403, "origin_not_allowed");
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
        applyBaseHeaders(response);
        response.end();
        return;
      }
      if (!this.#isReady()) throw new HttpControlError(503, "not_ready");
      if (request.method !== "POST") throw new HttpControlError(405, "method_not_allowed");

      const ip = clientIp(request, this.#options.trustProxy);
      const retryAfter = this.#mutateLimiter.consume(ip);
      if (retryAfter !== undefined) throw new HttpControlError(429, "rate_limited", retryAfter);
      const body = await readJsonBody(request, this.#options.maxRequestBodyBytes);
      if (!isPlainObject(body)) throw new HttpControlError(400, "object_body_required");

      if (url.pathname === "/api/rooms") {
        if (Object.keys(body).length !== 0) throw new HttpControlError(400, "unknown_field");
        const created = this.#anonymousRooms.createRoom();
        this.#metrics.increment("rooms_created");
        this.#writeGuest(response, created, {
          ok: true,
          roomId: created.roomId,
          playerId: created.playerId,
          invite: created.invite,
          roomExpiresAt: created.roomExpiresAt,
          webSocketPath: `/rooms/${created.roomId}/ws`,
        });
        return;
      }

      if (url.pathname === "/api/join") {
        const keys = Object.keys(body);
        if (keys.length !== 1 || keys[0] !== "invite" || typeof body.invite !== "string") {
          throw new HttpControlError(400, "invite_required");
        }
        const joinRetry = this.#joinLimiter.consume(ip);
        if (joinRetry !== undefined) {
          throw new HttpControlError(429, "join_rate_limited", joinRetry);
        }
        const guest = this.#anonymousRooms.joinRoom(body.invite);
        this.#metrics.increment("guests_joined");
        this.#writeGuest(response, guest, {
          ok: true,
          roomId: guest.roomId,
          playerId: guest.playerId,
          webSocketPath: `/rooms/${guest.roomId}/ws`,
        });
        return;
      }

      throw new HttpControlError(404, "not_found");
    } catch (error) {
      this.#metrics.increment("http_rejected");
      const mapped = error instanceof HttpControlError
        ? error
        : error instanceof AnonymousRoomError
          ? anonymousError(error)
          : new HttpControlError(500, "internal_error");
      writeJson(
        response,
        mapped.status,
        { ok: false, error: mapped.code },
        mapped.retryAfterMs === undefined
          ? {}
          : { "Retry-After": String(Math.max(1, Math.ceil(mapped.retryAfterMs / 1_000))) },
      );
    }
  }

  #writeGuest(
    response: ServerResponse,
    guest: AnonymousGuestAccess,
    body: Readonly<Record<string, unknown>>,
  ): void {
    const now = Date.now();
    writeJson(response, 201, body, {
      "Set-Cookie": serializeGuestCookie({
        ...(this.#options.cookieName === undefined ? {} : { name: this.#options.cookieName }),
        secure: this.#options.secureCookies,
        roomId: guest.roomId,
        credential: guest.credential,
        expiresAt: guest.credentialExpiresAt,
        now,
      }),
    });
  }
}
