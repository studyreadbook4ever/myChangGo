import { isPlainObject } from "@relayplay/core";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const INVITE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export const MAX_GUEST_RESPONSE_BYTES = 4_096;

export interface GuestRoomSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly serverUrl: string;
  readonly invite?: string;
}

export interface GuestEndpoints {
  readonly httpOrigin: string;
  readonly webSocketOrigin: string;
}

export class GuestControlPlaneError extends Error {
  public constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = "GuestControlPlaneError";
  }
}

export function validGuestInvite(value: string): boolean {
  return INVITE_PATTERN.test(value);
}

export function deriveGuestEndpoints(
  serverUrl: string,
  baseUrl = globalThis.location?.href ?? "https://relayplay.invalid/",
): GuestEndpoints {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.replaceAll("{roomId}", "room_placeholder"), baseUrl);
  } catch {
    throw new GuestControlPlaneError("invalid_server_url");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.protocol !== "ws:" &&
      parsed.protocol !== "wss:" &&
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:")
  ) {
    throw new GuestControlPlaneError("invalid_server_url");
  }
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  return {
    httpOrigin: `${secure ? "https:" : "http:"}//${parsed.host}`,
    webSocketOrigin: `${secure ? "wss:" : "ws:"}//${parsed.host}`,
  };
}

export async function readBoundedJson(
  response: Response,
  maximumBytes = MAX_GUEST_RESPONSE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
      throw new GuestControlPlaneError("response_too_large", response.status);
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new GuestControlPlaneError("empty_response", response.status);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel("bounded guest response exceeded");
        throw new GuestControlPlaneError("response_too_large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof GuestControlPlaneError) throw error;
    throw new GuestControlPlaneError("invalid_response", response.status);
  }
}

function parseGuestRoomSession(
  value: unknown,
  webSocketOrigin: string,
  requireInvite: boolean,
): GuestRoomSession {
  if (!isPlainObject(value) || value.ok !== true) {
    throw new GuestControlPlaneError("invalid_response");
  }
  const { roomId, playerId, webSocketPath, invite } = value;
  if (
    typeof roomId !== "string" ||
    !IDENTIFIER_PATTERN.test(roomId) ||
    typeof playerId !== "string" ||
    !IDENTIFIER_PATTERN.test(playerId) ||
    typeof webSocketPath !== "string" ||
    webSocketPath !== `/rooms/${roomId}/ws` ||
    (requireInvite && (typeof invite !== "string" || !validGuestInvite(invite)))
  ) {
    throw new GuestControlPlaneError("invalid_response");
  }
  return {
    roomId,
    playerId,
    serverUrl: `${webSocketOrigin}${webSocketPath}`,
    ...(requireInvite ? { invite: invite as string } : {}),
  };
}

async function guestRequest(
  serverUrl: string,
  path: "/api/rooms" | "/api/join",
  body: Readonly<Record<string, string>>,
  requireInvite: boolean,
  fetcher: typeof fetch,
): Promise<GuestRoomSession> {
  const endpoints = deriveGuestEndpoints(serverUrl);
  const response = await fetcher(`${endpoints.httpOrigin}${path}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    const code =
      isPlainObject(payload) &&
      typeof payload.error === "string" &&
      ERROR_CODE_PATTERN.test(payload.error)
        ? payload.error
        : "request_failed";
    throw new GuestControlPlaneError(code, response.status);
  }
  return parseGuestRoomSession(payload, endpoints.webSocketOrigin, requireInvite);
}

export function createGuestRoom(
  serverUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GuestRoomSession> {
  return guestRequest(serverUrl, "/api/rooms", {}, true, fetcher);
}

export function joinGuestRoom(
  serverUrl: string,
  invite: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GuestRoomSession> {
  if (!validGuestInvite(invite)) {
    throw new GuestControlPlaneError("invalid_invite");
  }
  return guestRequest(serverUrl, "/api/join", { invite }, false, fetcher);
}
