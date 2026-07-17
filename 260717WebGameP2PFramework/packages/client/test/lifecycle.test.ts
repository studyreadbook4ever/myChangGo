import { describe, expect, it } from "vitest";
import { watchPageLifecycle } from "../src/lifecycle.js";
import type { Clock } from "../src/time-sync.js";

class LifecycleDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  focused = true;

  hasFocus(): boolean {
    return this.focused;
  }
}

class LifecycleWindow extends EventTarget {
  readonly document: Document;

  constructor(document: Document) {
    super();
    this.document = document;
  }
}

describe("watchPageLifecycle", () => {
  it("reports initial, hidden, frozen, and resumed states", () => {
    const document = new LifecycleDocument();
    const window = new LifecycleWindow(document as unknown as Document);
    let now = 100;
    const clock: Clock = { now: () => now++ };
    const states: string[] = [];
    const stop = watchPageLifecycle(
      (change) => states.push(change.state),
      {
        document: document as unknown as Document,
        window: window as unknown as Window,
        clock,
      },
    );

    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));

    expect(states).toEqual(["active", "hidden", "frozen", "hidden"]);
    stop();
  });
});
