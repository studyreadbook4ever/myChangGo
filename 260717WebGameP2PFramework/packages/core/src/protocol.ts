import { ProtocolValidationError } from "./errors.js";
import {
  findUnknownKeys,
  hasOwn,
  isPlainObject,
  issue,
  jsonByteLength,
  validateJsonValue,
  validationFailure,
  validationSuccess,
  type JsonValue,
  type ValidationIssue,
  type ValidationResult,
} from "./validation.js";

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_MESSAGE_BYTES = 65_536;
export const DEFAULT_MAX_PAYLOAD_BYTES = 8_192;

export type RoomStatus = "waiting" | "scheduled" | "running" | "finished";
export type EvidenceType = "replay-chunk" | "state-hash" | "result";

export type EffectiveAt =
  | { readonly kind: "server-time"; readonly serverTimeMs: number }
  | { readonly kind: "tick"; readonly tick: number }
  | { readonly kind: "beat"; readonly beat: number }
  | { readonly kind: "boundary"; readonly name: string };

export interface CanonicalEvent {
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "start" | "interaction" | "finish" | "evidence";
  readonly createdAt: number;
  readonly effectiveAt?: EffectiveAt;
  readonly playerId?: string;
  readonly targetPlayerId?: string;
  readonly action?: string;
  readonly payload: JsonValue;
}

export interface ClientReadyMessage {
  readonly version: 1;
  readonly type: "ready";
  readonly ready: boolean;
  readonly idempotencyKey: string;
}

export interface ClientProgressMessage {
  readonly version: 1;
  readonly type: "progress";
  readonly sequence: number;
  readonly payload: JsonValue;
}

export interface ClientInteractionMessage {
  readonly version: 1;
  readonly type: "interaction";
  readonly idempotencyKey: string;
  readonly action: string;
  readonly targetPlayerId?: string;
  readonly effectiveAt?: EffectiveAt;
  readonly payload: JsonValue;
}

export interface ClientAcknowledgeMessage {
  readonly version: 1;
  readonly type: "ack";
  readonly sequence: number;
}

export interface ClientResumeMessage {
  readonly version: 1;
  readonly type: "resume";
  readonly roomEpoch: number;
  readonly afterSequence: number;
}

export interface ClientPingMessage {
  readonly version: 1;
  readonly type: "ping";
  readonly pingId: string;
  readonly clientTime: number;
}

export interface ClientEvidenceMessage {
  readonly version: 1;
  readonly type: "evidence";
  readonly idempotencyKey: string;
  readonly evidenceType: EvidenceType;
  readonly payload: JsonValue;
}

export type ClientMessage =
  | ClientReadyMessage
  | ClientProgressMessage
  | ClientInteractionMessage
  | ClientAcknowledgeMessage
  | ClientResumeMessage
  | ClientPingMessage
  | ClientEvidenceMessage;

export interface ServerSessionMessage {
  readonly version: 1;
  readonly type: "session";
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly playerId: string;
  readonly sessionId: string;
  readonly resumeEpoch: number;
  readonly status: RoomStatus;
  readonly lastSequence: number;
}

export interface ServerPresenceMessage {
  readonly version: 1;
  readonly type: "presence";
  readonly playerId: string;
  readonly connected: boolean;
  readonly ready: boolean;
}

export interface ServerReadyMessage {
  readonly version: 1;
  readonly type: "ready";
  readonly playerId: string;
  readonly ready: boolean;
}

export interface ServerProgressMessage {
  readonly version: 1;
  readonly type: "progress";
  readonly playerId: string;
  readonly sequence: number;
  readonly serverTime: number;
  readonly payload: JsonValue;
}

export interface ServerCanonicalMessage {
  readonly version: 1;
  readonly type: "canonical";
  readonly event: CanonicalEvent;
  readonly duplicate?: boolean;
}

export interface ServerReplayMessage {
  readonly version: 1;
  readonly type: "replay";
  readonly roomEpoch: number;
  readonly afterSequence: number;
  readonly events: readonly CanonicalEvent[];
}

export interface ServerAcknowledgedMessage {
  readonly version: 1;
  readonly type: "acknowledged";
  readonly sequence: number;
}

export interface ServerPongMessage {
  readonly version: 1;
  readonly type: "pong";
  readonly pingId: string;
  readonly clientTime: number;
  readonly serverTime: number;
}

