import { describe, expect, it } from "vitest";

import { RoomEngineError } from "@relayplay/server";

import { parseRoomCommand } from "../src/protocol.js";

const limits = { maxMessageBytes: 1_024, maxPayloadBytes: 128 };

describe("Cloudflare protocol boundary", () => {
  it("uses the core strict decoder and retains ping correlation", () => {
    expect(
      parseRoomCommand(
        JSON.stringify({
          version: 1,
          type: "ping",
          pingId: "ping-key-001",
          clientTime: 123.5,
        }),
        limits,
      ),
    ).toEqual({
      version: 1,
      type: "ping",
      pingId: "ping-key-001",
      clientTime: 123.5,
    });
  });

  it("rejects unknown fields before the room policy runs", () => {
    expect(() =>
      parseRoomCommand(
        JSON.stringify({
          version: 1,
          type: "ready",
          ready: true,
          idempotencyKey: "ready-key-01",
          injected: true,
        }),
        limits,
      ),
    ).toThrowError(RoomEngineError);
  });

  it("maps payload and envelope limits to MESSAGE_TOO_LARGE", () => {
    try {
      parseRoomCommand(
        JSON.stringify({
          version: 1,
          type: "progress",
          sequence: 1,
          payload: "x".repeat(256),
        }),
        limits,
      );
      throw new Error("expected parser to reject oversized payload");
    } catch (error) {
      expect(error).toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    }
  });
});
