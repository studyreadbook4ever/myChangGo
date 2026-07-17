import {
  inputEventTimestamp,
  type GameInputListener,
  type InputBinding,
  type InputPhase,
} from "./common.js";

export interface PointerInputTarget extends EventTarget {
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export type PointerActionResolver = (
  event: PointerEvent,
) => string | undefined;

export interface PointerInputOptions {
  readonly target: PointerInputTarget;
  readonly onInput: GameInputListener;
  readonly action?: string;
  readonly resolveAction?: PointerActionResolver;
  readonly preventDefault?: boolean;
  readonly capturePointer?: boolean;
}

export function bindPointerInput(options: PointerInputOptions): InputBinding {
  if (options.action === undefined && options.resolveAction === undefined) {
    throw new TypeError("Pointer input requires an action or resolveAction.");
  }

  const active = new Map<number, string>();
  const preventDefault = options.preventDefault ?? true;

  const emit = (
    event: PointerEvent,
    action: string,
    phase: InputPhase,
  ): void => {
    options.onInput({
      action,
      source: "pointer",
      phase,
      value: phase === "pressed" ? 1 : 0,
      timestamp: inputEventTimestamp(event),
      control: `${event.pointerType || "pointer"}:${event.pointerId}`,
      deviceId: event.pointerType || "pointer",
      originalEvent: event,
    });
  };

  const onPointerDown = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const action = options.resolveAction?.(event) ?? options.action;
    if (action === undefined || active.has(event.pointerId)) {
      return;
    }
    if (preventDefault && event.cancelable) {
      event.preventDefault();
    }
    active.set(event.pointerId, action);
    if (options.capturePointer ?? true) {
      options.target.setPointerCapture?.(event.pointerId);
    }
    emit(event, action, "pressed");
  };

  const finish = (rawEvent: Event, phase: InputPhase): void => {
    const event = rawEvent as PointerEvent;
    const action = active.get(event.pointerId);
    if (action === undefined) {
      return;
    }
    active.delete(event.pointerId);
    if (preventDefault && event.cancelable) {
      event.preventDefault();
    }
    options.target.releasePointerCapture?.(event.pointerId);
    emit(event, action, phase);
  };
  const onPointerUp = (event: Event): void => finish(event, "released");
  const onPointerCancel = (event: Event): void => finish(event, "cancelled");

  options.target.addEventListener("pointerdown", onPointerDown);
  options.target.addEventListener("pointerup", onPointerUp);
  options.target.addEventListener("pointercancel", onPointerCancel);

  return {
    dispose: () => {
      options.target.removeEventListener("pointerdown", onPointerDown);
      options.target.removeEventListener("pointerup", onPointerUp);
      options.target.removeEventListener("pointercancel", onPointerCancel);
      active.clear();
    },
  };
}