export interface ServerErrorMessage {
  readonly version: 1;
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly retryAfterMs?: number;
}

export type ServerMessage =
  | ServerSessionMessage
  | ServerPresenceMessage
  | ServerReadyMessage
  | ServerProgressMessage
  | ServerCanonicalMessage
  | ServerReplayMessage
  | ServerAcknowledgedMessage
  | ServerPongMessage
  | ServerErrorMessage;

/** Compatibility aliases used by provider adapters. */
export type RoomCommand = ClientMessage;
export type RoomSignal = ServerMessage;

export interface ProtocolValidationOptions {
  readonly maxMessageBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly maxReplayEvents?: number;
}

interface ResolvedValidationOptions {
  readonly maxMessageBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxReplayEvents: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/u;
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const BOUNDARY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,63}$/u;

function resolveOptions(options: ProtocolValidationOptions): ResolvedValidationOptions {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxReplayEvents = options.maxReplayEvents ?? 4_096;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new RangeError("maxMessageBytes must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 0 ||
    maxPayloadBytes > maxMessageBytes
  ) {
    throw new RangeError("maxPayloadBytes must be a non-negative integer within maxMessageBytes");
  }
  if (!Number.isSafeInteger(maxReplayEvents) || maxReplayEvents < 1) {
    throw new RangeError("maxReplayEvents must be a positive safe integer");
  }
  return { maxMessageBytes, maxPayloadBytes, maxReplayEvents };
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of findUnknownKeys(value, new Set(keys))) {
    issues.push(issue(`${path}.${key}`, "unknown_key", "unknown protocol field", value[key]));
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): void {
  if (!hasOwn(value, key)) {
    issues.push(issue(path, "missing_key", "required string is missing", undefined));
    return;
  }
  const candidate = value[key];
  if (typeof candidate !== "string") {
    issues.push(issue(path, "invalid_type", "expected a string", candidate));
    return;
  }
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (candidate.length < min || candidate.length > max) {
    issues.push(issue(path, "out_of_range", `expected a string length of ${min}..${max}`, candidate));
  } else if (options.pattern !== undefined && !options.pattern.test(candidate)) {
    issues.push(issue(path, "invalid_format", "string format is invalid", candidate));
  }
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): void {
  if (!hasOwn(value, key)) return;
  requiredString(value, key, path, issues, options);
}

function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(value, key)) {
    issues.push(issue(path, "missing_key", "required boolean is missing", undefined));
  } else if (typeof value[key] !== "boolean") {
    issues.push(issue(path, "invalid_type", "expected a boolean", value[key]));
  }
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(value, key)) return;
  requiredBoolean(value, key, path, issues);
}

function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { readonly integer?: boolean; readonly min?: number; readonly max?: number } = {},
): void {
  if (!hasOwn(value, key)) {
    issues.push(issue(path, "missing_key", "required number is missing", undefined));
    return;
  }
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    issues.push(issue(path, "invalid_type", "expected a finite number", candidate));
    return;
  }
  if (options.integer === true && !Number.isSafeInteger(candidate)) {
    issues.push(issue(path, "invalid_value", "expected a safe integer", candidate));
  }
  const min = options.min ?? -Number.MAX_VALUE;
  const max = options.max ?? Number.MAX_VALUE;
  if (candidate < min || candidate > max) {
    issues.push(issue(path, "out_of_range", `expected ${min}..${max}`, candidate));
  }
}

function optionalNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { readonly integer?: boolean; readonly min?: number; readonly max?: number } = {},
): void {
  if (!hasOwn(value, key)) return;
  requiredNumber(value, key, path, issues, options);
}

function requiredEnum(
  value: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
  issues: ValidationIssue[],
): void {
  if (!hasOwn(value, key)) {
    issues.push(issue(path, "missing_key", "required discriminator is missing", undefined));
    return;
  }
  const candidate = value[key];
  if (typeof candidate !== "string" || !allowed.includes(candidate)) {
    issues.push(issue(path, "invalid_value", `expected one of ${allowed.join(", ")}`, candidate));
  }
}

function validateIdentifier(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  optional = false,
): void {
  if (optional) {
    optionalString(value, key, path, issues, { pattern: IDENTIFIER_PATTERN, min: 8, max: 128 });
  } else {
    requiredString(value, key, path, issues, { pattern: IDENTIFIER_PATTERN, min: 8, max: 128 });
  }
}

