import type {
  BroadcastOptions,
  RoomBroadcaster,
  RoomSession,
  RoomSignal,
} from "@relayplay/server";
import WebSocket from "ws";

export interface NodeBroadcasterOptions {
  readonly maxBufferedBytes: number;
  readonly onProgressDropped?: () => void;
  readonly onSlowConsumer?: () => void;
}

export interface NodeConnectionRecord {
  readonly connectionId: string;
  readonly roomId: string;
  readonly ip: string;
  readonly socket: WebSocket;
  session?: RoomSession;
  playerId?: string;
  alive: boolean;
  /** A newer connection owns this player; its close must not disconnect that session. */
  superseded: boolean;
}

function playerKey(roomId: string, playerId: string): string {
  return `${roomId}\u0000${playerId}`;
}

/** In-process WebSocket fanout adapter. It never owns room policy or storage. */
export class NodeRoomBroadcaster implements RoomBroadcaster {
  readonly #connections = new Map<string, NodeConnectionRecord>();
  readonly #activePlayers = new Map<string, string>();
  readonly #maxBufferedBytes: number;
  readonly #onProgressDropped: () => void;
  readonly #onSlowConsumer: () => void;

  public constructor(options: NodeBroadcasterOptions) {
    this.#maxBufferedBytes = options.maxBufferedBytes;
    this.#onProgressDropped = options.onProgressDropped ?? (() => undefined);
    this.#onSlowConsumer = options.onSlowConsumer ?? (() => undefined);
  }

  public get size(): number {
    return this.#connections.size;
  }

  public records(): readonly NodeConnectionRecord[] {
    return [...this.#connections.values()];
  }

  public countIp(ip: string): number {
    let count = 0;
    for (const record of this.#connections.values()) {
      if (record.ip === ip) count += 1;
    }
    return count;
  }

  public attachPending(record: Omit<NodeConnectionRecord, "alive" | "superseded">): void {
    if (this.#connections.has(record.connectionId)) {
      throw new Error("connection ID is already attached");
    }
    this.#connections.set(record.connectionId, {
      ...record,
      alive: true,
      superseded: false,
    });
  }

  public activate(
    connectionId: string,
    session: RoomSession,
    replacedConnectionId?: string,
  ): void {
    const record = this.#connections.get(connectionId);
    if (
      record === undefined ||
      record.roomId !== session.roomId ||
      record.session !== undefined
    ) {
      throw new Error("pending WebSocket is not attached to this room");
    }
    const key = playerKey(session.roomId, session.playerId);
    const previousIds = new Set<string>();
    const mappedConnectionId = this.#activePlayers.get(key);
    if (mappedConnectionId !== undefined) previousIds.add(mappedConnectionId);
    if (replacedConnectionId !== undefined) previousIds.add(replacedConnectionId);

    // Publish new ownership before evicting old sockets. A synchronous or very
    // fast old close can therefore never remove/disconnect the replacement.
    record.session = session;
    record.playerId = session.playerId;
    record.superseded = false;
    this.#activePlayers.set(key, connectionId);
    for (const previousId of previousIds) {
      if (previousId === connectionId) continue;
      const previous = this.#connections.get(previousId);
      if (previous === undefined) continue;
      previous.superseded = true;
      if (previous.socket.readyState === WebSocket.OPEN) {
        try {
          previous.socket.close(4001, "session replaced by reconnect");
        } catch {
          try {
            previous.socket.terminate();
          } catch {
            // The replacement already owns routing; old-socket cleanup is best effort.
          }
        }
      }
    }
  }

  public detach(connectionId: string): NodeConnectionRecord | undefined {
    const record = this.#connections.get(connectionId);
    if (record === undefined) return undefined;
    this.#connections.delete(connectionId);
    if (record.playerId !== undefined) {
      const key = playerKey(record.roomId, record.playerId);
      if (this.#activePlayers.get(key) === connectionId) this.#activePlayers.delete(key);
    }
    return record;
  }

  public get(connectionId: string): NodeConnectionRecord | undefined {
    return this.#connections.get(connectionId);
  }

  public send(connectionId: string, signal: RoomSignal): void {
    const record = this.#connections.get(connectionId);
    if (record === undefined) return;
    this.#sendEncoded(record, signal, JSON.stringify(signal));
  }

  public sendToPlayer(roomId: string, playerId: string, signal: RoomSignal): void {
    const connectionId = this.#activePlayers.get(playerKey(roomId, playerId));
    if (connectionId === undefined) return;
    const record = this.#connections.get(connectionId);
    if (record !== undefined) this.#sendEncoded(record, signal, JSON.stringify(signal));
  }

  public broadcast(roomId: string, signal: RoomSignal, options: BroadcastOptions = {}): void {
    const encoded = JSON.stringify(signal);
    const players = options.playerIds === undefined ? undefined : new Set(options.playerIds);
    for (const record of this.#connections.values()) {
      if (
        record.session === undefined ||
        record.superseded ||
        record.roomId !== roomId ||
        record.connectionId === options.exceptConnectionId ||
        (players !== undefined &&
          (record.playerId === undefined || !players.has(record.playerId)))
      ) {
        continue;
      }
      this.#sendEncoded(record, signal, encoded);
    }
  }

  public heartbeat(): void {
    for (const record of this.#connections.values()) {
      if (!record.alive) {
        record.socket.terminate();
        continue;
      }
      record.alive = false;
      try {
        record.socket.ping();
      } catch {
        record.socket.terminate();
      }
    }
  }

  public markAlive(connectionId: string): void {
    const record = this.#connections.get(connectionId);
    if (record !== undefined) record.alive = true;
  }

  public closeAll(code: number, reason: string): void {
    for (const record of this.#connections.values()) {
      if (record.socket.readyState === WebSocket.OPEN) record.socket.close(code, reason);
    }
  }

  public terminateAll(): void {
    for (const record of this.#connections.values()) record.socket.terminate();
  }

  #sendEncoded(record: NodeConnectionRecord, signal: RoomSignal, encoded: string): void {
    if (record.socket.readyState !== WebSocket.OPEN) return;
    if (record.socket.bufferedAmount > this.#maxBufferedBytes) {
      if (signal.type === "progress") {
        this.#onProgressDropped();
        return;
      }
      this.#onSlowConsumer();
      record.socket.close(1013, "consumer too slow; reconnect to resume");
      return;
    }
    record.socket.send(encoded, { binary: false, compress: false }, (error) => {
      // ws currently reports successful writes as either undefined or null at
      // runtime, despite the declaration exposing only an optional Error.
      if (error) record.socket.close(1011, "send failed");
    });
  }
}
