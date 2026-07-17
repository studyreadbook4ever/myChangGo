export interface RelayPlaySocketUrlOptions {
  readonly roomId: string;
  readonly token?: string;
  readonly playerId?: string;
  readonly sessionId?: string;
  readonly resumeEpoch?: number;
  readonly afterSequence?: number;
  readonly baseUrl?: string;
}

function setOptional(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) {
    params.set(key, String(value));
  }
}

/** Builds the adapter endpoint without putting credentials in protocol bodies. */
export function buildRelayPlayWebSocketUrl(
  endpoint: string | URL,
  options: RelayPlaySocketUrlOptions,
): string {
  const encodedRoomId = encodeURIComponent(options.roomId);
  const source = String(endpoint).replaceAll("{roomId}", encodedRoomId);
  const fallbackBase =
    options.baseUrl ?? globalThis.location?.href ?? "http://relayplay.invalid/";
  const url = new URL(source, fallbackBase);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("RelayPlay WebSocket URL must use ws, wss, http, or https.");
  }

  setOptional(url.searchParams, "token", options.token);
  setOptional(url.searchParams, "playerId", options.playerId);
  setOptional(url.searchParams, "sessionId", options.sessionId);
  setOptional(url.searchParams, "resumeEpoch", options.resumeEpoch);
  setOptional(url.searchParams, "afterSequence", options.afterSequence);
  return url.toString();
}
