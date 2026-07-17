import { describe, expect, it } from "vitest";
import {
  decodeJsonPayload,
  encodeJsonPayload,
  SocketPayloadError,
} from "../src/socket-codec.js";

describe("WebSocket JSON codec", () => {
  it("decodes text and binary JSON", async () => {
    expect(await decodeJsonPayload('{"ok":true}', 100)).toEqual({ ok: true });
    expect(
      await decodeJsonPayload(new TextEncoder().encode('[1,2]').buffer, 100),
    ).toEqual([1, 2]);
  });

  it("enforces the byte cap before protocol parsing", async () => {
    await expect(decodeJsonPayload("12345", 4)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    expect(() => encodeJsonPayload({ value: "large" }, 4)).toThrow(
      SocketPayloadError,
    );
  });
});
