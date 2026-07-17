import {
  inputEventTimestamp,
  type GameInputListener,
  type InputBinding,
} from "./common.js";

export interface KeyboardInputOptions {
  readonly bindings: Readonly<Record<string, string>>;
  readonly onInput: GameInputListener;
  readonly target?: EventTarget;
  readonly preventDefault?: boolean;
  readonly ignoreRepeat?: boolean;
  readonly releaseOnBlur?: boolean;
}

export function bindKeyboardInput(
  options: KeyboardInputOptions,
): InputBinding {
  const target = options.target ?? globalThis.window;
  if (target === undefined) {
    throw new Error("Keyboard events are unavailable. Supply an event target.");
  }

  const active = new Map<string, string>();
  const preventDefault = options.preventDefault ?? true;
  const ignoreRepeat = options.ignoreRepeat ?? true;

  const onKeyDown = (rawEvent: Event): void => {
    const event = rawEvent as KeyboardEvent;
    const action = options.bindings[event.code];
    if (action === undefined || (ignoreRepeat && event.repeat)) {
      return;
    }
    if (preventDefault && event.cancelable) {
      event.preventDefault();
    }
    if (active.has(event.code)) {
      return;
    }
    active.set(event.code, action);
    options.onInput({
      action,
      source: "keyboard",
      phase: "pressed",
      value: 1,
      timestamp: inputEventTimestamp(event),
      control: event.code,
      originalEvent: event,
    });
  };

  const onKeyUp = (rawEvent: Event): void => {
    const event = rawEvent as KeyboardEvent;
    const action = active.get(event.code);
    if (action === undefined) {
      return;
    }
    active.delete(event.code);
    if (preventDefault && event.cancelable) {
      event.preventDefault();
    }
    options.onInput({
      action,
      source: "keyboard",
      phase: "released",
      value: 0,
      timestamp: inputEventTimestamp(event),
      control: event.code,
      originalEvent: event,
    });
  };

  const releaseActive = (rawEvent: Event): void => {
    const timestamp = inputEventTimestamp(rawEvent);
    for (const [code, action] of active) {
      options.onInput({
        action,
        source: "keyboard",
        phase: "cancelled",
        value: 0,
        timestamp,
        control: code,
        originalEvent: rawEvent,
      });
    }
    active.clear();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  if (options.releaseOnBlur ?? true) {
    target.addEventListener("blur", releaseActive);
  }

  return {
    dispose: () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", releaseActive);
      active.clear();
    },
  };
}
