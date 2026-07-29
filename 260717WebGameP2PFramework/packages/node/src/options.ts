import {
  mergeConfig,
  type RelayPlayConfig,
  type RelayPlayConfigInput,
} from "@relayplay/core";
import type { RoomEngineOptions } from "@relayplay/server";

export interface RelayPlayLogger {
  info(event: string, data?: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, data?: Readonly<Record<string, string | number | boolean>>): void;
  error(event: string, data?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface RelayPlayNodeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly databasePath?: string;
  readonly allowedOrigins: readonly string[];
  /** Trust X-Forwarded-For only when this process is unreachable except through your proxy. */
  readonly trustProxy?: boolean;
  readonly secureCookies?: boolean;
  readonly insecureDevelopment?: boolean;
  readonly cookieName?: string;
  readonly config?: RelayPlayConfigInput;
  readonly minimumPlayersToStart?: number;
  readonly replayBatchSize?: number;
  readonly maxRooms?: number;
  readonly roomTtlMs?: number;
  readonly credentialTtlMs?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerIp?: number;
  readonly maxBufferedBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly maxRequestBodyBytes?: number;
  readonly exposeMetrics?: boolean;
  readonly logger?: RelayPlayLogger;
  readonly validateInteraction?: RoomEngineOptions["validateInteraction"];
  readonly validateProgress?: RoomEngineOptions["validateProgress"];
  readonly validateFinish?: RoomEngineOptions["validateFinish"];
  readonly verifyReplay?: RoomEngineOptions["verifyReplay"];
}

export interface ResolvedNodeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly trustProxy: boolean;
  readonly secureCookies: boolean;
  readonly insecureDevelopment: boolean;
  readonly cookieName: string | undefined;
  readonly config: RelayPlayConfig;
  readonly minimumPlayersToStart: number;
  readonly replayBatchSize: number;
  readonly maxRooms: number;
  readonly roomTtlMs: number;
  readonly credentialTtlMs: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  readonly maxBufferedBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly maxRequestBodyBytes: number;
  readonly exposeMetrics: boolean;
  readonly logger: RelayPlayLogger;
  readonly validateInteraction: RoomEngineOptions["validateInteraction"];
  readonly validateProgress: RoomEngineOptions["validateProgress"];
  readonly validateFinish: RoomEngineOptions["validateFinish"];
  readonly verifyReplay: RoomEngineOptions["verifyReplay"];
}

