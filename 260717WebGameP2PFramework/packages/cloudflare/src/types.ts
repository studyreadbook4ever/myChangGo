import type { RelayPlayConfigInput } from "@relayplay/core";
import type {
  InteractionValidator,
  ReplayVerifier,
  RoomAuthenticator,
  RoomSession,
} from "@relayplay/server";

export interface RelayPlayCloudflareEnv {
  readonly ROOMS: DurableObjectNamespace;
  /** Explicitly insecure local-only credential used by the convenience class. */
  readonly RELAYPLAY_INSECURE_DEV_TOKEN?: string;
}

export interface CloudflareRoomOptions<Env> {
  readonly authenticate: (
    request: Parameters<RoomAuthenticator>[0],
    env: Env,
  ) => ReturnType<RoomAuthenticator>;
  readonly extractCredential?: (request: Request, env: Env) => unknown | Promise<unknown>;
  readonly config?: RelayPlayConfigInput;
  readonly validateInteraction?: InteractionValidator;
  readonly verifyReplay?: ReplayVerifier;
  readonly minimumPlayersToStart?: number;
  readonly replayBatchSize?: number;
}

export interface WorkerRouterOptions {
  readonly binding?: string;
  readonly routePrefix?: string;
  readonly healthPath?: string;
  readonly roomIdPattern?: RegExp;
  readonly allowedOrigins?: readonly string[];
}

export interface WebSocketAttachment {
  readonly version: 1;
  readonly roomId: string;
  readonly connectionId: string;
  readonly playerId?: string;
  readonly session?: RoomSession;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  getByName(name: string): DurableObjectStubLike;
}
