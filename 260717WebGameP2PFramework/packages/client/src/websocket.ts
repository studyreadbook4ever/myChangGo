export const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type WebSocketReadyStateValue =
  (typeof WebSocketReadyState)[keyof typeof WebSocketReadyState];

export interface WebSocketEventMap {
  open: Event;
  close: CloseEvent;
  error: Event;
  message: MessageEvent<unknown>;
}

/** The browser WebSocket surface used by the SDK; intentionally easy to mock. */
export interface WebSocketLike {
  readonly readyState: number;
  addEventListener<Key extends keyof WebSocketEventMap>(
    type: Key,
    listener: (event: WebSocketEventMap[Key]) => void,
  ): void;
  removeEventListener<Key extends keyof WebSocketEventMap>(
    type: Key,
    listener: (event: WebSocketEventMap[Key]) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | readonly string[],
) => WebSocketLike;

export const browserWebSocketFactory: WebSocketFactory = (url, protocols) => {
  const WebSocketConstructor = globalThis.WebSocket;
  if (WebSocketConstructor === undefined) {
    throw new Error(
      "WebSocket is unavailable. Supply a webSocketFactory when running outside a browser.",
    );
  }

  const socket =
    protocols === undefined
      ? new WebSocketConstructor(url)
      : new WebSocketConstructor(url, [...protocols]);
  return socket as unknown as WebSocketLike;
};
