import {
  jsonByteLength,
  isPlainObject,
  normalizeConfig,
  validateJsonValue,
  type JsonValue,
  type RateLimitConfig,
  type RelayPlayConfig,
} from "@relayplay/core";

import { asRoomEngineError, RoomEngineError } from "./errors.js";
import { systemClock, systemIds } from "./ids.js";
import type {
  CanonicalCommitResult,
  CanonicalEvent,
  AuthResult,
  Clock,
  ConnectRequest,
  EffectiveAt,
  EvidenceCommand,
  IdGenerator,
  InteractionCommand,
  InteractionValidator,
  ReplayVerifier,
  RoomBroadcaster,
  RoomCommand,
  RoomEngineOptions,
  RoomSession,
  RoomSignal,
  RoomSnapshot,
  RoomStorage,
  StoredRoom,
  StoredSession,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/u;

class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  public async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this.#tails.set(key, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === next) {
        this.#tails.delete(key);
      }
    }
  }
}

function requireIdentifier(label: string, value: string): void {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new RoomEngineError(
      "INVALID_IDENTIFIER",
      `${label} must be an opaque 8-128 character identifier`,
    );
  }
}

function assertJsonRecord(
  label: string,
  value: Readonly<Record<string, JsonValue>> | undefined,
  maximumBytes: number,
): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  assertPayload(value, maximumBytes);
}

function assertAuthResult(result: AuthResult, maximumBytes: number): void {
  requireIdentifier("playerId", result.playerId);
  if (result.sessionId !== undefined) {
    requireIdentifier("sessionId", result.sessionId);
  }
  if (
    result.roles !== undefined &&
    (!Array.isArray(result.roles) ||
      result.roles.length > 32 ||
      result.roles.some(
        (role) => typeof role !== "string" || role.length === 0 || role.length > 64,
      ))
  ) {
    throw new TypeError("authenticated roles are invalid");
  }
  assertJsonRecord("authenticated metadata", result.metadata, maximumBytes);
}

function requireNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RoomEngineError("INVALID_MESSAGE", `${label} must be a non-negative integer`);
  }
}

function requireIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new RoomEngineError(
      "INVALID_MESSAGE",
      "idempotencyKey must contain 8-128 safe characters",
    );
  }
}

function assertPayload(payload: JsonValue, maximumBytes: number): void {
  const issues = validateJsonValue(payload);
  if (issues.length > 0) {
    throw new RoomEngineError("INVALID_MESSAGE", "payload is not bounded JSON data");
  }
  if (jsonByteLength(payload) > maximumBytes) {
    throw new RoomEngineError(
      "MESSAGE_TOO_LARGE",
      `payload exceeds the ${String(maximumBytes)} byte limit`,
    );
  }
}

function normalizeEffectiveAt(
  requested: EffectiveAt | undefined,
  room: StoredRoom,
  now: number,
  config: RelayPlayConfig,
): EffectiveAt | undefined {
  if (!config.features.interactions.scheduled) {
    if (requested !== undefined) {
      throw new RoomEngineError(
        "INVALID_MESSAGE",
        "this room does not accept scheduled interactions",
      );
    }
    return undefined;
  }

  const minimumServerTime = Math.max(
    now + config.time.interactionLeadMs,
    room.startAt ?? 0,
  );
  if (requested === undefined || requested.kind === "server-time") {
    const requestedTime = requested?.serverTimeMs ?? minimumServerTime;
    if (!Number.isFinite(requestedTime)) {
      throw new RoomEngineError("INVALID_MESSAGE", "effective server time must be finite");
    }
    return {
      kind: "server-time",
      serverTimeMs: Math.max(requestedTime, minimumServerTime),
    };
  }

  if (requested.kind === "tick") {
    requireNonNegativeInteger("effective tick", requested.tick);
  } else if (requested.kind === "beat") {
    if (!Number.isFinite(requested.beat) || requested.beat < 0) {
      throw new RoomEngineError("INVALID_MESSAGE", "effective beat must be non-negative");
    }
  } else if (!ACTION_PATTERN.test(requested.name)) {
    throw new RoomEngineError("INVALID_MESSAGE", "effective boundary name is invalid");
  }
  return requested;
}

function sessionMetadata(
  request: ConnectRequest,
  authenticated: Awaited<ReturnType<RoomEngineOptions["authenticate"]>>,
): Readonly<Record<string, JsonValue>> {
  return { ...(request.metadata ?? {}), ...(authenticated.metadata ?? {}) };
}

