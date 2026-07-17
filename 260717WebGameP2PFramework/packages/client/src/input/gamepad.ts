import { monotonicEpochClock, type Clock } from "../time-sync.js";
import type { GameInputListener, InputBinding } from "./common.js";

export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly buttons: readonly GamepadButtonLike[];
  readonly axes: readonly number[];
}

export type GamepadBinding =
  | {
      readonly action: string;
      readonly button: number;
      readonly gamepadIndex?: number;
      readonly threshold?: number;
    }
  | {
      readonly action: string;
      readonly axis: number;
      readonly direction: -1 | 1;
      readonly gamepadIndex?: number;
      readonly threshold?: number;
    };

export interface AnimationFrameApi {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const browserAnimationFrames: AnimationFrameApi = {
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (handle) => globalThis.cancelAnimationFrame(handle),
};

export interface GamepadInputOptions {
  readonly bindings: readonly GamepadBinding[];
  readonly onInput: GameInputListener;
  readonly getGamepads?: () => readonly (GamepadLike | null)[];
  readonly animationFrames?: AnimationFrameApi;
  readonly clock?: Clock;
  readonly autoStart?: boolean;
}

export interface GamepadInputBinding extends InputBinding {
  readonly running: boolean;
  start(): void;
  stop(): void;
  poll(): void;
}

export function watchGamepads(
  options: GamepadInputOptions,
): GamepadInputBinding {
  const getGamepads =
    options.getGamepads ??
    (() => {
      const navigator = globalThis.navigator;
      return navigator?.getGamepads?.() ?? [];
    });
  const animationFrames = options.animationFrames ?? browserAnimationFrames;
  const clock = options.clock ?? monotonicEpochClock;
  const active = new Map<string, { action: string; pad: GamepadLike }>();
  let frame: number | undefined;
  let running = false;

  const bindingKey = (
    gamepadIndex: number,
    bindingIndex: number,
  ): string => `${gamepadIndex}:${bindingIndex}`;

  const readBinding = (
    pad: GamepadLike,
    binding: GamepadBinding,
  ): { pressed: boolean; value: number; control: string } => {
    const threshold = binding.threshold ?? 0.5;
    if ("button" in binding) {
      const button = pad.buttons[binding.button];
      const value = button?.value ?? 0;
      return {
        pressed: button?.pressed === true || value >= threshold,
        value,
        control: `button:${binding.button}`,
      };
    }
    const rawValue = pad.axes[binding.axis] ?? 0;
    const value = Math.max(0, rawValue * binding.direction);
    return {
      pressed: value >= threshold,
      value,
      control: `axis:${binding.axis}:${binding.direction}`,
    };
  };

  const poll = (): void => {
    const pads = getGamepads();
    const seen = new Set<string>();
    for (const pad of pads) {
      if (pad === null || !pad.connected) {
        continue;
      }
      options.bindings.forEach((binding, bindingIndex) => {
        if (
          binding.gamepadIndex !== undefined &&
          binding.gamepadIndex !== pad.index
        ) {
          return;
        }
        const key = bindingKey(pad.index, bindingIndex);
        seen.add(key);
        const value = readBinding(pad, binding);
        const wasActive = active.has(key);
        if (value.pressed && !wasActive) {
          active.set(key, { action: binding.action, pad });
          options.onInput({
            action: binding.action,
            source: "gamepad",
            phase: "pressed",
            value: value.value,
            timestamp: clock.now(),
            control: value.control,
            deviceId: pad.id,
          });
        } else if (!value.pressed && wasActive) {
          active.delete(key);
          options.onInput({
            action: binding.action,
            source: "gamepad",
            phase: "released",
            value: 0,
            timestamp: clock.now(),
            control: value.control,
            deviceId: pad.id,
          });
        }
      });
    }

    for (const [key, previous] of active) {
      if (seen.has(key)) {
        continue;
      }
      active.delete(key);
      options.onInput({
        action: previous.action,
        source: "gamepad",
        phase: "cancelled",
        value: 0,
        timestamp: clock.now(),
        control: key,
        deviceId: previous.pad.id,
      });
    }
  };

  const schedule = (): void => {
    if (!running) {
      return;
    }
    frame = animationFrames.request(() => {
      poll();
      schedule();
    });
  };

  const result: GamepadInputBinding = {
    get running() {
      return running;
    },
    start: () => {
      if (running) {
        return;
      }
      running = true;
      poll();
      schedule();
    },
    stop: () => {
      running = false;
      if (frame !== undefined) {
        animationFrames.cancel(frame);
        frame = undefined;
      }
    },
    poll,
    dispose: () => {
      result.stop();
      active.clear();
    },
  };

  if (options.autoStart ?? true) {
    result.start();
  }
  return result;
}
