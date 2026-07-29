import { readFileSync } from "node:fs";
import type { RelayPlayConfigInput } from "@relayplay/core";

import {
  resolveNodeServerOptions,
  type RelayPlayLogger,
  type RelayPlayNodeServerOptions,
} from "./options.js";

const ENVIRONMENT_KEYS = new Set([
  "RELAYPLAY_ALLOWED_ORIGINS",
  "RELAYPLAY_CONFIG_PATH",
  "RELAYPLAY_COOKIE_NAME",
  "RELAYPLAY_CREDENTIAL_TTL_MS",
  "RELAYPLAY_DATABASE_PATH",
  "RELAYPLAY_EXPOSE_METRICS",
  "RELAYPLAY_HEARTBEAT_INTERVAL_MS",
  "RELAYPLAY_HOST",
  "RELAYPLAY_INSECURE_DEVELOPMENT",
  "RELAYPLAY_MAX_BUFFERED_BYTES",
  "RELAYPLAY_MAX_CONNECTIONS",
  "RELAYPLAY_MAX_CONNECTIONS_PER_IP",
  "RELAYPLAY_MAX_REQUEST_BODY_BYTES",
  "RELAYPLAY_MAX_ROOMS",
  "RELAYPLAY_MINIMUM_PLAYERS",
  "RELAYPLAY_PORT",
  "RELAYPLAY_REPLAY_BATCH_SIZE",
  "RELAYPLAY_ROOM_TTL_MS",
  "RELAYPLAY_SECURE_COOKIES",
  "RELAYPLAY_SHUTDOWN_GRACE_MS",
  "RELAYPLAY_TRUST_PROXY",
]);

function rejectUnknownKeys(environment: NodeJS.ProcessEnv): void {
  const unknown = Object.keys(environment)
    .filter((key) => key.startsWith("RELAYPLAY_") && !ENVIRONMENT_KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`unsupported RelayPlay environment variable: ${unknown.join(", ")}`);
  }
}

function string(environment: NodeJS.ProcessEnv, key: string, fallback: string): string;
function string(environment: NodeJS.ProcessEnv, key: string): string | undefined;
function string(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback?: string,
): string | undefined {
  const raw = environment[key];
  if (raw === undefined) return fallback;
  if (raw.length === 0 || raw.trim() !== raw || raw.includes("\u0000")) {
    throw new Error(`${key} must be a non-empty string without surrounding whitespace`);
  }
  return raw;
}

function integer(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  const raw = environment[key];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < (options.minimum ?? 0) ||
    value > (options.maximum ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${key} is outside its supported range`);
  }
  return value;
}

function boolean(environment: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = environment[key];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
}

function configFromFile(path: string | undefined): RelayPlayConfigInput | undefined {
  if (path === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("RELAYPLAY_CONFIG_PATH could not be read as JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RELAYPLAY_CONFIG_PATH must contain a JSON object");
  }
  return value as RelayPlayConfigInput;
}

const consoleLogger: RelayPlayLogger = {
  info: (event, data) => console.log(JSON.stringify({ ...data, level: "info", event })),
  warn: (event, data) => console.warn(JSON.stringify({ ...data, level: "warn", event })),
  error: (event, data) => console.error(JSON.stringify({ ...data, level: "error", event })),
};

/** Strict environment bridge used only by the CLI composition root. */
export function nodeServerOptionsFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): RelayPlayNodeServerOptions {
  rejectUnknownKeys(environment);
  const insecureDevelopment = boolean(environment, "RELAYPLAY_INSECURE_DEVELOPMENT", false);
  const rawOrigins = environment["RELAYPLAY_ALLOWED_ORIGINS"];
  if (rawOrigins === undefined || rawOrigins.trim().length === 0) {
    throw new Error("RELAYPLAY_ALLOWED_ORIGINS is required");
  }
  const allowedOrigins = rawOrigins.split(",").map((value) => value.trim());
  if (allowedOrigins.some((origin) => origin.length === 0)) {
    throw new Error("RELAYPLAY_ALLOWED_ORIGINS contains an empty origin");
  }
  const config = configFromFile(string(environment, "RELAYPLAY_CONFIG_PATH"));
  const cookieName = string(environment, "RELAYPLAY_COOKIE_NAME");
  const options: RelayPlayNodeServerOptions = {
    host: string(
      environment,
      "RELAYPLAY_HOST",
      insecureDevelopment ? "127.0.0.1" : "0.0.0.0",
    ),
    port: integer(environment, "RELAYPLAY_PORT", 8080, { maximum: 65_535 }),
    databasePath: string(
      environment,
      "RELAYPLAY_DATABASE_PATH",
      "./data/relayplay.sqlite",
    ),
    allowedOrigins,
    trustProxy: boolean(environment, "RELAYPLAY_TRUST_PROXY", false),
    insecureDevelopment,
    secureCookies: boolean(environment, "RELAYPLAY_SECURE_COOKIES", !insecureDevelopment),
    ...(cookieName === undefined ? {} : { cookieName }),
    ...(config === undefined ? {} : { config }),
    minimumPlayersToStart: integer(environment, "RELAYPLAY_MINIMUM_PLAYERS", 2, {
      minimum: 1,
      maximum: 4,
    }),
    maxRooms: integer(environment, "RELAYPLAY_MAX_ROOMS", 1_000, { minimum: 1 }),
    maxConnections: integer(environment, "RELAYPLAY_MAX_CONNECTIONS", 1_000, { minimum: 1 }),
    maxConnectionsPerIp: integer(environment, "RELAYPLAY_MAX_CONNECTIONS_PER_IP", 8, {
      minimum: 1,
      maximum: 1_000,
    }),
    replayBatchSize: integer(environment, "RELAYPLAY_REPLAY_BATCH_SIZE", 512, {
      minimum: 1,
      maximum: 65_536,
    }),
    roomTtlMs: integer(environment, "RELAYPLAY_ROOM_TTL_MS", 86_400_000, {
      minimum: 1,
      maximum: 2_592_000_000,
    }),
    credentialTtlMs: integer(environment, "RELAYPLAY_CREDENTIAL_TTL_MS", 43_200_000, {
      minimum: 1,
      maximum: 2_592_000_000,
    }),
    maxBufferedBytes: integer(environment, "RELAYPLAY_MAX_BUFFERED_BYTES", 262_144, {
      minimum: 1,
      maximum: 67_108_864,
    }),
    heartbeatIntervalMs: integer(environment, "RELAYPLAY_HEARTBEAT_INTERVAL_MS", 30_000, {
      minimum: 1,
      maximum: 300_000,
    }),
    shutdownGraceMs: integer(environment, "RELAYPLAY_SHUTDOWN_GRACE_MS", 5_000, {
      minimum: 1,
      maximum: 60_000,
    }),
    maxRequestBodyBytes: integer(environment, "RELAYPLAY_MAX_REQUEST_BODY_BYTES", 4_096, {
      minimum: 1,
      maximum: 65_536,
    }),
    exposeMetrics: boolean(environment, "RELAYPLAY_EXPOSE_METRICS", false),
    logger: consoleLogger,
  };
  // Fail at process startup, not when the first request exercises a bad option.
  resolveNodeServerOptions(options);
  return options;
}
