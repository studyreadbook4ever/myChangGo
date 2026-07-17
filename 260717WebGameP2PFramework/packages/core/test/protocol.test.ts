import { describe, expect, it } from "vitest";

import {
  decodeClientMessage,
  encodeProtocolMessage,
  safeDecodeClientMessage,
  safeParseClientMessage,
  safeParseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../src/protocol.js";

describe("client protocol validation", () => {
  const validMessages: readonly ClientMessage[] = [
    { version: 1, type: "ready", ready: true, idempotencyKey: "ready-key-001" },
    { version: 1, type: "progress", sequence: 2, payload: { score: 10 } },
    {
      version: 1,
      type: "interaction",
      idempotencyKey: "freeze-key-01",
      action: "freeze",
      targetPlayerId: "player-two",
      effectiveAt: { kind: "server-time", serverTimeMs: 10_000 },
      payload: { durationMs: 750 },
    },
    { version: 1, type: "ack", sequence: 8 },
    { version: 1, type: "resume", roomEpoch: 1, afterSequence: 8 },
    { version: 1, type: "ping", pingId: "ping-key-001", clientTime: 123.5 },
    {
      version: 1,
      type: "evidence",
      idempotencyKey: "evidence-001",
      evidenceType: "state-hash",
      payload: { tick: 20, hash: "abc" },
    },
  ];

  it.each(validMessages)("accepts $type", (message) => {
    expect(safeParseClientMessage(message)).toEqual({ success: true, data: message });
    expect(decodeClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects unknown keys and unsafe target identifiers", () => {
    const result = safeParseClientMessage({
      version: 1,
      type: "interaction",
      idempotencyKey: "freeze-key-01",
      action: "freeze",
      targetPlayerId: "me",
      payload: null,
      injected: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((problem) => problem.code)).toContain("unknown_key");
      expect(result.issues.map((problem) => problem.code)).toContain("out_of_range");
    }
  });

  it("rejects malformed and oversized frames before dispatch", () => {
    expect(safeDecodeClientMessage("not json").success).toBe(false);
    const result = safeParseClientMessage(
      { version: 1, type: "progress", sequence: 1, payload: "too-large" },
      { maxMessageBytes: 128, maxPayloadBytes: 4 },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((problem) => problem.code === "too_large")).toBe(true);
    }
  });
});

describe("server protocol validation", () => {
  const event = {
    roomId: "room-demo",
    roomEpoch: 1,
    eventId: "event-0001",
    sequence: 1,
    kind: "start",
    createdAt: 8_000,
    effectiveAt: { kind: "server-time", serverTimeMs: 10_000 },
    payload: { startAt: 10_000, players: ["player-one", "player-two"] },
  } as const;

  const validMessages: readonly ServerMessage[] = [
    {
      version: 1,
      type: "session",
      roomId: "room-demo",
      roomEpoch: 1,
      playerId: "player-one",
      sessionId: "session-one",
      resumeEpoch: 1,
      status: "waiting",
      lastSequence: 0,
    },
    { version: 1, type: "presence", playerId: "player-two", connected: true, ready: false },
    { version: 1, type: "ready", playerId: "player-two", ready: true },
    {
      version: 1,
      type: "progress",
      playerId: "player-two",
      sequence: 2,
      serverTime: 10_000,
      payload: { score: 12 },
    },
    { version: 1, type: "canonical", event },
    { version: 1, type: "replay", roomEpoch: 1, afterSequence: 0, events: [event] },
    { version: 1, type: "acknowledged", sequence: 1 },
    { version: 1, type: "pong", pingId: "ping-key-001", clientTime: 100, serverTime: 110 },
    { version: 1, type: "error", code: "RATE_LIMITED", message: "slow down", retriable: true, retryAfterMs: 500 },
  ];

  it.each(validMessages)("accepts $type", (message) => {
    expect(safeParseServerMessage(message)).toEqual({ success: true, data: message });
  });

  it("requires starts to carry an explicit future schedule", () => {
    const result = safeParseServerMessage({
      version: 1,
      type: "canonical",
      event: { ...event, effectiveAt: undefined },
    });
    expect(result.success).toBe(false);
  });

  it("enforces the encoded frame cap", () => {
    expect(() =>
      encodeProtocolMessage(
        { version: 1, type: "error", code: "ERROR", message: "x".repeat(100), retriable: false },
        32,
      ),
    ).toThrow();
  });
});