const silentLogger: RelayPlayLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function normalizeLogger(value: RelayPlayLogger | undefined): RelayPlayLogger {
  const source = value ?? silentLogger;
  if (
    source === null ||
    typeof source !== "object" ||
    typeof source.info !== "function" ||
    typeof source.warn !== "function" ||
    typeof source.error !== "function"
  ) {
    throw new TypeError("logger must provide info, warn, and error functions");
  }
  return {
    info: (event, data) => {
      try {
        source.info(event, data);
      } catch {
        // Logging is observational and must not break room correctness.
      }
    },
    warn: (event, data) => {
      try {
        source.warn(event, data);
      } catch {
        // Logging is observational and must not break room correctness.
      }
    },
    error: (event, data) => {
      try {
        source.error(event, data);
      } catch {
        // Logging is observational and must not break room correctness.
      }
    },
  };
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${String(maximum)}`);
  }
  return value;
}

function optionalBoolean(name: string, value: boolean | undefined, fallback: boolean): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value ?? fallback;
}

function assertOptionalCallback(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

function validateCookieName(name: string | undefined, secure: boolean): string | undefined {
  if (name === undefined) return undefined;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) {
    throw new TypeError("cookieName contains unsafe characters");
  }
  if (name.startsWith("__Host-")) {
    throw new TypeError("__Host- cookie names cannot be used with a room-scoped cookie path");
  }
  if (name.startsWith("__Secure-") && !secure) {
    throw new TypeError("__Secure- cookie names require secureCookies: true");
  }
  return name;
}

function normalizeOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError("allowedOrigins must contain at least one explicit origin");
  }
  const normalized = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length === 0 || origin.length > 2_048) {
      throw new TypeError("allowedOrigins contains an invalid origin");
    }
    if (origin === "*") throw new TypeError("wildcard origins are not allowed");
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new TypeError(`invalid allowed origin: ${origin}`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TypeError(`invalid allowed origin: ${origin}`);
    }
    if (normalized.has(url.origin)) {
      throw new TypeError(`duplicate allowed origin: ${origin}`);
    }
    normalized.add(url.origin);
  }
  return normalized;
}

export function resolveNodeServerOptions(
  options: RelayPlayNodeServerOptions,
): ResolvedNodeServerOptions {
  const port = options.port ?? 8080;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer from 0 to 65535");
  }
  const host = options.host ?? "127.0.0.1";
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host.length > 255 ||
    host.trim() !== host ||
    /[\u0000-\u001F\u007F]/u.test(host)
  ) {
    throw new TypeError("host is invalid");
  }
  const databasePath = options.databasePath ?? "./data/relayplay.sqlite";
  if (
    typeof databasePath !== "string" ||
    databasePath.length === 0 ||
    databasePath.trim() !== databasePath ||
    databasePath.includes("\u0000")
  ) {
    throw new TypeError("databasePath is invalid");
  }
  const insecureDevelopment = optionalBoolean(
    "insecureDevelopment",
    options.insecureDevelopment,
    false,
  );
  const secureCookies = optionalBoolean(
    "secureCookies",
    options.secureCookies,
    !insecureDevelopment,
  );
  const trustProxy = optionalBoolean("trustProxy", options.trustProxy, false);
  const exposeMetrics = optionalBoolean("exposeMetrics", options.exposeMetrics, false);
  const logger = normalizeLogger(options.logger);
  const allowedOrigins = normalizeOrigins(options.allowedOrigins);
  if (!secureCookies && !insecureDevelopment) {
    throw new TypeError("insecure cookies require insecureDevelopment: true");
  }
  if (insecureDevelopment) {
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      throw new TypeError("insecureDevelopment host must be a loopback host");
    }
    for (const origin of allowedOrigins) {
      const hostname = new URL(origin).hostname;
      if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
        throw new TypeError("insecureDevelopment origins must be loopback hosts");
      }
    }
  } else {
    for (const origin of allowedOrigins) {
      if (new URL(origin).protocol !== "https:") {
        throw new TypeError("production allowedOrigins must use HTTPS");
      }
    }
  }
  const cookieName = validateCookieName(options.cookieName, secureCookies);

  assertOptionalCallback("validateInteraction", options.validateInteraction);
  assertOptionalCallback("validateProgress", options.validateProgress);
  assertOptionalCallback("validateFinish", options.validateFinish);
  assertOptionalCallback("verifyReplay", options.verifyReplay);

  const config = mergeConfig(
    {
      room: { maxPlayers: 4 },
      features: {
        interactions: { enabled: false, targeted: false, scheduled: false },
      },
    },
    options.config ?? {},
  );
  if (config.room.maxPlayers > 4) {
    throw new RangeError("the self-hosted small-room harness is capped at four players");
  }
  if (config.features.interactions.enabled && options.validateInteraction === undefined) {
    throw new TypeError("enabled interactions require validateInteraction");
  }
  if (
    (config.features.ranking.enabled || config.features.verification.finalResults) &&
    options.validateFinish === undefined
  ) {
    throw new TypeError("ranking or finalResults verification requires validateFinish");
  }
  if (config.features.verification.finalResults && options.verifyReplay === undefined) {
    throw new TypeError("finalResults verification requires verifyReplay");
  }

  const maxConnections = positiveInteger(
    "maxConnections",
    options.maxConnections ?? 1_000,
    100_000,
  );
  const maxConnectionsPerIp = positiveInteger(
    "maxConnectionsPerIp",
    options.maxConnectionsPerIp ?? 8,
    1_000,
  );
  if (maxConnectionsPerIp > maxConnections) {
    throw new RangeError("maxConnectionsPerIp cannot exceed maxConnections");
  }

  return {
    host,
    port,
    databasePath,
    allowedOrigins,
    trustProxy,
    secureCookies,
    insecureDevelopment,
    cookieName,
    config,
    minimumPlayersToStart: positiveInteger(
      "minimumPlayersToStart",
      options.minimumPlayersToStart ?? Math.min(2, config.room.maxPlayers),
      config.room.maxPlayers,
    ),
    replayBatchSize: positiveInteger("replayBatchSize", options.replayBatchSize ?? 512, 65_536),
    maxRooms: positiveInteger("maxRooms", options.maxRooms ?? 1_000, 1_000_000),
    roomTtlMs: positiveInteger("roomTtlMs", options.roomTtlMs ?? 86_400_000, 2_592_000_000),
    credentialTtlMs: positiveInteger(
      "credentialTtlMs",
      options.credentialTtlMs ?? 43_200_000,
      2_592_000_000,
    ),
    maxConnections,
    maxConnectionsPerIp,
    maxBufferedBytes: positiveInteger(
      "maxBufferedBytes",
      options.maxBufferedBytes ?? 262_144,
      67_108_864,
    ),
    heartbeatIntervalMs: positiveInteger(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs ?? 30_000,
      300_000,
    ),
    shutdownGraceMs: positiveInteger(
      "shutdownGraceMs",
      options.shutdownGraceMs ?? 5_000,
      60_000,
    ),
    maxRequestBodyBytes: positiveInteger(
      "maxRequestBodyBytes",
      options.maxRequestBodyBytes ?? 4_096,
      65_536,
    ),
    exposeMetrics,
    logger,
    validateInteraction: options.validateInteraction,
    validateProgress: options.validateProgress,
    validateFinish: options.validateFinish,
    verifyReplay: options.verifyReplay,
  };
}
