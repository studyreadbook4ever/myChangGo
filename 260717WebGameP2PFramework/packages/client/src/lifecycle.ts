import { monotonicEpochClock, type Clock } from "./time-sync.js";

export type PageLifecycleState =
  | "active"
  | "passive"
  | "hidden"
  | "frozen"
  | "terminated";

export type PageLifecycleCause =
  | "initial"
  | "focus"
  | "blur"
  | "visibilitychange"
  | "freeze"
  | "resume"
  | "pagehide"
  | "pageshow";

export interface PageLifecycleChange {
  readonly state: PageLifecycleState;
  readonly previousState: PageLifecycleState | undefined;
  readonly cause: PageLifecycleCause;
  readonly timestamp: number;
}

export interface PageLifecycleOptions {
  document?: Document;
  window?: Window;
  clock?: Clock;
  emitInitial?: boolean;
}

export type StopWatching = () => void;

function visibleState(document: Document, window: Window): PageLifecycleState {
  if (document.visibilityState === "hidden") {
    return "hidden";
  }
  return document.hasFocus() && window.document === document
    ? "active"
    : "passive";
}

/** Observes the portable subset of Page Lifecycle and Page Visibility states. */
export function watchPageLifecycle(
  listener: (change: PageLifecycleChange) => void,
  options: PageLifecycleOptions = {},
): StopWatching {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? globalThis.window;
  if (document === undefined || window === undefined) {
    throw new Error(
      "Page lifecycle APIs are unavailable. Supply document and window when testing.",
    );
  }

  const clock = options.clock ?? monotonicEpochClock;
  let state = visibleState(document, window);
  let frozen = false;
  let terminated = false;

  const transition = (
    nextState: PageLifecycleState,
    cause: PageLifecycleCause,
    force = false,
  ): void => {
    if (!force && nextState === state) {
      return;
    }
    const previousState = force ? undefined : state;
    state = nextState;
    listener({ state, previousState, cause, timestamp: clock.now() });
  };

  const onFocus = (): void => {
    if (!frozen && !terminated && document.visibilityState !== "hidden") {
      transition("active", "focus");
    }
  };
  const onBlur = (): void => {
    if (!frozen && !terminated && document.visibilityState !== "hidden") {
      transition("passive", "blur");
    }
  };
  const onVisibilityChange = (): void => {
    if (!frozen && !terminated) {
      transition(visibleState(document, window), "visibilitychange");
    }
  };
  const onFreeze = (): void => {
    frozen = true;
    transition("frozen", "freeze");
  };
  const onResume = (): void => {
    frozen = false;
    if (!terminated) {
      transition(visibleState(document, window), "resume");
    }
  };
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      frozen = true;
      transition("frozen", "pagehide");
      return;
    }
    terminated = true;
    transition("terminated", "pagehide");
  };
  const onPageShow = (): void => {
    frozen = false;
    terminated = false;
    transition(visibleState(document, window), "pageshow");
  };

  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  if (options.emitInitial ?? true) {
    transition(state, "initial", true);
  }

  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("freeze", onFreeze);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
}