function validateIdempotencyKey(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  requiredString(value, "idempotencyKey", path, issues, {
    pattern: IDEMPOTENCY_PATTERN,
    min: 8,
    max: 128,
  });
}

function validatePayload(
  value: Record<string, unknown>,
  key: string,
  path: string,
  maxPayloadBytes: number,
  issues: ValidationIssue[],
): void {
  if (!hasOwn(value, key)) {
    issues.push(issue(path, "missing_key", "required JSON payload is missing", undefined));
    return;
  }
  const payload = value[key];
  const payloadIssues = validateJsonValue(payload, path, { maxDepth: 16, maxNodes: 10_000 });
  issues.push(...payloadIssues);
  if (payloadIssues.length === 0) {
    const bytes = jsonByteLength(payload as JsonValue);
    if (bytes > maxPayloadBytes) {
      issues.push(issue(path, "too_large", `payload exceeds ${maxPayloadBytes} bytes`, bytes));
    }
  }
}

function validateEffectiveAt(
  input: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(input)) {
    issues.push(issue(path, "invalid_type", "effectiveAt must be an object", input));
    return;
  }
  requiredEnum(input, "kind", `${path}.kind`, ["server-time", "tick", "beat", "boundary"], issues);
  switch (input.kind) {
    case "server-time":
      addUnknownKeyIssues(input, ["kind", "serverTimeMs"], path, issues);
      requiredNumber(input, "serverTimeMs", `${path}.serverTimeMs`, issues, { min: 0 });
      break;
    case "tick":
      addUnknownKeyIssues(input, ["kind", "tick"], path, issues);
      requiredNumber(input, "tick", `${path}.tick`, issues, { integer: true, min: 0 });
      break;
    case "beat":
      addUnknownKeyIssues(input, ["kind", "beat"], path, issues);
      requiredNumber(input, "beat", `${path}.beat`, issues, { min: 0 });
      break;
    case "boundary":
      addUnknownKeyIssues(input, ["kind", "name"], path, issues);
      requiredString(input, "name", `${path}.name`, issues, {
        min: 1,
        max: 64,
        pattern: BOUNDARY_PATTERN,
      });
      break;
    default:
      addUnknownKeyIssues(input, ["kind"], path, issues);
  }
}

function validateCanonicalEvent(
  input: unknown,
  path: string,
  options: ResolvedValidationOptions,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(input)) {
    issues.push(issue(path, "invalid_type", "canonical event must be an object", input));
    return;
  }
  addUnknownKeyIssues(
    input,
    [
      "roomId",
      "roomEpoch",
      "eventId",
      "sequence",
      "kind",
      "createdAt",
      "effectiveAt",
      "playerId",
      "targetPlayerId",
      "action",
      "payload",
    ],
    path,
    issues,
  );
  validateIdentifier(input, "roomId", `${path}.roomId`, issues);
  requiredNumber(input, "roomEpoch", `${path}.roomEpoch`, issues, { integer: true, min: 0 });
  validateIdentifier(input, "eventId", `${path}.eventId`, issues);
  requiredNumber(input, "sequence", `${path}.sequence`, issues, { integer: true, min: 1 });
  requiredEnum(input, "kind", `${path}.kind`, ["start", "interaction", "finish", "evidence"], issues);
  requiredNumber(input, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  validateIdentifier(input, "playerId", `${path}.playerId`, issues, true);
  validateIdentifier(input, "targetPlayerId", `${path}.targetPlayerId`, issues, true);
  optionalString(input, "action", `${path}.action`, issues, {
    min: 1,
    max: 64,
    pattern: ACTION_PATTERN,
  });
  if (hasOwn(input, "effectiveAt")) {
    validateEffectiveAt(input.effectiveAt, `${path}.effectiveAt`, issues);
  }
  validatePayload(input, "payload", `${path}.payload`, options.maxPayloadBytes, issues);

  if (input.kind === "start" && !hasOwn(input, "effectiveAt")) {
    issues.push(issue(`${path}.effectiveAt`, "missing_key", "start event requires effectiveAt", undefined));
  }
  if (input.kind === "interaction") {
    if (!hasOwn(input, "playerId")) {
      issues.push(issue(`${path}.playerId`, "missing_key", "interaction actor is missing", undefined));
    }
    if (!hasOwn(input, "action")) {
      issues.push(issue(`${path}.action`, "missing_key", "interaction action is missing", undefined));
    }
  }
  if (input.kind === "evidence" && !hasOwn(input, "action")) {
    issues.push(issue(`${path}.action`, "missing_key", "evidence type is missing", undefined));
  }
}

