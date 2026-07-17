import { describe, expect, it } from "vitest";

import { createWorker } from "../src/worker.js";
import type {
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
} from "../src/types.js";

class FakeNamespace implements DurableObjectNamespaceLike {
  public roomId: string | undefined;
  public request: Request | undefined;

  public getByName(name: string): DurableObjectStubLike {
    this.roomId = name;
    return {
      fetch: async (request) => {
        this.request = request;
        return Response.json({ forwarded: true });
      },
    };
  }
}

describe("Cloudflare Worker router", () => {
  it("routes one opaque room ID to one Durable Object name", async () => {
    const rooms = new FakeNamespace();
    const worker = createWorker<{ readonly ROOMS: FakeNamespace }>();
    const response = await worker.fetch(
      new Request(
        "https://game.example/rooms/room_alpha/ws?token=short-lived&playerId=player_one",
        { headers: { Upgrade: "websocket" } },
      ),
      { ROOMS: rooms },
    );

    expect(response.status).toBe(200);
    expect(rooms.roomId).toBe("room_alpha");
    const forwarded = new URL(rooms.request?.url ?? "https://invalid.example");
    expect(forwarded.pathname).toBe("/websocket");
    expect(forwarded.searchParams.get("roomId")).toBe("room_alpha");
    expect(forwarded.searchParams.get("token")).toBe("short-lived");
  });

  it("does not allocate Durable Objects for invalid IDs or health checks", async () => {
    const rooms = new FakeNamespace();
    const worker = createWorker<{ readonly ROOMS: FakeNamespace }>();
    const invalid = await worker.fetch(
      new Request("https://game.example/rooms/tiny/ws", {
        headers: { Upgrade: "websocket" },
      }),
      { ROOMS: rooms },
    );
    const health = await worker.fetch(
      new Request("https://game.example/health"),
      { ROOMS: rooms },
    );

    expect(invalid.status).toBe(400);
    expect(health.status).toBe(200);
    expect(rooms.roomId).toBeUndefined();
  });

  it("can enforce the browser WebSocket Origin at the public edge", async () => {
    const rooms = new FakeNamespace();
    const worker = createWorker<{ readonly ROOMS: FakeNamespace }>({
      allowedOrigins: ["https://game.example"],
    });
    const response = await worker.fetch(
      new Request("https://api.example/rooms/room_alpha/ws", {
        headers: {
          Upgrade: "websocket",
          Origin: "https://attacker.example",
        },
      }),
      { ROOMS: rooms },
    );

    expect(response.status).toBe(403);
    expect(rooms.roomId).toBeUndefined();
  });
});
