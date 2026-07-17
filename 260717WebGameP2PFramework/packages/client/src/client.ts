import {
  normalizeConfig,
  safeParseClientMessage,
  safeParseServerMessage,
  type CanonicalEvent,
  type ClientMessage,
  type EffectiveAt,
  type EvidenceType,
  type JsonValue,
  type PlatformCapabilities,
  type RelayPlayConfig,
  type RelayPlayConfigInput,
  type ServerMessage,
  type ServerPresenceMessage,
  type ServerProgressMessage,
  type ServerReadyMessage,
  type ServerSessionMessage,
} from "@relayplay/core";
import { detectCapabilities } from "./capabilities.js";
import { TypedEventEmitter } from "./emitter.js";
import {
  browserClientIdGenerator,
  type ClientIdGenerator,
} from "./ids.js";
import {
  watchPageLifecycle,
  type PageLifecycleChange,
  type PageLifecycleOptions,
} from "./lifecycle.js";
import {
  ProgressScheduler,
  type ProgressProvider,
} from "./progress-scheduler.js";
import {
  normalizeReconnectOptions,
  reconnectDelay,
  type ReconnectOptions,
  type ReconnectPolicy,
} from "./reconnect.js";
import {
  MemoryResumeStore,
  type ClientResumeState,
  type ResumeStore,
} from "./resume-store.js";
import { CanonicalSequenceBuffer } from "./sequence-buffer.js";
import {
  decodeJsonPayload,
  encodeJsonPayload,
} from "./socket-codec.js";
import {
  monotonicEpochClock,
  TimeSynchronizer,
  type Clock,
  type TimeSyncEstimate,
  type TimeSyncSample,
} from "./time-sync.js";
import {
  browserTimerApi,
  type TimerApi,
  type TimerHandle,
} from "./timers.js";
import { buildRelayPlayWebSocketUrl } from "./url.js";
import {
  browserWebSocketFactory,
  WebSocketReadyState,
  type WebSocketFactory,
  type WebSocketLike,
} from "./websocket.js";

export type Awaitable<Value> = Value | Promise<Value>;

export type RelayPlayClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "destroyed";

export type RelayPlayClientErrorSource =
  | "configuration"
  | "connection"
  | "protocol"
  | "progress"
  | "resume-store"
  | "time-sync";

export interface RelayPlayClientErrorEvent {
  readonly error: unknown;
  readonly source: RelayPlayClientErrorSource;
}

export interface RelayPlayConnectionInfo {
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly playerId: string;
  readonly sessionId: string;
  readonly resumeEpoch: number;
  readonly resumed: boolean;
}

export interface RelayPlayDisconnectInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly willReconnect: boolean;
}

export interface RelayPlaySequenceGap {
  readonly expectedSequence: number;
  readonly receivedSequence: number;
}

export interface RelayPlayTimeSyncEvent {
  readonly sample: TimeSyncSample;
  readonly estimate: TimeSyncEstimate;
  readonly uncertaintyMs: number;
}

export interface RelayPlayServerError {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly retryAfterMs?: number;
}

export interface RelayPlayClientEvents {
  statechange: {
    readonly previousState: RelayPlayClientState;
    readonly state: RelayPlayClientState;
  };
  connected: RelayPlayConnectionInfo;
  disconnected: RelayPlayDisconnectInfo;
  reconnecting: { readonly attempt: number; readonly delayMs: number };
  resumed: RelayPlayConnectionInfo & { readonly replayedEvents: number };
  presence: ServerPresenceMessage;
  ready: ServerReadyMessage;
  start: CanonicalEvent;
  progress: ServerProgressMessage;
  canonical: CanonicalEvent;
  interaction: CanonicalEvent;
  duplicate: CanonicalEvent;
  sequenceGap: RelayPlaySequenceGap;
  timeSync: RelayPlayTimeSyncEvent;
  serverError: RelayPlayServerError;
  lifecycle: PageLifecycleChange;
  message: ServerMessage;
  error: RelayPlayClientErrorEvent;
}

export interface SendInteractionOptions {
  readonly action: string;
  readonly payload: JsonValue;
  readonly targetPlayerId?: string;
  readonly requestedEffectiveAt?: EffectiveAt;
  readonly effectiveAt?: EffectiveAt;
  readonly idempotencyKey?: string;
}

