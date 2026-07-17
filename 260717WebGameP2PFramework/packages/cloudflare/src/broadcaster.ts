import type {
  BroadcastOptions,
  RoomBroadcaster,
  RoomSignal,
} from "@relayplay/server";

import type { WebSocketAttachment } from "./types.js";

function attachmentOf(socket: WebSocket): WebSocketAttachment | undefined {
  const attachment = socket.deserializeAttachment() as unknown;
  if (
    attachment === null ||
    typeof attachment !== "object" ||
    !("version" in attachment) ||
    attachment.version !== 1 ||
    !("roomId" in attachment) ||
    typeof attachment.roomId !== "string" ||
    !("connectionId" in attachment) ||
    typeof attachment.connectionId !== "string"
  ) {
    return undefined;
  }
  return attachment as WebSocketAttachment;
}

function send(socket: WebSocket, encoded: string): void {
  try {
    socket.send(encoded);
  } catch {
    // A close racing a broadcast is normal; resume replays canonical gaps.
  }
}

/** Hibernation-safe broadcaster backed by Durable Object WebSocket tags. */
export class DurableObjectBroadcaster implements RoomBroadcaster {
  readonly #state: DurableObjectState;

  public constructor(state: DurableObjectState) {
    this.#state = state;
  }

  public send(connectionId: string, signal: RoomSignal): void {
    const encoded = JSON.stringify(signal);
    for (const socket of this.#state.getWebSockets(`connection:${connectionId}`)) {
      send(socket, encoded);
    }
  }

  public sendToPlayer(roomId: string, playerId: string, signal: RoomSignal): void {
    const encoded = JSON.stringify(signal);
    for (const socket of this.#state.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment?.roomId === roomId && attachment.playerId === playerId) {
        send(socket, encoded);
      }
    }
  }

  public broadcast(roomId: string, signal: RoomSignal, options: BroadcastOptions = {}): void {
    const encoded = JSON.stringify(signal);
    const players = options.playerIds === undefined ? undefined : new Set(options.playerIds);
    for (const socket of this.#state.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (
        attachment?.session !== undefined &&
        attachment.roomId === roomId &&
        attachment.connectionId !== options.exceptConnectionId &&
        (players === undefined ||
          (attachment.playerId !== undefined && players.has(attachment.playerId)))
      ) {
        send(socket, encoded);
      }
    }
  }
}

export { attachmentOf as readWebSocketAttachment };
