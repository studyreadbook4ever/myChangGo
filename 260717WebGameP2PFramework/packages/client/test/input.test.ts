import { describe, expect, it, vi } from "vitest";
import { watchGamepads, type GamepadLike } from "../src/input/gamepad.js";
import { bindKeyboardInput } from "../src/input/keyboard.js";
import { bindPointerInput } from "../src/input/pointer.js";
import { bindTouchInput } from "../src/input/touch.js";

function keyboardEvent(
  type: "keydown" | "keyup",
  code: string,
  repeat = false,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
  });
  return event;
}

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    button: { value: 0 },
  });
  return event;
}

function touchEvent(type: string, identifier: number): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "changedTouches", {
    value: [{ identifier }],
  });
  return event;
}

describe("input helpers", () => {
  it("maps keyboard codes and suppresses repeat", () => {
    const target = new EventTarget();
    const onInput = vi.fn();
    const binding = bindKeyboardInput({
      target,
      bindings: { Space: "jump" },
      onInput,
    });

    target.dispatchEvent(keyboardEvent("keydown", "Space"));
    target.dispatchEvent(keyboardEvent("keydown", "Space", true));
    target.dispatchEvent(keyboardEvent("keyup", "Space"));

    expect(onInput.mock.calls.map(([event]) => event.phase)).toEqual([
      "pressed",
      "released",
    ]);
    binding.dispose();
  });

  it("reports gamepad button transitions", () => {
    const onInput = vi.fn();
    const pad: GamepadLike = {
      id: "test-pad",
      index: 0,
      connected: true,
      buttons: [{ pressed: false, value: 0 }],
      axes: [],
    };
    const watcher = watchGamepads({
      bindings: [{ action: "jump", button: 0 }],
      onInput,
      getGamepads: () => [pad],
      autoStart: false,
    });

    watcher.poll();
    (pad.buttons as { pressed: boolean; value: number }[])[0] = {
      pressed: true,
      value: 1,
    };
    watcher.poll();
    (pad.buttons as { pressed: boolean; value: number }[])[0] = {
      pressed: false,
      value: 0,
    };
    watcher.poll();

    expect(onInput.mock.calls.map(([event]) => event.phase)).toEqual([
      "pressed",
      "released",
    ]);
  });

  it("tracks pointer and touch identifiers through release", () => {
    const pointerTarget = new EventTarget();
    const touchTarget = new EventTarget();
    const onPointer = vi.fn();
    const onTouch = vi.fn();
    const pointer = bindPointerInput({
      target: pointerTarget,
      action: "lane-left",
      onInput: onPointer,
    });
    const touch = bindTouchInput({
      target: touchTarget,
      action: "lane-right",
      onInput: onTouch,
    });

    pointerTarget.dispatchEvent(pointerEvent("pointerdown", 4));
    pointerTarget.dispatchEvent(pointerEvent("pointerup", 4));
    touchTarget.dispatchEvent(touchEvent("touchstart", 8));
    touchTarget.dispatchEvent(touchEvent("touchend", 8));

    expect(onPointer.mock.calls.map(([event]) => event.phase)).toEqual([
      "pressed",
      "released",
    ]);
    expect(onTouch.mock.calls.map(([event]) => event.phase)).toEqual([
      "pressed",
      "released",
    ]);
    pointer.dispose();
    touch.dispose();
  });
});