function validateEnvelope(
  input: unknown,
  options: ResolvedValidationOptions,
  issues: ValidationIssue[],
): input is Record<string, unknown> {
  if (!isPlainObject(input)) {
    issues.push(issue("$", "invalid_type", "protocol message must be an object", input));
    return false;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    issues.push(issue("$", "invalid_value", "protocol message must be JSON serializable", input));
  }
  if (serialized === undefined) {
    issues.push(issue("$", "invalid_type", "protocol message must be JSON serializable", input));
  } else {
    const size = new TextEncoder().encode(serialized).byteLength;
    if (size > options.maxMessageBytes) {
      issues.push(issue("$", "too_large", `message exceeds ${options.maxMessageBytes} bytes`, size));
    }
  }
  if (input.version !== PROTOCOL_VERSION) {
    issues.push(issue("$.version", "invalid_value", "only protocol version 1 is supported", input.version));
  }
  if (typeof input.type !== "string") {
    issues.push(issue("$.type", "invalid_type", "message type must be a string", input.type));
  }
  return true;
}

function validateClientObject(
  input: Record<string, unknown>,
  options: ResolvedValidationOptions,
  issues: ValidationIssue[],
): void {
  switch (input.type) {
    case "ready":
      addUnknownKeyIssues(input, ["version", "type", "ready", "idempotencyKey"], "$", issues);
      requiredBoolean(input, "ready", "$.ready", issues);
      validateIdempotencyKey(input, "$.idempotencyKey", issues);
      break;
    case "progress":
      addUnknownKeyIssues(input, ["version", "type", "sequence", "payload"], "$", issues);
      requiredNumber(input, "sequence", "$.sequence", issues, { integer: true, min: 0 });
      validatePayload(input, "payload", "$.payload", options.maxPayloadBytes, issues);
      break;
    case "interaction":
      addUnknownKeyIssues(
        input,
        ["version", "type", "idempotencyKey", "action", "targetPlayerId", "effectiveAt", "payload"],
        "$",
        issues,
      );
      validateIdempotencyKey(input, "$.idempotencyKey", issues);
      requiredString(input, "action", "$.action", issues, {
        min: 1,
        max: 64,
        pattern: ACTION_PATTERN,
      });
      validateIdentifier(input, "targetPlayerId", "$.targetPlayerId", issues, true);
      if (hasOwn(input, "effectiveAt")) {
        validateEffectiveAt(input.effectiveAt, "$.effectiveAt", issues);
      }
      validatePayload(input, "payload", "$.payload", options.maxPayloadBytes, issues);
      break;
    case "ack":
      addUnknownKeyIssues(input, ["version", "type", "sequence"], "$", issues);
      requiredNumber(input, "sequence", "$.sequence", issues, { integer: true, min: 0 });
      break;
    case "resume":
      addUnknownKeyIssues(input, ["version", "type", "roomEpoch", "afterSequence"], "$", issues);
      requiredNumber(input, "roomEpoch", "$.roomEpoch", issues, { integer: true, min: 0 });
      requiredNumber(input, "afterSequence", "$.afterSequence", issues, { integer: true, min: 0 });
      break;
    case "ping":
      addUnknownKeyIssues(input, ["version", "type", "pingId", "clientTime"], "$", issues);
      requiredString(input, "pingId", "$.pingId", issues, {
        min: 8,
        max: 128,
        pattern: IDEMPOTENCY_PATTERN,
      });
      requiredNumber(input, "clientTime", "$.clientTime", issues);
      break;
    case "evidence":
      addUnknownKeyIssues(
        input,
        ["version", "type", "idempotencyKey", "evidenceType", "payload"],
        "$",
        issues,
      );
      validateIdempotencyKey(input, "$.idempotencyKey", issues);
      requiredEnum(input, "evidenceType", "$.evidenceType", ["replay-chunk", "state-hash", "result"], issues);
      validatePayload(input, "payload", "$.payload", options.maxPayloadBytes, issues);
      break;
    default:
      issues.push(issue("$.type", "invalid_value", "unknown client message type", input.type));
  }
}

