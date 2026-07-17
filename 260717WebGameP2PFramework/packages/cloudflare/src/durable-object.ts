import { DurableObject } from "cloudflare:workers";
import {
  asRoomEngineError,
  RoomEngine,
  RoomEngineError,
} from "@relayplay/server";

import { DurableObjectBroadcaster, readWebSocketAttachment } from "./broadcaster.js";
import { parseRoomCommand } from "./protocol.js";
import { CloudflareRoomStorage } from "./storage.js";
import type {
  CloudflareRoomOptions,
  RelayPlayCloudflareEnv,
  WebSocketAttachment,
} from "./types.js";

const ROOM_ID_STORAGE_KEY = "relayplay:room-id";

function queryInteger(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RoomEngineError("INVALID_MESSAGE", `${key} must be a non-negative integer`);
  }
  return value;
}

function bearerCredential(request: Request, url: URL): string | undefined {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ") === true) {
    return authorization.slice("Bearer ".length);
  }
  return url.searchParams.get("token") ?? undefined;
}

function randomConnectionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `connection_${value}`;
}

function responseForError(error: unknown): Response {
  const roomError = asRoomEngineError(error);
  const status =
    roomError.code === "AUTH_FAILED"
      ? 401
      : roomError.code === "RATE_LIMITED"
        ? 429
        : roomError.code === "ROOM_FULL" ||
            roomError.code === "ROOM_ALREADY_STARTED" ||
            roomError.code === "RESUME_EPOCH_MISMATCH" ||
            roomError.code === "ROOM_EPOCH_MISMATCH" ||
            roomError.code === "SESSION_REPLACED"
        ? 409
        : roomError.code === "INTERNAL_ERROR"
          ? 500
          : 400;
  const headers = new Headers();
  if (roomError.retryAfterMs !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(roomError.retryAfterMs / 1_000))));
  }
  return Response.json(roomError.toSignal(), { status, headers });
}

function encodeSocketMessage(message: string | ArrayBuffer): string {
  if (typeof message === "string") {
    return message;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(message);
  } catch (error) {
    throw new TypeError("binary WebSocket messages must contain valid UTF-8", { cause: error });
  }
}

export interface RelayPlayDurableObjectInstance {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  webSocketError(socket: WebSocket, error: unknown): Promise<void>;
}

export interface RelayPlayDurableObjectConstructor<Env> {
  new (state: DurableObjectState, env: Env): RelayPlayDurableObjectInstance;
}

/**
 * Creates a Durable Object class while keeping application authentication and
 * ruleset policy explicit. Export the returned class from the Worker entrypoint.
 */
