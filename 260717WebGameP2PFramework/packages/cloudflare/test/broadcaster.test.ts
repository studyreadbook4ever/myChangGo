import { describe, expect, it } from "vitest";

import type { RoomSession } from "@relayplay/server";

import { DurableObjectBroadcaster } from "../src/broadcaster.js";
import type { WebSocketAttachment } from "../src/types.js";

interface FakeSocket {
  socket: WebSocket;
  readonly sent: string[];
  attachment: unknown;
}

function fakeSocket(name: string, actions: string[]): FakeSocket {
  const fake: FakeSocket = {
    attachment: undefined,
    sent: [],
    socket: undefined as unknown as WebSocket,
  };
  fake.socket = {
    serializeAttachment: (attachment: unknown) => {
      actions.push(`serialize:${name}`);
      fake.attachment = attachment;
    },
    deserializeAttachment: () => fake.attachment,
    send: (encoded: string) => {
      actions.push(`send:${name}`);
      fake.sent.push(encoded);
    },
    close: (code: number, reason: string) => {
      actions.push(`close:${name}:${code}:${reason}`);
    },
  } as unknown as WebSocket;
  return fake;
}

describe("DurableObjectBroadcaster", () => {
  it("activates the new attachment before signals and evicts the replaced socket", () => {
    const actions: string[] = [];
    const active = fakeSocket("active", actions);
    const replaced = fakeSocket("replaced", actions);
    const state = {
      getWebSockets: (tag?: string) => {
        if (tag === "connection:connection_new") return [active.socket];
        if (tag === "connection:connection_old") return [replaced.socket];
        return [active.socket, replaced.socket];
      },
    } as unknown as DurableObjectState;
    const broadcaster = new DurableObjectBroadcaster(state);
    const session: RoomSession = {
      roomId: "room_0001",
      playerId: "player_0001",
      sessionId: "session_0001",
      resumeEpoch: 2,
      connectionId: "connection_new",
      ready: false,
      connected: true,
      joinedAt: 1_000,
      lastSeenAt: 2_000,
      lastAcknowledgedSequence: 0,
      lastProgressSequence: -1,
      roles: ["player"],
      metadata: {},
    };
    const attachment: WebSocketAttachment = {
      version: 1,
      roomId: session.roomId,
      connectionId: session.connectionId,
      playerId: session.playerId,
      session,
    };

    broadcaster.activateConnection(active.socket, attachment, "connection_old");
    broadcaster.send("connection_new", {
      version: 1,
      type: "error",
      code: "TEST_SIGNAL",
      message: "test",
      retriable: false,
    });

    expect(actions).toEqual([
      "serialize:active",
      "close:replaced:4001:session replaced by reconnect",
      "send:active",
    ]);
    expect(active.attachment).toEqual(attachment);
    expect(active.sent).toHaveLength(1);
  });
});
