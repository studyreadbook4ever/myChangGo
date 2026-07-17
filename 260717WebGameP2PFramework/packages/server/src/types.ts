import type {
  CanonicalEvent as CoreCanonicalEvent,
  ClientAcknowledgeMessage,
  ClientEvidenceMessage,
  ClientInteractionMessage,
  ClientMessage,
  ClientPingMessage,
  ClientProgressMessage,
  ClientReadyMessage,
  ClientResumeMessage,
  EffectiveAt as CoreEffectiveAt,
  JsonValue,
  RateLimitConfig,
  RelayPlayConfig,
  RelayPlayConfigInput,
  RoomStatus as CoreRoomStatus,
  ServerAcknowledgedMessage,
  ServerCanonicalMessage,
  ServerErrorMessage,
  ServerMessage,
  ServerPongMessage,
  ServerPresenceMessage,
  ServerProgressMessage,
  ServerReadyMessage,
  ServerReplayMessage,
  ServerSessionMessage,
} from "@relayplay/core";

export type Awaitable<T> = T | Promise<T>;

export type RoomStatus = CoreRoomStatus;
export type EffectiveAt = CoreEffectiveAt;
export type CanonicalEvent = CoreCanonicalEvent;

export interface StoredRoom {
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly status: RoomStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startAt?: number;
  readonly lastSequence: number;
}

