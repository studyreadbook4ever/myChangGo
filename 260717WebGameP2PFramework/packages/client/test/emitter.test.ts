import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "../src/emitter.js";

interface Events {
  count: number;
  message: { readonly text: string };
}

class ObservedEmitter extends TypedEventEmitter<Events> {
  readonly listenerErrors: unknown[] = [];

  protected override handleListenerError(error: unknown): void {
    this.listenerErrors.push(error);
  }
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

  it("isolates a throwing listener and continues dispatch", () => {
    const emitter = new ObservedEmitter();
    const healthy = vi.fn();
    const failure = new Error("UI failed");
    emitter.on("count", () => {
      throw failure;
    });
    emitter.on("count", healthy);

    expect(emitter.emit("count", 7)).toBe(true);
    expect(healthy).toHaveBeenCalledWith(7);
    expect(emitter.listenerErrors).toEqual([failure]);
  });
});
