import {
  inputEventTimestamp,
  type GameInputListener,
  type InputBinding,
  type InputPhase,
} from "./common.js";

export type TouchActionResolver = (
  event: TouchEvent,
  touch: Touch,
) => string | undefined;

export interface TouchInputOptions {
  readonly target: EventTarget;
  readonly onInput: GameInputListener;
  readonly action?: string;
  readonly resolveAction?: TouchActionResolver;
  readonly preventDefault?: boolean;
}

export function bindTouchInput(options: TouchInputOptions): InputBinding {
  if (options.action === undefined && options.resolveAction === undefined) {
    throw new TypeError("Touch input requires an action or resolveAction.");
  }

  const active = new Map<number, string>();
  const preventDefault = options.preventDefault ?? true;

  const emit = (
    event: TouchEvent,
    touch: Touch,
    action: string,
    phase: InputPhase,
  ): void => {
    options.onInput({
      action,
      source: "touch",
      phase,
      value: phase === "pressed" ? 1 : 0,
      timestamp: inputEventTimestamp(event),
      control: `touch:${touch.identifier}`,
      deviceId: "touchscreen",
      originalEvent: event,
    });
  };

  const onTouchStart = (rawEvent: Event): void => {
    const event = rawEvent as TouchEvent;
    let handled = false;
    for (const touch of event.changedTouches) {
      const action = options.resolveAction?.(event, touch) ?? options.action;
      if (action === undefined || active.has(touch.identifier)) {
        continue;
      }
      active.set(touch.identifier, action);
      emit(event, touch, action, "pressed");
      handled = true;
    }
    if (handled && preventDefault && event.cancelable) {
      event.preventDefault();
    }
  };

  const finish = (rawEvent: Event, phase: InputPhase): void => {
    const event = rawEvent as TouchEvent;
    let handled = false;
    for (const touch of event.changedTouches) {
      const action = active.get(touch.identifier);
      if (action === undefined) {
        continue;
      }
      active.delete(touch.identifier);
      emit(event, touch, action, phase);
      handled = true;
    }
    if (handled && preventDefault && event.cancelable) {
      event.preventDefault();
    }
  };
  const onTouchEnd = (event: Event): void => finish(event, "released");
  const onTouchCancel = (event: Event): void => finish(event, "cancelled");

  options.target.addEventListener("touchstart", onTouchStart, { passive: false });
  options.target.addEventListener("touchend", onTouchEnd, { passive: false });
  options.target.addEventListener("touchcancel", onTouchCancel, {
    passive: false,
  });

  return {
    dispose: () => {
      options.target.removeEventListener("touchstart", onTouchStart);
      options.target.removeEventListener("touchend", onTouchEnd);
      options.target.removeEventListener("touchcancel", onTouchCancel);
      active.clear();
    },
  };
}