export interface StoredSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly resumeEpoch: number;
  readonly connectionId: string;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  readonly disconnectedAt?: number;
  readonly lastAcknowledgedSequence: number;
  readonly lastProgressSequence: number;
  readonly roles: readonly string[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface RoomSnapshot {
  readonly room: StoredRoom;
  readonly players: readonly Pick<
    StoredSession,
    | "playerId"
    | "sessionId"
    | "resumeEpoch"
    | "ready"
    | "connected"
    | "lastSeenAt"
    | "lastAcknowledgedSequence"
    | "lastProgressSequence"
  >[];
}

export interface AuthRequest {
  readonly roomId: string;
  readonly credential: unknown;
  readonly connectionId: string;
  readonly requestedPlayerId?: string;
  readonly requestedSessionId?: string;
  readonly resumeEpoch?: number;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface AuthResult {
  readonly playerId: string;
  readonly sessionId?: string;
  readonly roles?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type RoomAuthenticator = (request: AuthRequest) => Awaitable<AuthResult>;

export interface ConnectRequest {
  readonly roomId: string;
  readonly credential: unknown;
  readonly connectionId: string;
  readonly requestedPlayerId?: string;
  readonly requestedSessionId?: string;
  readonly resumeEpoch?: number;
  readonly afterSequence?: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type ReadyCommand = ClientReadyMessage;
export type ProgressCommand = ClientProgressMessage;
export type InteractionCommand = ClientInteractionMessage;
export type AcknowledgeCommand = ClientAcknowledgeMessage;
export type ResumeCommand = ClientResumeMessage;
export type PingCommand = ClientPingMessage;
export type EvidenceCommand = ClientEvidenceMessage;
export type RoomCommand = ClientMessage;

export interface InteractionContext {
  readonly room: StoredRoom;
  readonly session: StoredSession;
  readonly target: StoredSession | undefined;
  readonly now: number;
  readonly config: RelayPlayConfig;
}

export type InteractionValidationResult =
  | {
      readonly accepted: true;
      readonly payload?: JsonValue;
      readonly effectiveAt?: EffectiveAt;
    }
  | {
      readonly accepted: false;
      readonly code?: string;
      readonly message: string;
    };

export type InteractionValidator = (
  command: InteractionCommand,
  context: InteractionContext,
) => Awaitable<InteractionValidationResult>;

export interface EvidenceContext {
  readonly room: StoredRoom;
  readonly session: StoredSession;
  readonly now: number;
  readonly config: RelayPlayConfig;
}

export type ReplayVerificationResult =
  | { readonly accepted: true; readonly payload?: JsonValue }
  | { readonly accepted: false; readonly code?: string; readonly message: string };

export type ReplayVerifier = (
  command: EvidenceCommand,
  context: EvidenceContext,
) => Awaitable<ReplayVerificationResult>;

export interface RoomUpdate {
  readonly status?: RoomStatus;
  readonly startAt?: number;
  readonly updatedAt: number;
}

export interface CanonicalCommit {
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly eventId: string;
  readonly kind: CanonicalEvent["kind"];
  readonly createdAt: number;
  readonly effectiveAt?: EffectiveAt;
  readonly playerId?: string;
  readonly targetPlayerId?: string;
  readonly action?: string;
  readonly payload: JsonValue;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly roomUpdate?: RoomUpdate;
  readonly eventLogCapacity: number;
}

export interface CanonicalCommitResult {
  readonly event: CanonicalEvent;
  readonly duplicate: boolean;
}

export interface CanonicalRange {
  readonly events: readonly CanonicalEvent[];
  readonly oldestSequence: number | undefined;
  readonly latestSequence: number;
}

export interface RateLimitRequest {
  readonly roomId: string;
  readonly key: string;
  readonly policy: RateLimitConfig;
  readonly now: number;
  readonly cost?: number;
}

export type RateLimitResult =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly remaining: number };

/** Storage owns sequence allocation and idempotency atomically. */
export interface RoomStorage {
  initialize(): Awaitable<void>;
  ensureRoom(roomId: string, now: number): Awaitable<StoredRoom>;
  getRoom(roomId: string): Awaitable<StoredRoom | undefined>;
  putRoom(room: StoredRoom): Awaitable<void>;
  putSession(session: StoredSession): Awaitable<void>;
  getSession(roomId: string, playerId: string): Awaitable<StoredSession | undefined>;
  listSessions(roomId: string): Awaitable<readonly StoredSession[]>;
  deleteSession(roomId: string, playerId: string): Awaitable<void>;
  findCanonicalByIdempotency(
    roomId: string,
    roomEpoch: number,
    idempotencyScope: string,
    idempotencyKey: string,
  ): Awaitable<CanonicalEvent | undefined>;
  commitCanonical(commit: CanonicalCommit): Awaitable<CanonicalCommitResult>;
  readCanonical(
    roomId: string,
    roomEpoch: number,
    afterSequence: number,
    limit?: number,
  ): Awaitable<CanonicalRange>;
  consumeRateLimit(request: RateLimitRequest): Awaitable<RateLimitResult>;
}

export interface BroadcastOptions {
  readonly exceptConnectionId?: string;
  readonly playerIds?: readonly string[];
}

export interface RoomBroadcaster {
  send(connectionId: string, signal: RoomSignal): Awaitable<void>;
  sendToPlayer(roomId: string, playerId: string, signal: RoomSignal): Awaitable<void>;
  broadcast(roomId: string, signal: RoomSignal, options?: BroadcastOptions): Awaitable<void>;
}

export type SessionSignal = ServerSessionMessage;
export type PresenceSignal = ServerPresenceMessage;
export type ReadySignal = ServerReadyMessage;
export type ProgressSignal = ServerProgressMessage;
export type CanonicalSignal = ServerCanonicalMessage;
export type ReplaySignal = ServerReplayMessage;
export type AcknowledgedSignal = ServerAcknowledgedMessage;
export type PongSignal = ServerPongMessage;
export type ErrorSignal = ServerErrorMessage;
export type RoomSignal = ServerMessage;

export type RoomErrorCode =
  | "AUTH_FAILED"
  | "INVALID_IDENTIFIER"
  | "INVALID_MESSAGE"
  | "MESSAGE_TOO_LARGE"
  | "ROOM_FULL"
  | "ROOM_NOT_FOUND"
  | "ROOM_ALREADY_STARTED"
  | "SESSION_NOT_FOUND"
  | "SESSION_REPLACED"
  | "RESUME_EPOCH_MISMATCH"
  | "ROOM_EPOCH_MISMATCH"
  | "REPLAY_UNAVAILABLE"
  | "FEATURE_DISABLED"
  | "TARGET_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_ALLOWED"
  | "INTERACTION_REJECTED"
  | "EVIDENCE_REJECTED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  eventId(): string;
  sessionId(): string;
}

export interface RoomEngineOptions {
  readonly storage: RoomStorage;
  readonly broadcaster: RoomBroadcaster;
  readonly authenticate: RoomAuthenticator;
  readonly config?: RelayPlayConfigInput;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly validateInteraction?: InteractionValidator;
  readonly verifyReplay?: ReplayVerifier;
  readonly minimumPlayersToStart?: number;
  readonly replayBatchSize?: number;
}

export type RoomSession = StoredSession;
