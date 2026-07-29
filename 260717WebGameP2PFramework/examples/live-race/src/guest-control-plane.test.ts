import { describe, expect, it, vi } from "vitest";

import {
  createGuestRoom,
  deriveGuestEndpoints,
  GuestControlPlaneError,
  joinGuestRoom,
  MAX_GUEST_RESPONSE_BYTES,
  readBoundedJson,
} from "./guest-control-plane.js";

const INVITE = "invite_abcdefghijklmnopqrstuvwxyz";

function jsonResponse(value: unknown, status = 201): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("accountless guest control plane", () => {
  it("derives only the HTTP and WebSocket origins from an entered endpoint", () => {
    expect(
      deriveGuestEndpoints("wss://play.example.test/rooms/{roomId}/ws?ignored=yes"),
    ).toEqual({
      httpOrigin: "https://play.example.test",
      webSocketOrigin: "wss://play.example.test",
    });
    expect(deriveGuestEndpoints("ws://127.0.0.1:8080/rooms/{roomId}/ws")).toEqual({
      httpOrigin: "http://127.0.0.1:8080",
      webSocketOrigin: "ws://127.0.0.1:8080",
    });
    expect(() =>
      deriveGuestEndpoints("wss://secret@play.example.test/rooms/{roomId}/ws"),
    ).toThrow(GuestControlPlaneError);
    expect(() => deriveGuestEndpoints("not a websocket origin", "not a base")).toThrow(
      GuestControlPlaneError,
    );
  });

  it("creates a room with credentials and validates the bounded response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        roomId: "room_alpha",
        playerId: "player_alpha",
        invite: INVITE,
        webSocketPath: "/rooms/room_alpha/ws",
      }),
    );
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(
      createGuestRoom("wss://play.example.test/rooms/{roomId}/ws", fetcher),
    ).resolves.toEqual({
      roomId: "room_alpha",
      playerId: "player_alpha",
      invite: INVITE,
      serverUrl: "wss://play.example.test/rooms/room_alpha/ws",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://play.example.test/api/rooms",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        redirect: "error",
        body: "{}",
      }),
    );
  });

  it("keeps an invite in the JSON body and rejects endpoint injection", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        roomId: "room_bravo",
        playerId: "player_bravo",
        webSocketPath: "//attacker.example/ws",
      }),
    );
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(
      joinGuestRoom("https://play.example.test", INVITE, fetcher),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://play.example.test/api/join");
    expect(url).not.toContain(INVITE);
    expect(options.body).toBe(JSON.stringify({ invite: INVITE }));
  });

  it("stops reading a response beyond the hard byte limit", async () => {
    const oversized = new Response("x".repeat(MAX_GUEST_RESPONSE_BYTES + 1));
    await expect(readBoundedJson(oversized)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });
});