export function createRelayPlayDurableObject<Env>(
  options: CloudflareRoomOptions<Env>,
): RelayPlayDurableObjectConstructor<Env> {
  return class RelayPlayRoomDurableObject
    extends DurableObject<Env>
    implements RelayPlayDurableObjectInstance
  {
    readonly #state: DurableObjectState;
    readonly #engine: RoomEngine;

    public constructor(state: DurableObjectState, env: Env) {
      super(state, env);
      this.#state = state;
      const storage = new CloudflareRoomStorage(state.storage);
      const broadcaster = new DurableObjectBroadcaster(state);
      this.#engine = new RoomEngine({
        storage,
        broadcaster,
        authenticate: (request) => options.authenticate(request, env),
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.validateInteraction === undefined
          ? {}
          : { validateInteraction: options.validateInteraction }),
        ...(options.verifyReplay === undefined
          ? {}
          : { verifyReplay: options.verifyReplay }),
        ...(options.minimumPlayersToStart === undefined
          ? {}
          : { minimumPlayersToStart: options.minimumPlayersToStart }),
        ...(options.replayBatchSize === undefined
          ? {}
          : { replayBatchSize: options.replayBatchSize }),
      });
    }

    public override async fetch(request: Request): Promise<Response> {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json(
          { error: "websocket_upgrade_required" },
          { status: 426, headers: { Upgrade: "websocket" } },
        );
      }

      const url = new URL(request.url);
      const roomId = url.searchParams.get("roomId");
      if (roomId === null) {
        return Response.json({ error: "room_id_required" }, { status: 400 });
      }

      let resumeEpoch: number | undefined;
      let afterSequence: number | undefined;
      try {
        resumeEpoch = queryInteger(url, "resumeEpoch");
        afterSequence = queryInteger(url, "afterSequence");
      } catch (error) {
        return responseForError(error);
      }

      const connectionId = randomConnectionId();
      const requestedPlayerId = url.searchParams.get("playerId");
      const requestedSessionId = url.searchParams.get("sessionId");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const pendingAttachment: WebSocketAttachment = {
        version: 1,
        roomId,
        connectionId,
      };
      server.serializeAttachment(pendingAttachment);
      this.#state.acceptWebSocket(server, [
        `room:${roomId}`,
        `connection:${connectionId}`,
      ]);

      try {
        let credential: unknown;
        try {
          credential =
            options.extractCredential === undefined
              ? bearerCredential(request, url)
              : await options.extractCredential(request, this.env);
        } catch (error) {
          throw new RoomEngineError("AUTH_FAILED", "credential extraction failed", {
            cause: error,
          });
        }
        const session = await this.#engine.connect({
          roomId,
          credential,
          connectionId,
          ...(requestedPlayerId === null ? {} : { requestedPlayerId }),
          ...(requestedSessionId === null ? {} : { requestedSessionId }),
          ...(resumeEpoch === undefined ? {} : { resumeEpoch }),
          ...(afterSequence === undefined ? {} : { afterSequence }),
        });
        server.serializeAttachment({
          version: 1,
          roomId,
          connectionId,
          playerId: session.playerId,
          session,
        } satisfies WebSocketAttachment);
        await this.#state.storage.put(ROOM_ID_STORAGE_KEY, roomId);
        await this.#scheduleAlarm(roomId);
        return new Response(null, { status: 101, webSocket: client });
      } catch (error) {
        server.close(1008, "RelayPlay connection rejected");
        return responseForError(error);
      }
    }

    public override async webSocketMessage(
      socket: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      const attachment = readWebSocketAttachment(socket);
      if (attachment?.session === undefined) {
        socket.close(1008, "Missing authenticated session");
        return;
      }

      try {
        if (
          message instanceof ArrayBuffer &&
          message.byteLength > this.#engine.config.security.maxMessageBytes
        ) {
          throw new RoomEngineError("MESSAGE_TOO_LARGE", "WebSocket message is too large");
        }
        const encoded = encodeSocketMessage(message);
        const command = parseRoomCommand(encoded, {
          maxMessageBytes: this.#engine.config.security.maxMessageBytes,
          maxPayloadBytes: this.#engine.config.security.maxPayloadBytes,
          maxReplayEvents: this.#engine.config.room.eventLogCapacity,
        });
        await this.#engine.handle(attachment.session, command);
        await this.#scheduleAlarm(attachment.roomId);
      } catch (error) {
        const roomError = asRoomEngineError(error);
        try {
          socket.send(JSON.stringify(roomError.toSignal()));
        } finally {
          socket.close(1008, "Invalid RelayPlay message");
        }
      }
    }

    public override async webSocketClose(
      socket: WebSocket,
      _code: number,
      _reason: string,
      _wasClean: boolean,
    ): Promise<void> {
      await this.#disconnectSocket(socket);
    }

    public override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
      await this.#disconnectSocket(socket);
    }

    public override async alarm(): Promise<void> {
      const roomId = await this.#state.storage.get<string>(ROOM_ID_STORAGE_KEY);
      if (roomId === undefined) {
        return;
      }
      await this.#engine.sweep(roomId);
      await this.#scheduleAlarm(roomId);
    }

    async #disconnectSocket(socket: WebSocket): Promise<void> {
      const attachment = readWebSocketAttachment(socket);
      if (attachment?.session === undefined) {
        return;
      }
      await this.#engine.disconnect(attachment.session);
      await this.#scheduleAlarm(attachment.roomId);
    }

    async #scheduleAlarm(roomId: string): Promise<void> {
      const next = await this.#engine.nextAlarmAt(roomId);
      if (next === undefined) {
        await this.#state.storage.deleteAlarm();
        return;
      }
      await this.#state.storage.setAlarm(Math.max(Date.now() + 1, next));
    }
  };
}

const InsecureDevelopmentRoom = createRelayPlayDurableObject<RelayPlayCloudflareEnv>({
  authenticate: (request, env) => {
    if (
      env.RELAYPLAY_INSECURE_DEV_TOKEN === undefined ||
      request.credential !== env.RELAYPLAY_INSECURE_DEV_TOKEN ||
      request.requestedPlayerId === undefined
    ) {
      throw new Error("development token or player identity is invalid");
    }
    return {
      playerId: request.requestedPlayerId,
      ...(request.requestedSessionId === undefined
        ? {}
        : { sessionId: request.requestedSessionId }),
      roles: ["player"],
    };
  },
});

/**
 * Convenience class for `wrangler dev` only. Production should export a class
 * from createRelayPlayDurableObject() with real token verification.
 */
export class RelayPlayDurableObject extends InsecureDevelopmentRoom {}
