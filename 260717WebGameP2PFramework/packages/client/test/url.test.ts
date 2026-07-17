import { describe, expect, it } from "vitest";
import { buildRelayPlayWebSocketUrl } from "../src/url.js";

describe("buildRelayPlayWebSocketUrl", () => {
  it("upgrades HTTPS and appends join and resume query parameters", () => {
    const value = buildRelayPlayWebSocketUrl(
      "https://example.test/rooms/{roomId}/ws?region=ap",
      {
        roomId: "room / one",
        token: "test-token",
        playerId: "player-1",
        sessionId: "session-1",
        resumeEpoch: 2,
        afterSequence: 9,
      },
    );
    const url = new URL(value);

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/rooms/room%20%2F%20one/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      region: "ap",
      token: "test-token",
      playerId: "player-1",
      sessionId: "session-1",
      resumeEpoch: "2",
      afterSequence: "9",
    });
  });
});
