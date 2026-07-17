import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "../src/emitter.js";

interface Events {
  count: number;
  message: { readonly text: string };
}

describe("TypedEventEmitter", () => {
  it("subscribes, unsubscribes, and emits synchronously", () => {
    const emitter = new TypedEventEmitter<Events>();
    const listener = vi.fn();
    const off = emitter.on("count", listener);

    expect(emitter.emit("count", 3)).toBe(true);
    expect(listener).toHaveBeenCalledWith(3);

    off();
    expect(emitter.emit("count", 4)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("removes a once listener before invoking it", () => {
    const emitter = new TypedEventEmitter<Events>();
    const listener = vi.fn(() => emitter.emit("message", { text: "nested" }));
    emitter.once("message", listener);

    emitter.emit("message", { text: "first" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