/**
 * Authoritative, provider-neutral room state machine.
 *
 * All mutations for a room are serialized. Canonical event sequencing,
 * idempotency and persistence remain an atomic responsibility of RoomStorage.
 */
export class RoomEngine {
  readonly #storage: RoomStorage;
  readonly #broadcaster: RoomBroadcaster;
  readonly #authenticate: RoomEngineOptions["authenticate"];
  readonly #config: RelayPlayConfig;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #validateInteraction: InteractionValidator | undefined;
  readonly #verifyReplay: ReplayVerifier | undefined;
  readonly #minimumPlayersToStart: number;
  readonly #replayBatchSize: number;
  readonly #queue = new KeyedSerialQueue();
  readonly #initialized: Promise<void>;

  public constructor(options: RoomEngineOptions) {
    this.#storage = options.storage;
    this.#broadcaster = options.broadcaster;
    this.#authenticate = options.authenticate;
    this.#config = normalizeConfig(options.config);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? systemIds;
    this.#validateInteraction = options.validateInteraction;
    this.#verifyReplay = options.verifyReplay;
    this.#minimumPlayersToStart =
      options.minimumPlayersToStart ?? Math.min(2, this.#config.room.maxPlayers);
    this.#replayBatchSize = options.replayBatchSize ?? 512;
    if (
      !Number.isSafeInteger(this.#minimumPlayersToStart) ||
      this.#minimumPlayersToStart < 1 ||
      this.#minimumPlayersToStart > this.#config.room.maxPlayers
    ) {
      throw new RangeError("minimumPlayersToStart must fit within room.maxPlayers");
    }
    if (!Number.isSafeInteger(this.#replayBatchSize) || this.#replayBatchSize < 1) {
      throw new RangeError("replayBatchSize must be a positive integer");
    }
    this.#initialized = Promise.resolve(this.#storage.initialize());
  }

  public get config(): RelayPlayConfig {
    return this.#config;
  }

  public async connect(request: ConnectRequest): Promise<RoomSession> {
    await this.#initialized;
    requireIdentifier("roomId", request.roomId);
    requireIdentifier("connectionId", request.connectionId);
    assertJsonRecord(
      "connection metadata",
      request.metadata,
      this.#config.security.maxPayloadBytes,
    );

    let authenticated: Awaited<ReturnType<RoomEngineOptions["authenticate"]>>;
    try {
      authenticated = await this.#authenticate({
        roomId: request.roomId,
        credential: request.credential,
        connectionId: request.connectionId,
        ...(request.requestedPlayerId === undefined
          ? {}
          : { requestedPlayerId: request.requestedPlayerId }),
        ...(request.requestedSessionId === undefined
          ? {}
          : { requestedSessionId: request.requestedSessionId }),
        ...(request.resumeEpoch === undefined ? {} : { resumeEpoch: request.resumeEpoch }),
        metadata: request.metadata ?? {},
      });
      assertAuthResult(authenticated, this.#config.security.maxPayloadBytes);
    } catch (error) {
      throw new RoomEngineError("AUTH_FAILED", "room authentication failed", { cause: error });
    }
    return this.#queue.run(request.roomId, async () => {
      const now = this.#now();
      const room = await this.#storage.ensureRoom(request.roomId, now);
      const existing = await this.#storage.getSession(request.roomId, authenticated.playerId);
      let session: StoredSession;

      if (existing === undefined) {
        if (room.status !== "waiting") {
          throw new RoomEngineError(
            "ROOM_ALREADY_STARTED",
            "new players cannot join a room after its start is scheduled",
          );
        }
        const sessions = await this.#storage.listSessions(request.roomId);
        if (sessions.length >= this.#config.room.maxPlayers) {
          throw new RoomEngineError("ROOM_FULL", "the room has reached its player limit");
        }
        const sessionId = authenticated.sessionId ?? this.#ids.sessionId();
        requireIdentifier("sessionId", sessionId);
        session = {
          roomId: request.roomId,
          playerId: authenticated.playerId,
          sessionId,
          resumeEpoch: 1,
          connectionId: request.connectionId,
          ready: false,
          connected: true,
          joinedAt: now,
          lastSeenAt: now,
          lastAcknowledgedSequence: 0,
          lastProgressSequence: -1,
          roles: authenticated.roles ?? [],
          metadata: sessionMetadata(request, authenticated),
        };
      } else {
        const assertedSessionId = authenticated.sessionId ?? request.requestedSessionId;
        if (assertedSessionId !== undefined && assertedSessionId !== existing.sessionId) {
          throw new RoomEngineError("AUTH_FAILED", "authenticated session does not match");
        }
        if (
          this.#config.security.requireResumeEpoch &&
          request.resumeEpoch !== existing.resumeEpoch
        ) {
          throw new RoomEngineError(
            "RESUME_EPOCH_MISMATCH",
            "resume epoch is stale or missing",
          );
        }
        session = {
          ...existing,
          resumeEpoch: existing.resumeEpoch + 1,
          connectionId: request.connectionId,
          connected: true,
          lastSeenAt: now,
          roles: authenticated.roles ?? existing.roles,
          metadata: { ...existing.metadata, ...sessionMetadata(request, authenticated) },
        };
      }

      const replay =
        request.afterSequence === undefined
          ? undefined
          : await this.#createReplaySignal(room, room.roomEpoch, request.afterSequence);

      await this.#storage.putSession(session);
      await this.#broadcaster.send(request.connectionId, {
        version: 1,
        type: "session",
        roomId: room.roomId,
        roomEpoch: room.roomEpoch,
        playerId: session.playerId,
        sessionId: session.sessionId,
        resumeEpoch: session.resumeEpoch,
        status: room.status,
        lastSequence: room.lastSequence,
      });
      await this.#broadcaster.broadcast(room.roomId, {
        version: 1,
        type: "presence",
        playerId: session.playerId,
        connected: true,
        ready: session.ready,
      });

      if (replay !== undefined) {
        await this.#broadcaster.send(session.connectionId, replay);
      }
      if (session.ready && room.status === "waiting") {
        await this.#maybeScheduleStart(room);
      }
      return session;
    });
  }

  public async disconnect(session: RoomSession): Promise<void> {
    await this.#initialized;
    await this.#queue.run(session.roomId, async () => {
      const current = await this.#storage.getSession(session.roomId, session.playerId);
      if (current === undefined || current.connectionId !== session.connectionId) {
        return;
      }
      const now = this.#now();
      const disconnected: StoredSession = {
        ...current,
        connected: false,
        lastSeenAt: now,
        disconnectedAt: now,
      };
      await this.#storage.putSession(disconnected);
      await this.#broadcaster.broadcast(session.roomId, {
        version: 1,
        type: "presence",
        playerId: session.playerId,
        connected: false,
        ready: session.ready,
      });
    });
  }

  /** Handles a validated command and returns any error signal sent to the caller. */
  public async handle(session: RoomSession, command: RoomCommand): Promise<RoomSignal | undefined> {
    await this.#initialized;
    try {
      await this.#queue.run(session.roomId, async () => {
        const current = await this.#assertLiveSession(session);
        await this.#advanceRoom(current.roomId);
        switch (command.type) {
          case "ready":
            await this.#handleReady(current, command.idempotencyKey, command.ready);
            return;
          case "progress":
            await this.#handleProgress(current, command);
            return;
          case "interaction":
            await this.#handleInteraction(current, command);
            return;
          case "ack":
            await this.#handleAcknowledgement(current, command.sequence);
            return;
          case "resume":
            await this.#resumeUnlocked(current, command.roomEpoch, command.afterSequence);
            return;
          case "ping":
            await this.#handlePing(current, command.pingId, command.clientTime);
            return;
          case "evidence":
            await this.#handleEvidence(current, command);
            return;
        }
      });
      return undefined;
    } catch (error) {
      const roomError = asRoomEngineError(error);
      const signal = roomError.toSignal();
      await this.#broadcaster.send(session.connectionId, signal);
      return signal;
    }
  }

  public async resume(session: RoomSession, afterSequence: number): Promise<void> {
    await this.#initialized;
    await this.#queue.run(session.roomId, async () => {
      const current = await this.#assertLiveSession(session);
      const room = await this.#requireRoom(current.roomId);
      await this.#resumeUnlocked(current, room.roomEpoch, afterSequence);
    });
  }

  public async getSnapshot(roomId: string): Promise<RoomSnapshot> {
    await this.#initialized;
    return this.#queue.run(roomId, async () => {
      const room = await this.#requireRoom(roomId);
      const players = (await this.#storage.listSessions(roomId)).map((session) => ({
        playerId: session.playerId,
        sessionId: session.sessionId,
        resumeEpoch: session.resumeEpoch,
        ready: session.ready,
        connected: session.connected,
        lastSeenAt: session.lastSeenAt,
        lastAcknowledgedSequence: session.lastAcknowledgedSequence,
        lastProgressSequence: session.lastProgressSequence,
      }));
      return { room, players };
    });
  }

  /** Advances scheduled starts and converts expired disconnects into canonical forfeits. */
  public async sweep(roomId: string): Promise<readonly CanonicalEvent[]> {
    await this.#initialized;
    return this.#queue.run(roomId, async () => {
      const room = await this.#advanceRoom(roomId);
      const now = this.#now();
      const sessions = await this.#storage.listSessions(roomId);
      const events: CanonicalEvent[] = [];
      for (const session of sessions) {
        if (
          session.connected ||
          session.disconnectedAt === undefined ||
          session.disconnectedAt + this.#config.room.disconnectGraceMs > now
        ) {
          continue;
        }
        if (room.status === "scheduled" || room.status === "running") {
          const result = await this.#storage.commitCanonical({
            roomId,
            roomEpoch: room.roomEpoch,
            eventId: this.#newEventId(),
            kind: "finish",
            createdAt: now,
            playerId: session.playerId,
            payload: { reason: "disconnect-timeout" },
            idempotencyScope: "room",
            idempotencyKey: `disconnect:${session.playerId}:${String(session.resumeEpoch)}`,
            eventLogCapacity: this.#config.room.eventLogCapacity,
          });
          events.push(result.event);
          await this.#broadcastCommitted(roomId, result);
        }
        await this.#storage.deleteSession(roomId, session.playerId);
      }
      return events;
    });
  }

  /** Earliest time at which an adapter should call sweep(), or undefined. */
  public async nextAlarmAt(roomId: string): Promise<number | undefined> {
    await this.#initialized;
    const room = await this.#storage.getRoom(roomId);
    const sessions = await this.#storage.listSessions(roomId);
    const candidates: number[] = [];
    if (room?.status === "scheduled" && room.startAt !== undefined) {
      candidates.push(room.startAt);
    }
    for (const session of sessions) {
      if (!session.connected && session.disconnectedAt !== undefined) {
        candidates.push(session.disconnectedAt + this.#config.room.disconnectGraceMs);
      }
    }
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  async #assertLiveSession(session: RoomSession): Promise<StoredSession> {
    const current = await this.#storage.getSession(session.roomId, session.playerId);
    if (current === undefined) {
      throw new RoomEngineError("SESSION_NOT_FOUND", "room session no longer exists");
    }
    if (
      current.connectionId !== session.connectionId ||
      current.resumeEpoch !== session.resumeEpoch ||
      !current.connected
    ) {
      throw new RoomEngineError("SESSION_REPLACED", "room session was replaced by a reconnect");
    }
    return current;
  }

  async #requireRoom(roomId: string): Promise<StoredRoom> {
    const room = await this.#storage.getRoom(roomId);
    if (room === undefined) {
      throw new RoomEngineError("ROOM_NOT_FOUND", "room does not exist");
    }
    return room;
  }

  #newEventId(): string {
    const eventId = this.#ids.eventId();
    requireIdentifier("eventId", eventId);
    return eventId;
  }

  #now(): number {
    const now = this.#clock.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new RoomEngineError("INTERNAL_ERROR", "room clock returned an invalid time", {
        retriable: true,
      });
    }
    return now;
  }

  async #advanceRoom(roomId: string): Promise<StoredRoom> {
    const room = await this.#requireRoom(roomId);
    if (
      room.status === "scheduled" &&
      room.startAt !== undefined &&
      room.startAt <= this.#now()
    ) {
      const running: StoredRoom = {
        ...room,
        status: "running",
        updatedAt: this.#now(),
      };
      await this.#storage.putRoom(running);
      return running;
    }
    return room;
  }

  async #consumeRateLimit(
    session: StoredSession,
    action: string,
    fallback: string,
  ): Promise<void> {
    const consume = async (bucket: string, policy: RateLimitConfig): Promise<void> => {
      const result = await this.#storage.consumeRateLimit({
        roomId: session.roomId,
        key: `${session.playerId}:${bucket}`,
        policy,
        now: this.#now(),
      });
      if (!result.allowed) {
        throw new RoomEngineError("RATE_LIMITED", "message rate limit exceeded", {
          retriable: true,
          retryAfterMs: result.retryAfterMs,
        });
      }
    };

    const fallbackPolicy =
      this.#config.security.rateLimits.actions[fallback] ??
      this.#config.security.rateLimits.default;
    await consume(`scope:${fallback}`, fallbackPolicy);
    const actionPolicy = this.#config.security.rateLimits.actions[action];
    if (action !== fallback && actionPolicy !== undefined) {
      await consume(`action:${action}`, actionPolicy);
    }
  }

  async #handleReady(
    session: StoredSession,
    idempotencyKey: string,
    ready: boolean,
  ): Promise<void> {
    requireIdempotencyKey(idempotencyKey);
    const room = await this.#requireRoom(session.roomId);
    if (room.status !== "waiting") {
      if (session.ready === ready) {
        const start = await this.#storage.findCanonicalByIdempotency(
          room.roomId,
          room.roomEpoch,
          "room",
          `start:${String(room.roomEpoch)}`,
        );
        if (start !== undefined) {
          await this.#broadcaster.broadcast(room.roomId, {
            version: 1,
            type: "canonical",
            event: start,
            duplicate: true,
          });
        }
        return;
      }
      throw new RoomEngineError("ROOM_ALREADY_STARTED", "room start is already scheduled");
    }
    if (session.ready === ready) {
      if (ready) {
        await this.#maybeScheduleStart(room);
      }
      return;
    }
    await this.#consumeRateLimit(session, "ready", "default");
    const readySession: StoredSession = {
      ...session,
      ready,
      lastSeenAt: this.#now(),
    };
    await this.#storage.putSession(readySession);
    await this.#broadcaster.broadcast(session.roomId, {
      version: 1,
      type: "ready",
      playerId: session.playerId,
      ready,
    });

    await this.#maybeScheduleStart(room);
  }

  async #maybeScheduleStart(room: StoredRoom): Promise<void> {
    const connected = (await this.#storage.listSessions(room.roomId)).filter(
      (candidate) => candidate.connected,
    );
    if (
      connected.length < this.#minimumPlayersToStart ||
      connected.some((candidate) => !candidate.ready)
    ) {
      return;
    }

    const now = this.#now();
    const startAt = now + this.#config.time.startLeadMs;
    const result = await this.#storage.commitCanonical({
      roomId: room.roomId,
      roomEpoch: room.roomEpoch,
      eventId: this.#newEventId(),
      kind: "start",
      createdAt: now,
      effectiveAt: { kind: "server-time", serverTimeMs: startAt },
      payload: {
        startAt,
        players: connected.map((candidate) => candidate.playerId),
      },
      idempotencyScope: "room",
      idempotencyKey: `start:${String(room.roomEpoch)}`,
      roomUpdate: { status: "scheduled", startAt, updatedAt: now },
      eventLogCapacity: this.#config.room.eventLogCapacity,
    });
    await this.#broadcastCommitted(room.roomId, result);
  }

  async #handleProgress(
    session: StoredSession,
    command: Extract<RoomCommand, { readonly type: "progress" }>,
  ): Promise<void> {
    if (!this.#config.features.progress.enabled) {
      throw new RoomEngineError("FEATURE_DISABLED", "progress reporting is disabled");
    }
    requireNonNegativeInteger("progress sequence", command.sequence);
    assertPayload(command.payload, this.#config.security.maxPayloadBytes);
    if (command.sequence <= session.lastProgressSequence) {
      return;
    }
    await this.#consumeRateLimit(session, "progress", "progress");
    await this.#storage.putSession({
      ...session,
      lastSeenAt: this.#now(),
      lastProgressSequence: command.sequence,
    });
    if (this.#config.progress.broadcast) {
      await this.#broadcaster.broadcast(
        session.roomId,
        {
          version: 1,
          type: "progress",
          playerId: session.playerId,
          sequence: command.sequence,
          serverTime: this.#now(),
          payload: command.payload,
        },
        { exceptConnectionId: session.connectionId },
      );
    }
  }

  async #handleInteraction(
    session: StoredSession,
    command: InteractionCommand,
  ): Promise<void> {
    if (!this.#config.features.interactions.enabled) {
      throw new RoomEngineError("FEATURE_DISABLED", "interactions are disabled");
    }
    requireIdempotencyKey(command.idempotencyKey);
    if (!ACTION_PATTERN.test(command.action)) {
      throw new RoomEngineError("INVALID_MESSAGE", "interaction action is invalid");
    }
    assertPayload(command.payload, this.#config.security.maxPayloadBytes);
    const room = await this.#requireRoom(session.roomId);
    if (room.status !== "scheduled" && room.status !== "running") {
      throw new RoomEngineError("INTERACTION_REJECTED", "room has not started");
    }

    const previous = await this.#storage.findCanonicalByIdempotency(
      room.roomId,
      room.roomEpoch,
      session.playerId,
      command.idempotencyKey,
    );
    if (previous !== undefined) {
      await this.#broadcaster.broadcast(room.roomId, {
        version: 1,
        type: "canonical",
        event: previous,
        duplicate: true,
      });
      return;
    }

    let target: StoredSession | undefined;
    if (this.#config.features.interactions.targeted) {
      if (command.targetPlayerId === undefined) {
        throw new RoomEngineError("TARGET_REQUIRED", "interaction target is required");
      }
      if (command.targetPlayerId === session.playerId) {
        throw new RoomEngineError("TARGET_NOT_ALLOWED", "a player cannot target itself");
      }
      target = await this.#storage.getSession(session.roomId, command.targetPlayerId);
      if (target === undefined || !target.connected) {
        throw new RoomEngineError("TARGET_NOT_FOUND", "interaction target is unavailable");
      }
    } else if (command.targetPlayerId !== undefined) {
      throw new RoomEngineError("TARGET_NOT_ALLOWED", "this room does not use targets");
    }

    await this.#consumeRateLimit(session, command.action, "interaction");
    const now = this.#now();
    const validation =
      this.#validateInteraction === undefined
        ? { accepted: true as const }
        : await this.#validateInteraction(command, {
            room,
            session,
            target,
            now,
            config: this.#config,
          });
    if (!validation.accepted) {
      throw new RoomEngineError(
        "INTERACTION_REJECTED",
        validation.message,
      );
    }
    if (
      this.#config.features.verification.interactionClaims &&
      this.#validateInteraction === undefined
    ) {
      throw new RoomEngineError(
        "INTERACTION_REJECTED",
        "interaction verification is required but no validator is configured",
      );
    }

    const payload = validation.payload ?? command.payload;
    assertPayload(payload, this.#config.security.maxPayloadBytes);
    const effectiveAt = normalizeEffectiveAt(
      validation.effectiveAt ?? command.effectiveAt,
      room,
      now,
      this.#config,
    );
    const commit = await this.#storage.commitCanonical({
      roomId: room.roomId,
      roomEpoch: room.roomEpoch,
      eventId: this.#newEventId(),
      kind: "interaction",
      createdAt: now,
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
      playerId: session.playerId,
      ...(target === undefined ? {} : { targetPlayerId: target.playerId }),
      action: command.action,
      payload,
      idempotencyScope: session.playerId,
      idempotencyKey: command.idempotencyKey,
      eventLogCapacity: this.#config.room.eventLogCapacity,
    });
    await this.#broadcastCommitted(room.roomId, commit);
  }

  async #handleEvidence(session: StoredSession, command: EvidenceCommand): Promise<void> {
    requireIdempotencyKey(command.idempotencyKey);
    const featureEnabled =
      (command.evidenceType === "replay-chunk" && this.#config.features.evidence.replayChunks) ||
      (command.evidenceType === "state-hash" && this.#config.features.evidence.stateHashes) ||
      (command.evidenceType === "result" && this.#config.features.verification.finalResults);
    if (!featureEnabled) {
      throw new RoomEngineError("FEATURE_DISABLED", "requested evidence channel is disabled");
    }
    assertPayload(command.payload, this.#config.security.maxPayloadBytes);
    const room = await this.#requireRoom(session.roomId);
    const previous = await this.#storage.findCanonicalByIdempotency(
      room.roomId,
      room.roomEpoch,
      session.playerId,
      command.idempotencyKey,
    );
    if (previous !== undefined) {
      await this.#broadcaster.broadcast(room.roomId, {
        version: 1,
        type: "canonical",
        event: previous,
        duplicate: true,
      });
      return;
    }
    await this.#consumeRateLimit(session, command.evidenceType, "replay_chunk");
    if (command.evidenceType === "result" && this.#verifyReplay === undefined) {
      throw new RoomEngineError(
        "EVIDENCE_REJECTED",
        "result verification is required but no verifier is configured",
      );
    }
    const verified =
      this.#verifyReplay === undefined
        ? { accepted: true as const }
        : await this.#verifyReplay(command, {
            room,
            session,
            now: this.#now(),
            config: this.#config,
          });
    if (!verified.accepted) {
      throw new RoomEngineError("EVIDENCE_REJECTED", verified.message);
    }
    const payload = verified.payload ?? command.payload;
    assertPayload(payload, this.#config.security.maxPayloadBytes);
    const result = await this.#storage.commitCanonical({
      roomId: room.roomId,
      roomEpoch: room.roomEpoch,
      eventId: this.#newEventId(),
      kind: "evidence",
      createdAt: this.#now(),
      playerId: session.playerId,
      action: command.evidenceType,
      payload,
      idempotencyScope: session.playerId,
      idempotencyKey: command.idempotencyKey,
      eventLogCapacity: this.#config.room.eventLogCapacity,
    });
    await this.#broadcastCommitted(room.roomId, result);
  }

  async #handleAcknowledgement(session: StoredSession, sequence: number): Promise<void> {
    requireNonNegativeInteger("acknowledged sequence", sequence);
    const room = await this.#requireRoom(session.roomId);
    if (sequence > room.lastSequence) {
      throw new RoomEngineError("INVALID_MESSAGE", "acknowledgement exceeds room sequence");
    }
    const acknowledged = Math.max(session.lastAcknowledgedSequence, sequence);
    await this.#storage.putSession({
      ...session,
      lastSeenAt: this.#now(),
      lastAcknowledgedSequence: acknowledged,
    });
    await this.#broadcaster.send(session.connectionId, {
      version: 1,
      type: "acknowledged",
      sequence: acknowledged,
    });
  }

  async #handlePing(
    session: StoredSession,
    pingId: string,
    clientTime: number,
  ): Promise<void> {
    requireIdempotencyKey(pingId);
    if (!Number.isFinite(clientTime)) {
      throw new RoomEngineError("INVALID_MESSAGE", "client ping time must be finite");
    }
    await this.#broadcaster.send(session.connectionId, {
      version: 1,
      type: "pong",
      pingId,
      clientTime,
      serverTime: this.#now(),
    });
  }

  async #resumeUnlocked(
    session: StoredSession,
    roomEpoch: number,
    afterSequence: number,
  ): Promise<void> {
    const room = await this.#requireRoom(session.roomId);
    const signal = await this.#createReplaySignal(room, roomEpoch, afterSequence);
    await this.#broadcaster.send(session.connectionId, signal);
  }

  async #createReplaySignal(
    room: StoredRoom,
    roomEpoch: number,
    afterSequence: number,
  ): Promise<Extract<RoomSignal, { readonly type: "replay" }>> {
    requireNonNegativeInteger("resume sequence", afterSequence);
    if (roomEpoch !== room.roomEpoch) {
      throw new RoomEngineError(
        "ROOM_EPOCH_MISMATCH",
        "resume belongs to a different room epoch",
      );
    }
    if (!this.#config.features.reconnect.enabled) {
      throw new RoomEngineError("FEATURE_DISABLED", "room resume is disabled");
    }
    if (afterSequence > room.lastSequence) {
      throw new RoomEngineError(
        "INVALID_MESSAGE",
        "resume sequence exceeds the latest canonical event",
      );
    }
    const range = await this.#storage.readCanonical(
      room.roomId,
      room.roomEpoch,
      afterSequence,
      this.#replayBatchSize,
    );
    if (
      range.oldestSequence !== undefined &&
      afterSequence < range.oldestSequence - 1
    ) {
      throw new RoomEngineError(
        "REPLAY_UNAVAILABLE",
        "requested canonical history is outside the retained replay window",
      );
    }
    return {
      version: 1,
      type: "replay",
      roomEpoch,
      afterSequence,
      events: range.events,
    };
  }

  async #broadcastCommitted(
    roomId: string,
    result: CanonicalCommitResult,
  ): Promise<void> {
    const signal = {
      version: 1 as const,
      type: "canonical" as const,
      event: result.event,
      ...(result.duplicate ? { duplicate: true as const } : {}),
    };
    await this.#broadcaster.broadcast(roomId, signal);
  }
}

export function createRoomEngine(options: RoomEngineOptions): RoomEngine {
  return new RoomEngine(options);
}
