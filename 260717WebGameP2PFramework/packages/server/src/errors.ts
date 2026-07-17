import type { ErrorSignal, RoomErrorCode } from "./types.js";

export interface RoomEngineErrorOptions {
  readonly retriable?: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class RoomEngineError extends Error {
  public readonly code: RoomErrorCode;
  public readonly retriable: boolean;
  public readonly retryAfterMs: number | undefined;

  public constructor(
    code: RoomErrorCode,
    message: string,
    options: RoomEngineErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RoomEngineError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  public toSignal(): ErrorSignal {
    return this.retryAfterMs === undefined
      ? {
          version: 1,
          type: "error",
          code: this.code,
          message: this.message,
          retriable: this.retriable,
        }
      : {
          version: 1,
          type: "error",
          code: this.code,
          message: this.message,
          retriable: this.retriable,
          retryAfterMs: this.retryAfterMs,
        };
  }
}

export function asRoomEngineError(error: unknown): RoomEngineError {
  if (error instanceof RoomEngineError) {
    return error;
  }
  return new RoomEngineError("INTERNAL_ERROR", "The room engine could not process the message", {
    cause: error,
    retriable: true,
  });
}