export type InteractionIntent = SendInteractionOptions;

export interface SendEvidenceOptions {
  readonly evidenceType: EvidenceType;
  readonly payload: JsonValue;
  readonly idempotencyKey?: string;
}

export interface RelayPlayClientOptions {
  readonly url: string | URL | (() => Awaitable<string | URL>);
  readonly roomId: string;
  readonly token?: string | (() => Awaitable<string>);
  readonly playerId?: string;
  readonly config?: RelayPlayConfigInput;
  readonly capabilities?: PlatformCapabilities;
  readonly webSocketFactory?: WebSocketFactory;
  readonly protocols?: string | readonly string[];
  readonly resumeStore?: ResumeStore;
  readonly progressIntervalMs?: number;
  readonly reconnect?: ReconnectOptions;
  readonly clock?: Clock;
  readonly timers?: TimerApi;
  readonly idGenerator?: ClientIdGenerator;
  readonly random?: () => number;
  readonly sequenceGapTimeoutMs?: number;
  readonly autoLifecycle?: boolean;
  readonly lifecycle?: PageLifecycleOptions;
}

export interface DisconnectOptions {
  readonly code?: number;
  readonly reason?: string;
  readonly forgetSession?: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: () => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    },
    reject: (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function readNumber(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function validateProgressInterval(intervalMs: number): number {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 60_000
  ) {
    throw new RangeError(
      "Progress interval must be a safe integer between 100 and 60,000 ms.",
    );
  }
  return intervalMs;
}

export class RelayPlayClient extends TypedEventEmitter<RelayPlayClientEvents> {
  readonly #options: RelayPlayClientOptions;
  readonly #config: RelayPlayConfig;
  readonly #capabilities: PlatformCapabilities;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #resumeStore: ResumeStore;
  readonly #timers: TimerApi;
  readonly #ids: ClientIdGenerator;
  readonly #random: () => number;
  readonly #reconnectPolicy: ReconnectPolicy;
  readonly #clockSource: Clock;
  readonly #sequences = new CanonicalSequenceBuffer<CanonicalEvent>();
  readonly clock: TimeSynchronizer;
  #state: RelayPlayClientState = "idle";
  #socket: WebSocketLike | undefined;
  #connectDeferred: Deferred | undefined;
  #resumeState: ClientResumeState | undefined;
  #resumeLoaded = false;
  #manualClose = false;
  #fatalClose = false;
  #generation = 0;
  #reconnectAttempt = 0;
  #reconnectTimer: TimerHandle | undefined;
  #timeSyncTimer: TimerHandle | undefined;
  #gapTimer: TimerHandle | undefined;
  #gapExpected: number | undefined;
  #gapReplayRequested = false;
  #progressScheduler: ProgressScheduler<JsonValue> | undefined;
  #progressProvider: ProgressProvider<JsonValue> | undefined;
  #progressSequence = 0;
  #latestProgress: JsonValue | undefined;
  #desiredReady = false;
  #readyIdempotencyKey: string | undefined;
  #messageQueue: Promise<void> = Promise.resolve();
  #stopLifecycle: (() => void) | undefined;
  #initialPingRemaining = 0;
  #resumeReplayPending = false;

  constructor(options: RelayPlayClientOptions) {
    super();
    if (options.roomId.length === 0) {
      throw new TypeError("roomId must not be empty.");
    }
    this.#options = options;
    this.#config = normalizeConfig(options.config);
    this.#capabilities = options.capabilities ?? detectCapabilities();
    this.#webSocketFactory = options.webSocketFactory ?? browserWebSocketFactory;
    this.#resumeStore = options.resumeStore ?? new MemoryResumeStore();
    this.#timers = options.timers ?? browserTimerApi;
    this.#ids = options.idGenerator ?? browserClientIdGenerator;
    this.#random = options.random ?? Math.random;
    this.#reconnectPolicy = normalizeReconnectOptions({
      ...(options.reconnect ?? {}),
      enabled:
        this.#config.features.reconnect.enabled &&
        (options.reconnect?.enabled ?? true),
    });
    this.#clockSource = options.clock ?? monotonicEpochClock;
    this.clock = new TimeSynchronizer({
      clock: this.#clockSource,
      maxSamples: this.#config.time.sync.sampleCount,
      maxRoundTripMs: this.#config.time.sync.maxRttMs,
    });

    const gapTimeout = options.sequenceGapTimeoutMs ?? 250;
    if (!Number.isSafeInteger(gapTimeout) || gapTimeout < 0) {
      throw new RangeError("sequenceGapTimeoutMs must be a non-negative safe integer.");
    }
    if (options.progressIntervalMs !== undefined) {
      validateProgressInterval(options.progressIntervalMs);
    }

    if (options.autoLifecycle === true) {
      this.#stopLifecycle = watchPageLifecycle((change) => {
        this.emit("lifecycle", change);
        if (change.state === "terminated") {
          void this.disconnect({ reason: "page terminated" });
        }
      }, options.lifecycle);
    }
  }

  get state(): RelayPlayClientState {
    return this.#state;
  }

  get config(): RelayPlayConfig {
    return this.#config;
  }

  get capabilities(): PlatformCapabilities {
    return this.#capabilities;
  }

  get connected(): boolean {
    return this.#state === "connected";
  }

  get playerId(): string | undefined {
    return this.#resumeState?.playerId ?? this.#options.playerId;
  }

  get sessionId(): string | undefined {
    return this.#resumeState?.sessionId;
  }

  get roomEpoch(): number | undefined {
    return this.#resumeState?.roomEpoch;
  }

  get resumeEpoch(): number | undefined {
    return this.#resumeState?.resumeEpoch;
  }

  get lastEventSequence(): number {
    return this.#sequences.lastSequence;
  }

  get clockOffsetMs(): number {
    return this.clock.offsetMs;
  }

  async connect(): Promise<void> {
    if (this.#state === "destroyed") {
      throw new Error("RelayPlayClient has been destroyed.");
    }
    if (this.#state === "connected") {
      return;
    }
    if (this.#connectDeferred !== undefined && !this.#connectDeferred.settled) {
      return this.#connectDeferred.promise;
    }

    this.#manualClose = false;
    this.#fatalClose = false;
    this.#connectDeferred = deferred();
    try {
      await this.#loadResumeState();
      void this.#openSocket(false);
    } catch (error) {
      this.#connectDeferred.reject(error);
      throw error;
    }
    return this.#connectDeferred.promise;
  }

  async disconnect(options: DisconnectOptions = {}): Promise<void> {
    if (this.#state === "destroyed") {
      return;
    }
    this.#manualClose = true;
    this.#clearReconnectTimer();
    this.#stopConnectedSchedulers();
    this.#setState("closing");
    const socket = this.#socket;
    if (
      socket !== undefined &&
      (socket.readyState === WebSocketReadyState.OPEN ||
        socket.readyState === WebSocketReadyState.CONNECTING)
    ) {
      socket.close(options.code ?? 1000, options.reason ?? "client disconnect");
    }
    this.#socket = undefined;
    this.#generation += 1;
    if (options.forgetSession === true) {
      this.#resumeState = undefined;
      this.#sequences.reset();
      await this.#safeClearResume();
    }
    this.#connectDeferred?.reject(new Error("Connection closed by client."));
    this.#setState("closed");
  }

  async destroy(): Promise<void> {
    if (this.#state === "destroyed") {
      return;
    }
    await this.disconnect({ reason: "client destroyed", forgetSession: true });
    this.#progressScheduler?.stop();
    this.#progressScheduler = undefined;
    this.#stopLifecycle?.();
    this.#stopLifecycle = undefined;
    this.#setState("destroyed");
    this.removeAllListeners();
  }

  setReady(ready = true): boolean {
    this.#desiredReady = ready;
    this.#readyIdempotencyKey = this.#ids.next("ready");
    if (!this.connected) {
      return false;
    }
    this.#sendReady();
    return true;
  }

  startProgress(
    provider: ProgressProvider<JsonValue>,
    options: { readonly intervalMs?: number; readonly reportImmediately?: boolean } = {},
  ): void {
    this.stopProgress();
    this.#progressProvider = provider;
    this.#progressScheduler = new ProgressScheduler(
      provider,
      (progress) => {
        this.reportProgress(progress);
      },
      {
        intervalMs:
          validateProgressInterval(
            options.intervalMs ??
              this.#options.progressIntervalMs ??
              this.#config.progress.intervalMs,
          ),
        ...(options.reportImmediately === undefined
          ? {}
          : { reportImmediately: options.reportImmediately }),
        timers: this.#timers,
        onError: (error) => this.#reportError(error, "progress"),
      },
    );
    if (this.connected && this.#config.features.progress.enabled) {
      this.#progressScheduler.start();
    }
  }

  setProgressProvider(
    provider: ProgressProvider<JsonValue> | undefined,
  ): void {
    if (provider === undefined) {
      this.stopProgress();
      return;
    }
    this.startProgress(provider);
  }

  stopProgress(): void {
    this.#progressScheduler?.stop();
    this.#progressScheduler = undefined;
    this.#progressProvider = undefined;
  }

  reportProgress(progress: JsonValue): boolean {
    this.#latestProgress = progress;
    if (!this.connected || !this.#config.features.progress.enabled) {
      return false;
    }
    this.#progressSequence += 1;
    this.#send({
      version: 1,
      type: "progress",
      sequence: this.#progressSequence,
      payload: progress,
    });
    return true;
  }

  sendInteraction(options: SendInteractionOptions): string {
    if (!this.connected) {
      throw new Error("Cannot send an interaction while disconnected.");
    }
    if (!this.#config.features.interactions.enabled) {
      throw new Error("Interactions are disabled by the RelayPlay configuration.");
    }
    const idempotencyKey =
      options.idempotencyKey ?? this.#ids.next("interaction");
    const effectiveAt = options.effectiveAt ?? options.requestedEffectiveAt;
    this.#send({
      version: 1,
      type: "interaction",
      idempotencyKey,
      action: options.action,
      payload: options.payload,
      ...(options.targetPlayerId === undefined
        ? {}
        : { targetPlayerId: options.targetPlayerId }),
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
    });
    return idempotencyKey;
  }

  sendEvidence(options: SendEvidenceOptions): string {
    if (!this.connected) {
      throw new Error("Cannot send evidence while disconnected.");
    }
    const idempotencyKey = options.idempotencyKey ?? this.#ids.next("evidence");
    this.#send({
      version: 1,
      type: "evidence",
      idempotencyKey,
      evidenceType: options.evidenceType,
      payload: options.payload,
    });
    return idempotencyKey;
  }

  ping(): string {
    if (!this.connected) {
      throw new Error("Cannot synchronize time while disconnected.");
    }
    const pingId = this.#ids.next("ping");
    const clientTime = this.clock.begin(pingId);
    this.#send({ version: 1, type: "ping", pingId, clientTime });
    return pingId;
  }

  syncTime(): string {
    return this.ping();
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  #setState(state: RelayPlayClientState): void {
    if (state === this.#state) {
      return;
    }
    const previousState = this.#state;
    this.#state = state;
    this.emit("statechange", { previousState, state });
  }

  async #loadResumeState(): Promise<void> {
    if (this.#resumeLoaded || !this.#config.features.reconnect.enabled) {
      return;
    }
    this.#resumeLoaded = true;
    try {
      const stored = await this.#resumeStore.load(this.#options.roomId);
      if (
        stored !== undefined &&
        (this.#options.playerId === undefined ||
          this.#options.playerId === stored.playerId)
      ) {
        this.#resumeState = stored;
        this.#sequences.reset(stored.lastEventSequence);
      }
    } catch (error) {
      this.#reportError(error, "resume-store");
    }
  }

  async #openSocket(reconnecting: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#setState(reconnecting ? "reconnecting" : "connecting");
    try {
      const endpoint =
        typeof this.#options.url === "function"
          ? await this.#options.url()
          : this.#options.url;
      const token =
        typeof this.#options.token === "function"
          ? await this.#options.token()
          : this.#options.token;
      if (generation !== this.#generation || this.#manualClose) {
        return;
      }
      const resume = this.#config.features.reconnect.enabled
        ? this.#resumeState
        : undefined;
      const url = buildRelayPlayWebSocketUrl(endpoint, {
        roomId: this.#options.roomId,
        ...(token === undefined ? {} : { token }),
        ...(this.playerId === undefined ? {} : { playerId: this.playerId }),
        ...(resume === undefined
          ? {}
          : {
              sessionId: resume.sessionId,
              resumeEpoch: resume.resumeEpoch,
              afterSequence: this.#sequences.lastSequence,
            }),
      });
      const socket = this.#webSocketFactory(url, this.#options.protocols);
      this.#socket = socket;
      this.#attachSocket(socket, generation);
      if (socket.readyState === WebSocketReadyState.OPEN) {
        this.#handleOpen(socket, generation);
      }
    } catch (error) {
      this.#reportError(error, "connection");
      this.#scheduleReconnectOrFail(error);
    }
  }

  #attachSocket(socket: WebSocketLike, generation: number): void {
    const onOpen = (): void => this.#handleOpen(socket, generation);
    const onMessage = (event: MessageEvent<unknown>): void => {
      this.#messageQueue = this.#messageQueue
        .then(() => this.#handleMessageData(event.data, socket, generation))
        .catch((error: unknown) => {
          this.#reportError(error, "protocol");
          if (socket.readyState === WebSocketReadyState.OPEN) {
            socket.close(1002, "invalid protocol message");
          }
        });
    };
    const onError = (event: Event): void => {
      this.#reportError(event, "connection");
    };
    const onClose = (event: CloseEvent): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      this.#handleClose(socket, generation, event);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  }

  #handleOpen(socket: WebSocketLike, generation: number): void {
    if (
      socket !== this.#socket ||
      generation !== this.#generation ||
      this.#manualClose
    ) {
      return;
    }
    this.#setState("handshaking");
  }

  async #handleMessageData(
    data: unknown,
    socket: WebSocketLike,
    generation: number,
  ): Promise<void> {
    if (socket !== this.#socket || generation !== this.#generation) {
      return;
    }
    const decoded = await decodeJsonPayload(
      data,
      this.#config.security.maxMessageBytes,
    );
    const parsed = safeParseServerMessage(decoded, {
      maxMessageBytes: this.#config.security.maxMessageBytes,
      maxPayloadBytes: this.#config.security.maxPayloadBytes,
      maxReplayEvents: this.#config.room.eventLogCapacity,
    });
    if (!parsed.success) {
      throw new Error(
        `Invalid server message: ${parsed.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    this.emit("message", parsed.data);
    await this.#handleServerMessage(parsed.data);
  }

  async #handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "session": {
        const resumed = this.#resumeState !== undefined;
        this.#resumeReplayPending = resumed;
        await this.#acceptSession(message, resumed);
        return;
      }
      case "presence":
        this.emit("presence", message);
        return;
      case "ready":
        this.emit("ready", message);
        return;
      case "progress":
        this.emit("progress", message);
        return;
      case "canonical":
        await this.#acceptCanonical(message.event);
        return;
      case "replay":
        if (
          this.#resumeState !== undefined &&
          message.roomEpoch !== this.#resumeState.roomEpoch
        ) {
          throw new Error("Replay belongs to a different room epoch.");
        }
        for (const event of message.events) {
          await this.#acceptCanonical(event);
        }
        if (this.#resumeReplayPending) {
          this.#resumeReplayPending = false;
          const info = this.#connectionInfo(true);
          if (info !== undefined) {
            this.emit("resumed", {
              ...info,
              replayedEvents: message.events.length,
            });
          }
        }
        return;
      case "pong":
        this.#acceptPong(asRecord(message));
        return;
      case "error":
        this.#acceptServerError(asRecord(message));
        return;
      case "acknowledged":
        return;
    }
  }

  async #acceptSession(
    message: ServerSessionMessage,
    resumed: boolean,
  ): Promise<void> {
    const previous = this.#resumeState;
    const { roomId, playerId, sessionId, roomEpoch, resumeEpoch } = message;
    if (roomId !== this.#options.roomId) {
      throw new Error("Server joined a different room than requested.");
    }
    if (!resumed && previous?.roomEpoch !== roomEpoch) {
      this.#sequences.reset();
    }
    this.#resumeState = {
      roomId,
      playerId,
      sessionId,
      roomEpoch,
      resumeEpoch,
      lastEventSequence: this.#sequences.lastSequence,
    };
    await this.#safeSaveResume();
    this.#reconnectAttempt = 0;
    this.#setState("connected");
    const info = this.#connectionInfo(resumed);
    if (info !== undefined) {
      this.emit("connected", info);
    }
    this.#connectDeferred?.resolve();
    this.#startConnectedSchedulers();
    if (this.#readyIdempotencyKey !== undefined || this.#desiredReady) {
      this.#sendReady();
    }
    if (this.#latestProgress !== undefined) {
      this.reportProgress(this.#latestProgress);
    }
  }

  #connectionInfo(resumed: boolean): RelayPlayConnectionInfo | undefined {
    const session = this.#resumeState;
    return session === undefined ? undefined : { ...session, resumed };
  }

  async #acceptCanonical(event: CanonicalEvent): Promise<void> {
    const session = this.#resumeState;
    if (event.roomId !== this.#options.roomId) {
      throw new Error("Canonical event belongs to a different room.");
    }
    if (session !== undefined && event.roomEpoch !== session.roomEpoch) {
      await this.#safeClearResume();
      this.#resumeState = undefined;
      this.#sequences.reset();
      throw new Error("Canonical event belongs to a different room epoch.");
    }
    const result = this.#sequences.ingest(event);
    if (result.status === "duplicate") {
      this.emit("duplicate", event);
      if (this.connected) {
        this.#send({
          version: 1,
          type: "ack",
          sequence: this.#sequences.lastSequence,
        });
      }
      return;
    }
    if (result.status === "gap") {
      if (this.#gapExpected !== result.expectedSequence) {
        this.#gapExpected = result.expectedSequence;
        this.emit("sequenceGap", {
          expectedSequence: result.expectedSequence,
          receivedSequence: result.receivedSequence,
        });
        this.#scheduleGapRecovery();
      }
      return;
    }

    if (
      this.#gapExpected !== undefined &&
      this.#sequences.lastSequence >= this.#gapExpected
    ) {
      this.#clearGapRecovery();
    }
    for (const accepted of result.events) {
      this.emit("canonical", accepted);
      switch (accepted.kind) {
        case "start":
          this.emit("start", accepted);
          break;
        case "interaction":
          this.emit("interaction", accepted);
          break;
        case "finish":
        case "evidence":
          break;
      }
    }
    if (this.#resumeState !== undefined) {
      this.#resumeState = {
        ...this.#resumeState,
        lastEventSequence: this.#sequences.lastSequence,
      };
      await this.#safeSaveResume();
    }
    if (this.connected) {
      this.#send({
        version: 1,
        type: "ack",
        sequence: this.#sequences.lastSequence,
      });
    }
  }

  #scheduleGapRecovery(): void {
    if (this.#gapTimer !== undefined) {
      return;
    }
    const delay = this.#options.sequenceGapTimeoutMs ?? 250;
    this.#gapTimer = this.#timers.setTimeout(() => {
      this.#gapTimer = undefined;
      const socket = this.#socket;
      if (this.#gapExpected !== undefined && socket?.readyState === WebSocketReadyState.OPEN) {
        if (
          !this.#gapReplayRequested &&
          this.#config.features.reconnect.enabled &&
          this.#resumeState !== undefined
        ) {
          this.#gapReplayRequested = true;
          this.#send({
            version: 1,
            type: "resume",
            roomEpoch: this.#resumeState.roomEpoch,
            afterSequence: this.#sequences.lastSequence,
          });
          this.#scheduleGapRecovery();
        } else {
          socket.close(4001, "canonical sequence gap");
        }
      }
    }, delay);
  }

  #clearGapRecovery(): void {
    if (this.#gapTimer !== undefined) {
      this.#timers.clearTimeout(this.#gapTimer);
      this.#gapTimer = undefined;
    }
    this.#gapExpected = undefined;
    this.#gapReplayRequested = false;
  }

  #acceptPong(raw: Record<string, unknown>): void {
    const pingId = readString(raw, "pingId", "id");
    const serverTime = readNumber(raw, "serverTime", "serverTimeMs");
    if (pingId === undefined || serverTime === undefined) {
      throw new Error("Pong omitted ping id or server time.");
    }
    const sample = this.clock.complete(pingId, serverTime);
    const estimate = this.clock.estimate;
    if (sample !== undefined && estimate !== undefined) {
      this.emit("timeSync", {
        sample,
        estimate,
        uncertaintyMs: estimate.roundTripMs / 2,
      });
    }
    if (this.#initialPingRemaining > 0 && this.connected) {
      this.#initialPingRemaining -= 1;
      this.ping();
    }
  }

  #acceptServerError(raw: Record<string, unknown>): void {
    const retryAfterMs = readNumber(raw, "retryAfterMs");
    const error: RelayPlayServerError = {
      code: readString(raw, "code") ?? "SERVER_ERROR",
      message: readString(raw, "message") ?? "RelayPlay server error",
      retriable: raw["retriable"] === true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    this.emit("serverError", error);
    if (!error.retriable) {
      this.#fatalClose = true;
      this.#socket?.close(1008, error.code);
      this.#connectDeferred?.reject(new Error(`${error.code}: ${error.message}`));
    }
  }

  #sendReady(): void {
    const idempotencyKey =
      this.#readyIdempotencyKey ?? this.#ids.next("ready");
    this.#readyIdempotencyKey = idempotencyKey;
    this.#send({
      version: 1,
      type: "ready",
      ready: this.#desiredReady,
      idempotencyKey,
    });
  }

  #send(message: ClientMessage): ClientMessage {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocketReadyState.OPEN) {
      throw new Error("WebSocket is not open.");
    }
    const result = safeParseClientMessage(message, {
      maxMessageBytes: this.#config.security.maxMessageBytes,
      maxPayloadBytes: this.#config.security.maxPayloadBytes,
    });
    if (!result.success) {
      throw new Error(
        `Invalid client message: ${result.issues
          .map((entry) => `${entry.path} ${entry.message}`)
          .join("; ")}`,
      );
    }
    socket.send(
      encodeJsonPayload(result.data, this.#config.security.maxMessageBytes),
    );
    return result.data;
  }

  #handleClose(
    socket: WebSocketLike,
    generation: number,
    event: CloseEvent,
  ): void {
    if (socket !== this.#socket || generation !== this.#generation) {
      return;
    }
    this.#socket = undefined;
    this.#stopConnectedSchedulers();
    const willReconnect =
      !this.#manualClose &&
      !this.#fatalClose &&
      this.#reconnectPolicy.enabled &&
      this.#reconnectAttempt < this.#reconnectPolicy.maxAttempts;
    this.emit("disconnected", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      willReconnect,
    });
    if (willReconnect) {
      this.#scheduleReconnectOrFail(event);
      return;
    }
    this.#setState("closed");
    this.#connectDeferred?.reject(
      new Error(event.reason || `WebSocket closed with code ${event.code}.`),
    );
  }

  #scheduleReconnectOrFail(error: unknown): void {
    if (
      this.#manualClose ||
      this.#fatalClose ||
      !this.#reconnectPolicy.enabled ||
      this.#reconnectAttempt >= this.#reconnectPolicy.maxAttempts
    ) {
      this.#setState("closed");
      this.#connectDeferred?.reject(error);
      return;
    }
    if (this.#reconnectTimer !== undefined) {
      return;
    }
    this.#reconnectAttempt += 1;
    const delayMs = reconnectDelay(
      this.#reconnectAttempt,
      this.#reconnectPolicy,
      this.#random,
    );
    this.#setState("reconnecting");
    this.emit("reconnecting", {
      attempt: this.#reconnectAttempt,
      delayMs,
    });
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#openSocket(true);
    }, delayMs);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) {
      this.#timers.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #startConnectedSchedulers(): void {
    if (
      this.#progressProvider !== undefined &&
      this.#config.features.progress.enabled
    ) {
      this.#progressScheduler?.start();
    }
    if (this.#config.time.sync.enabled) {
      this.#initialPingRemaining = Math.max(
        0,
        this.#config.time.sync.sampleCount - 1,
      );
      this.ping();
      this.#timeSyncTimer = this.#timers.setInterval(() => {
        if (this.connected) {
          this.ping();
        }
      }, this.#config.time.sync.resyncIntervalMs);
    }
  }

  #stopConnectedSchedulers(): void {
    this.#progressScheduler?.stop();
    if (this.#timeSyncTimer !== undefined) {
      this.#timers.clearInterval(this.#timeSyncTimer);
      this.#timeSyncTimer = undefined;
    }
    this.#initialPingRemaining = 0;
  }

  async #safeSaveResume(): Promise<void> {
    if (this.#resumeState === undefined) {
      return;
    }
    try {
      await this.#resumeStore.save(this.#resumeState);
    } catch (error) {
      this.#reportError(error, "resume-store");
    }
  }

  async #safeClearResume(): Promise<void> {
    try {
      await this.#resumeStore.clear(this.#options.roomId);
    } catch (error) {
      this.#reportError(error, "resume-store");
    }
  }

  #reportError(error: unknown, source: RelayPlayClientErrorSource): void {
    this.emit("error", { error, source });
  }
}
