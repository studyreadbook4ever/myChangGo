export type InputSource = "keyboard" | "pointer" | "touch" | "gamepad";
export type InputPhase = "pressed" | "released" | "cancelled";

export interface GameInputEvent {
  readonly action: string;
  readonly source: InputSource;
  readonly phase: InputPhase;
  readonly value: number;
  readonly timestamp: number;
  readonly control: string;
  readonly deviceId?: string;
  readonly originalEvent?: Event;
}

export type GameInputListener = (event: GameInputEvent) => void;

export interface InputBinding {
  dispose(): void;
}

export function inputEventTimestamp(event: Event): number {
  return Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : globalThis.performance?.now() ?? Date.now();
}