function validateServerObject(
  input: Record<string, unknown>,
  options: ResolvedValidationOptions,
  issues: ValidationIssue[],
): void {
  switch (input.type) {
    case "session":
      addUnknownKeyIssues(
        input,
        ["version", "type", "roomId", "roomEpoch", "playerId", "sessionId", "resumeEpoch", "status", "lastSequence"],
        "$",
        issues,
      );
      validateIdentifier(input, "roomId", "$.roomId", issues);
      requiredNumber(input, "roomEpoch", "$.roomEpoch", issues, { integer: true, min: 0 });
      validateIdentifier(input, "playerId", "$.playerId", issues);
      validateIdentifier(input, "sessionId", "$.sessionId", issues);
      requiredNumber(input, "resumeEpoch", "$.resumeEpoch", issues, { integer: true, min: 1 });
      requiredEnum(input, "status", "$.status", ["waiting", "scheduled", "running", "finished"], issues);
      requiredNumber(input, "lastSequence", "$.lastSequence", issues, { integer: true, min: 0 });
      break;
    case "presence":
      addUnknownKeyIssues(input, ["version", "type", "playerId", "connected", "ready"], "$", issues);
      validateIdentifier(input, "playerId", "$.playerId", issues);
      requiredBoolean(input, "connected", "$.connected", issues);
      requiredBoolean(input, "ready", "$.ready", issues);
      break;
    case "ready":
      addUnknownKeyIssues(input, ["version", "type", "playerId", "ready"], "$", issues);
      validateIdentifier(input, "playerId", "$.playerId", issues);
      requiredBoolean(input, "ready", "$.ready", issues);
      break;
    case "progress":
      addUnknownKeyIssues(input, ["version", "type", "playerId", "sequence", "serverTime", "payload"], "$", issues);
      validateIdentifier(input, "playerId", "$.playerId", issues);
      requiredNumber(input, "sequence", "$.sequence", issues, { integer: true, min: 0 });
      requiredNumber(input, "serverTime", "$.serverTime", issues, { min: 0 });
      validatePayload(input, "payload", "$.payload", options.maxPayloadBytes, issues);
      break;
    case "canonical":
      addUnknownKeyIssues(input, ["version", "type", "event", "duplicate"], "$", issues);
      if (!hasOwn(input, "event")) {
        issues.push(issue("$.event", "missing_key", "canonical event is missing", undefined));
      } else {
        validateCanonicalEvent(input.event, "$.event", options, issues);
      }
      optionalBoolean(input, "duplicate", "$.duplicate", issues);
      break;
    case "replay":
      addUnknownKeyIssues(input, ["version", "type", "roomEpoch", "afterSequence", "events"], "$", issues);
      requiredNumber(input, "roomEpoch", "$.roomEpoch", issues, { integer: true, min: 0 });
      requiredNumber(input, "afterSequence", "$.afterSequence", issues, { integer: true, min: 0 });
      if (!Array.isArray(input.events)) {
        issues.push(issue("$.events", "invalid_type", "replay events must be an array", input.events));
      } else if (input.events.length > options.maxReplayEvents) {
        issues.push(issue("$.events", "too_large", `replay exceeds ${options.maxReplayEvents} events`, input.events.length));
      } else {
        input.events.forEach((event, index) => {
          validateCanonicalEvent(event, `$.events[${index}]`, options, issues);
        });
      }
      break;
    case "acknowledged":
      addUnknownKeyIssues(input, ["version", "type", "sequence"], "$", issues);
      requiredNumber(input, "sequence", "$.sequence", issues, { integer: true, min: 0 });
      break;
    case "pong":
      addUnknownKeyIssues(input, ["version", "type", "pingId", "clientTime", "serverTime"], "$", issues);
      requiredString(input, "pingId", "$.pingId", issues, {
        min: 8,
        max: 128,
        pattern: IDEMPOTENCY_PATTERN,
      });
      requiredNumber(input, "clientTime", "$.clientTime", issues);
      requiredNumber(input, "serverTime", "$.serverTime", issues, { min: 0 });
      break;
    case "error":
      addUnknownKeyIssues(input, ["version", "type", "code", "message", "retriable", "retryAfterMs"], "$", issues);
      requiredString(input, "code", "$.code", issues, {
        min: 1,
        max: 64,
        pattern: ERROR_CODE_PATTERN,
      });
      requiredString(input, "message", "$.message", issues, { min: 1, max: 512 });
      requiredBoolean(input, "retriable", "$.retriable", issues);
      optionalNumber(input, "retryAfterMs", "$.retryAfterMs", issues, { min: 0 });
      break;
    default:
      issues.push(issue("$.type", "invalid_value", "unknown server message type", input.type));
  }
}

