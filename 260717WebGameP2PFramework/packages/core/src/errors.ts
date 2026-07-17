import type { ValidationIssue } from "./validation.js";

export type RelayPlayErrorCode =
  | "CONFIG_INVALID"
  | "PROTOCOL_INVALID"
  | "PROTOCOL_TOO_LARGE"
  | "TIME_SYNC_INVALID"
  | "CAPABILITY_INVALID"
  | "INVARIANT_VIOLATION";

export interface SerializedRelayPlayError {
  readonly name: string;
  readonly code: RelayPlayErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  readonly details: unknown;
}

export class RelayPlayError<TDetails = unknown> extends Error {
  public readonly code: RelayPlayErrorCode;
  public readonly retriable: boolean;
  public readonly details: TDetails | undefined;

  public constructor(
    code: RelayPlayErrorCode,
    message: string,
    options: { readonly retriable?: boolean; readonly details?: TDetails } = {},
  ) {
    super(message);
    this.name = "RelayPlayError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.details = options.details;
  }

  public toJSON(): SerializedRelayPlayError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      details: this.details,
    };
  }
}

export class ConfigValidationError extends RelayPlayError<readonly ValidationIssue[]> {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    super("CONFIG_INVALID", "RelayPlay configuration is invalid", { details: issues });
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export class ProtocolValidationError extends RelayPlayError<readonly ValidationIssue[]> {
  public readonly issues: readonly ValidationIssue[];

  public constructor(
    issues: readonly ValidationIssue[],
    code: "PROTOCOL_INVALID" | "PROTOCOL_TOO_LARGE" = "PROTOCOL_INVALID",
  ) {
    super(code, "RelayPlay protocol message is invalid", { details: issues });
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

export class TimeSyncError extends RelayPlayError {
  public constructor(message: string, details?: unknown) {
    super("TIME_SYNC_INVALID", message, { details });
    this.name = "TimeSyncError";
  }
}

export class CapabilityValidationError extends RelayPlayError<readonly ValidationIssue[]> {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    super("CAPABILITY_INVALID", "Platform capabilities are invalid", { details: issues });
    this.name = "CapabilityValidationError";
    this.issues = issues;
  }
}

export class InvariantViolationError extends RelayPlayError {
  public constructor(message: string, details?: unknown) {
    super("INVARIANT_VIOLATION", message, { details });
    this.name = "InvariantViolationError";
  }
}
