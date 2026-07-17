export type SocketPayloadErrorCode =
  | "UNSUPPORTED_DATA"
  | "MESSAGE_TOO_LARGE"
  | "INVALID_JSON";

export class SocketPayloadError extends Error {
  readonly code: SocketPayloadErrorCode;

  constructor(code: SocketPayloadErrorCode, message: string) {
    super(message);
    this.name = "SocketPayloadError";
    this.code = code;
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
}

function checkBytes(byteLength: number, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new SocketPayloadError(
      "MESSAGE_TOO_LARGE",
      `WebSocket message exceeds ${maxBytes} bytes.`,
    );
  }
}

async function payloadText(data: unknown, maxBytes: number): Promise<string> {
  if (typeof data === "string") {
    checkBytes(new TextEncoder().encode(data).byteLength, maxBytes);
    return data;
  }
  if (data instanceof ArrayBuffer) {
    checkBytes(data.byteLength, maxBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    checkBytes(data.byteLength, maxBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    checkBytes(data.size, maxBytes);
    return data.text();
  }
  throw new SocketPayloadError(
    "UNSUPPORTED_DATA",
    "WebSocket message must be text, Blob, ArrayBuffer, or an ArrayBuffer view.",
  );
}

export async function decodeJsonPayload(
  data: unknown,
  maxBytes: number,
): Promise<unknown> {
  assertMaxBytes(maxBytes);
  let text: string;
  try {
    text = await payloadText(data, maxBytes);
  } catch (error) {
    if (error instanceof SocketPayloadError) {
      throw error;
    }
    throw new SocketPayloadError("INVALID_JSON", "Message is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SocketPayloadError("INVALID_JSON", "Message is not valid JSON.");
  }
}

export function encodeJsonPayload(value: unknown, maxBytes: number): string {
  assertMaxBytes(maxBytes);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SocketPayloadError("INVALID_JSON", "Message is not JSON serializable.");
  }
  if (serialized === undefined) {
    throw new SocketPayloadError("INVALID_JSON", "Message is not JSON serializable.");
  }
  checkBytes(new TextEncoder().encode(serialized).byteLength, maxBytes);
  return serialized;
}