export function safeParseClientMessage(
  input: unknown,
  options: ProtocolValidationOptions = {},
): ValidationResult<ClientMessage> {
  const resolved = resolveOptions(options);
  const issues: ValidationIssue[] = [];
  if (validateEnvelope(input, resolved, issues)) {
    validateClientObject(input, resolved, issues);
  }
  return issues.length === 0
    ? validationSuccess(input as unknown as ClientMessage)
    : validationFailure(issues);
}

export function safeParseServerMessage(
  input: unknown,
  options: ProtocolValidationOptions = {},
): ValidationResult<ServerMessage> {
  const resolved = resolveOptions(options);
  const issues: ValidationIssue[] = [];
  if (validateEnvelope(input, resolved, issues)) {
    validateServerObject(input, resolved, issues);
  }
  return issues.length === 0
    ? validationSuccess(input as unknown as ServerMessage)
    : validationFailure(issues);
}

function unwrap<T>(result: ValidationResult<T>): T {
  if (result.success) return result.data;
  throw new ProtocolValidationError(
    result.issues,
    result.issues.some((problem) => problem.code === "too_large")
      ? "PROTOCOL_TOO_LARGE"
      : "PROTOCOL_INVALID",
  );
}

export function parseClientMessage(
  input: unknown,
  options: ProtocolValidationOptions = {},
): ClientMessage {
  return unwrap(safeParseClientMessage(input, options));
}

export function parseServerMessage(
  input: unknown,
  options: ProtocolValidationOptions = {},
): ServerMessage {
  return unwrap(safeParseServerMessage(input, options));
}

function safeDecode<T>(
  serialized: string,
  parser: (input: unknown) => ValidationResult<T>,
  maxMessageBytes: number,
): ValidationResult<T> {
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maxMessageBytes) {
    return validationFailure([
      issue("$", "too_large", `message exceeds ${maxMessageBytes} bytes`, bytes),
    ]);
  }
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    return validationFailure([
      issue("$", "invalid_format", "message is not valid JSON", serialized.slice(0, 128)),
    ]);
  }
  return parser(input);
}

export function safeDecodeClientMessage(
  serialized: string,
  options: ProtocolValidationOptions = {},
): ValidationResult<ClientMessage> {
  const resolved = resolveOptions(options);
  return safeDecode(
    serialized,
    (input) => safeParseClientMessage(input, resolved),
    resolved.maxMessageBytes,
  );
}

export function safeDecodeServerMessage(
  serialized: string,
  options: ProtocolValidationOptions = {},
): ValidationResult<ServerMessage> {
  const resolved = resolveOptions(options);
  return safeDecode(
    serialized,
    (input) => safeParseServerMessage(input, resolved),
    resolved.maxMessageBytes,
  );
}

export function decodeClientMessage(
  serialized: string,
  options: ProtocolValidationOptions = {},
): ClientMessage {
  return unwrap(safeDecodeClientMessage(serialized, options));
}

export function decodeServerMessage(
  serialized: string,
  options: ProtocolValidationOptions = {},
): ServerMessage {
  return unwrap(safeDecodeServerMessage(serialized, options));
}

export function encodeProtocolMessage(
  message: ClientMessage | ServerMessage,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): string {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new RangeError("maxMessageBytes must be a positive safe integer");
  }
  const serialized = JSON.stringify(message);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maxMessageBytes) {
    throw new ProtocolValidationError(
      [issue("$", "too_large", `message exceeds ${maxMessageBytes} bytes`, bytes)],
      "PROTOCOL_TOO_LARGE",
    );
  }
  return serialized;
}

export function isClientMessage(input: unknown): input is ClientMessage {
  return safeParseClientMessage(input).success;
}

export function isServerMessage(input: unknown): input is ServerMessage {
  return safeParseServerMessage(input).success;
}
