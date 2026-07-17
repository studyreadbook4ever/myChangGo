import {
  RelayPlayClient,
  SessionStorageResumeStore,
  type RelayPlayClientState,
} from "@relayplay/client";
import {
  createPresetConfig,
  isPlainObject,
  type CanonicalEvent,
  type JsonValue,
} from "@relayplay/core";

import { LiveRaceGame, type GamePhase, type LiveRaceProgress } from "./game.js";
import { LiveRaceView, type ConnectionViewState } from "./view.js";

const DEVELOPMENT_TOKEN =
  import.meta.env.VITE_RELAYPLAY_DEV_TOKEN ?? "relayplay-local-only";
const FREEZE_DURATION_MS = 1_250;
const FREEZE_COOLDOWN_MS = 8_000;
const LATE_BOUNDARY_MS = 250;

const config = createPresetConfig("soft-battle", "universal", {
  room: { maxPlayers: 2 },
  progress: { intervalMs: 1_000 },
  features: {
    verification: {
      // The example Worker installs a strict freeze validator.
      interactionClaims: true,
    },
  },
  security: {
    rateLimits: {
      actions: {
        freeze: { capacity: 1, refillPerSecond: 0.125 },
      },
    },
  },
});

const view = new LiveRaceView(document);
const game = new LiveRaceGame(100);
const opponents = new Map<string, { connected: boolean; ready: boolean }>();

let client: RelayPlayClient | undefined;
let localPlayerId = "";
let localReady = false;
let startsAtLocalMs: number | undefined;
let freezeCooldownUntilMs = 0;
let latestRemote:
  | { playerId: string; progress: LiveRaceProgress; receivedAtLocalMs: number }
  | undefined;
let latestUncertaintyMs: number | undefined;

function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

function generatedPlayerId(): string {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `player_${random}`;
}

function defaultEndpoint(): string {
  const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if (local) return "ws://127.0.0.1:8787/rooms/{roomId}/ws";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/rooms/{roomId}/ws`;
}

const search = new URLSearchParams(location.search);
view.setDefaults({
  roomId: search.get("room") ?? "demo-room",
  playerId: search.get("player") ?? generatedPlayerId(),
  serverUrl: search.get("server") ?? defaultEndpoint(),
});

function parsePhase(value: unknown): GamePhase | undefined {
  return value === "lobby" ||
    value === "countdown" ||
    value === "running" ||
    value === "finished"
    ? value
    : undefined;
}

function parseProgress(payload: JsonValue): LiveRaceProgress | undefined {
  if (!isPlainObject(payload)) return undefined;
  const { score, normalizedProgress, combo, phase } = payload;
  const parsedPhase = parsePhase(phase);
  if (
    typeof score !== "number" ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    typeof normalizedProgress !== "number" ||
    !Number.isFinite(normalizedProgress) ||
    normalizedProgress < 0 ||
    normalizedProgress > 1 ||
    typeof combo !== "number" ||
    !Number.isSafeInteger(combo) ||
    combo < 0 ||
    parsedPhase === undefined
  ) {
    return undefined;
  }
  return { score, normalizedProgress, combo, phase: parsedPhase };
}

function progressPayload(): JsonValue {
  const progress = game.snapshot();
  return {
    score: progress.score,
    normalizedProgress: progress.normalizedProgress,
    combo: progress.combo,
    phase: progress.phase,
  };
}

function firstConnectedOpponent(): string | undefined {
  for (const [playerId, state] of opponents) {
    if (state.connected) return playerId;
  }
  return undefined;
}

function viewState(state: RelayPlayClientState): ConnectionViewState {
  switch (state) {
    case "connecting":
    case "handshaking":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "idle":
    case "closing":
    case "closed":
    case "destroyed":
      return "idle";
  }
}

function displayState(state: RelayPlayClientState): string {
  return state === "handshaking" ? "Authenticating" : state[0]?.toUpperCase() + state.slice(1);
}

function effectiveLocalTime(event: CanonicalEvent): number | undefined {
  if (event.effectiveAt?.kind !== "server-time" || client === undefined) return undefined;
  const intended = client.clock.toLocalTime(event.effectiveAt.serverTimeMs);
  const now = monotonicNow();
  if (intended >= now) return intended;
  // The example treats each 250 ms slice as its named "next boundary".
  return Math.ceil(now / LATE_BOUNDARY_MS) * LATE_BOUNDARY_MS;
}

function handleStart(event: CanonicalEvent): void {
  const localTime = effectiveLocalTime(event);
  if (localTime === undefined) {
    view.log("Rejected start without a server-time schedule");
    return;
  }
  startsAtLocalMs = localTime;
  game.scheduleStart(localTime);
  view.log(`Canonical start #${event.sequence} scheduled`);
}

function handleInteraction(event: CanonicalEvent): void {
  if (
    event.action !== "freeze" ||
    event.targetPlayerId !== localPlayerId ||
    !isPlainObject(event.payload)
  ) {
    return;
  }
  const durationMs = event.payload.durationMs;
  const localTime = effectiveLocalTime(event);
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 500 ||
    durationMs > 2_000 ||
    localTime === undefined
  ) {
    view.log(`Ignored malformed freeze event #${event.sequence}`);
    return;
  }
  game.scheduleFreeze({
    eventId: event.eventId,
    startsAtLocalMs: localTime,
    durationMs,
  });
  view.log(`Freeze #${event.sequence} will apply at a safe future boundary`);
}

function attachClientEvents(nextClient: RelayPlayClient): void {
  nextClient.on("statechange", ({ state }) => {
    view.setConnection(viewState(state), displayState(state));
  });
  nextClient.on("connected", (info) => {
    localPlayerId = info.playerId;
    view.setLocalPlayer(info.playerId);
    view.setConnection("connected", info.resumed ? "Resumed" : "Connected");
    view.log(
      `${info.resumed ? "Resumed" : "Joined"} room epoch ${info.roomEpoch}`,
    );
  });
  nextClient.on("disconnected", ({ willReconnect }) => {
    view.log(willReconnect ? "Transport lost; resume scheduled" : "Disconnected");
  });
  nextClient.on("reconnecting", ({ attempt, delayMs }) => {
    view.log(`Reconnect attempt ${attempt} in ${Math.round(delayMs)}ms`);
  });
  nextClient.on("resumed", ({ replayedEvents }) => {
    view.log(`Session resumed; replayed ${replayedEvents} canonical event(s)`);
  });
  nextClient.on("presence", ({ playerId, connected, ready }) => {
    if (playerId === localPlayerId) return;
    opponents.set(playerId, { connected, ready });
    view.log(`${playerId} is ${connected ? "online" : "offline"}`);
  });
  nextClient.on("ready", ({ playerId, ready }) => {
    if (playerId === localPlayerId) {
      localReady = ready;
    } else {
      const previous = opponents.get(playerId);
      opponents.set(playerId, { connected: previous?.connected ?? true, ready });
    }
    view.log(`${playerId} is ${ready ? "ready" : "not ready"}`);
  });
  nextClient.on("start", handleStart);
  nextClient.on("interaction", handleInteraction);
  nextClient.on("progress", (message) => {
    if (message.playerId === localPlayerId) return;
    const parsed = parseProgress(message.payload);
    if (parsed === undefined) {
      view.log(`Ignored malformed progress from ${message.playerId}`);
      return;
    }
    latestRemote = {
      playerId: message.playerId,
      progress: parsed,
      receivedAtLocalMs: monotonicNow(),
    };
  });
  nextClient.on("canonical", (event) => {
    view.log(`Accepted canonical ${event.kind} #${event.sequence}`);
  });
  nextClient.on("sequenceGap", ({ expectedSequence, receivedSequence }) => {
    view.log(`Sequence gap: expected ${expectedSequence}, received ${receivedSequence}`);
  });
  nextClient.on("timeSync", ({ estimate, uncertaintyMs }) => {
    latestUncertaintyMs = uncertaintyMs;
    view.renderDiagnostics({
      offsetMs: estimate.offsetMs,
      uncertaintyMs,
      roomEpoch: nextClient.roomEpoch,
      eventSequence: nextClient.lastEventSequence,
    });
  });
  nextClient.on("serverError", (error) => {
    view.log(`Server rejected a message: ${error.code} — ${error.message}`);
  });
  nextClient.on("error", ({ error, source }) => {
    view.log(`${source} error: ${error instanceof Error ? error.message : String(error)}`);
  });
}

view.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const values = view.readJoinForm();
    await client?.destroy();
    opponents.clear();
    latestRemote = undefined;
    localReady = false;
    localPlayerId = values.playerId;
    view.setLocalPlayer(values.playerId);
    const nextClient = new RelayPlayClient({
      url: values.serverUrl,
      roomId: values.roomId,
      playerId: values.playerId,
      token: DEVELOPMENT_TOKEN,
      config,
      resumeStore: new SessionStorageResumeStore({
        keyPrefix: `relayplay:live-race:${values.playerId}:`,
      }),
      reconnect: {
        enabled: true,
        maxAttempts: 8,
        initialDelayMs: 250,
        maxDelayMs: 4_000,
      },
      autoLifecycle: true,
    });
    client = nextClient;
    attachClientEvents(nextClient);
    nextClient.startProgress(progressPayload, { reportImmediately: true });

    const nextSearch = new URLSearchParams({
      room: values.roomId,
      player: values.playerId,
      server: values.serverUrl,
    });
    history.replaceState(null, "", `${location.pathname}?${nextSearch.toString()}`);
    view.setConnection("connecting", "Connecting");
    try {
      await nextClient.connect();
    } catch (error) {
      view.setConnection("error", "Connection failed");
      view.log(error instanceof Error ? error.message : String(error));
    }
  })();
});

view.readyButton.addEventListener("click", () => {
  localReady = !localReady;
  client?.setReady(localReady);
  view.readyButton.textContent = localReady ? "Cancel ready" : "Ready";
});

function sprint(): void {
  if (game.sprint(monotonicNow())) {
    view.renderLocal(game.snapshot());
  }
}

view.tapButton.addEventListener("click", (event) => {
  event.preventDefault();
  sprint();
});

window.addEventListener("keydown", (event) => {
  if (
    event.code === "Space" &&
    !event.repeat &&
    !(event.target instanceof HTMLInputElement) &&
    !(event.target instanceof HTMLTextAreaElement)
  ) {
    event.preventDefault();
    sprint();
  }
});

view.freezeButton.addEventListener("click", () => {
  const targetPlayerId = firstConnectedOpponent();
  if (client === undefined || targetPlayerId === undefined) return;
  try {
    client.sendInteraction({
      action: "freeze",
      targetPlayerId,
      payload: { durationMs: FREEZE_DURATION_MS },
    });
    freezeCooldownUntilMs = monotonicNow() + FREEZE_COOLDOWN_MS;
    view.log(`Sent freeze intent for ${targetPlayerId}; awaiting server order`);
  } catch (error) {
    view.log(error instanceof Error ? error.message : String(error));
  }
});

view.disconnectButton.addEventListener("click", () => {
  const reconnectingClient = client;
  if (reconnectingClient === undefined) return;
  void (async () => {
    view.log("Closing the socket, then resuming with stored epoch/sequence");
    await reconnectingClient.disconnect({ code: 4000, reason: "example resume test" });
    window.setTimeout(() => {
      void reconnectingClient.connect().catch((error: unknown) => {
        view.log(error instanceof Error ? error.message : String(error));
      });
    }, 500);
  })();
});

function renderFrame(): void {
  const now = monotonicNow();
  game.advance(now);
  const snapshot = game.snapshot();
  view.renderLocal(snapshot);
  view.showFreeze(game.freezeUntilLocalMs - now);

  if (latestRemote !== undefined) {
    view.renderRemote(
      latestRemote.playerId,
      latestRemote.progress,
      now - latestRemote.receivedAtLocalMs,
    );
  }

  if (snapshot.phase === "countdown" && startsAtLocalMs !== undefined) {
    view.setCountdown(`Starts in ${Math.max(0, (startsAtLocalMs - now) / 1_000).toFixed(1)}s`);
  } else if (snapshot.phase === "running") {
    view.setCountdown("Race live");
  } else if (snapshot.phase === "finished") {
    view.setCountdown("Finished!");
  } else {
    view.setCountdown(client?.connected ? "Both players must be ready" : "Join a room");
  }

  const target = firstConnectedOpponent();
  const cooldownMs = Math.max(0, freezeCooldownUntilMs - now);
  const frozen = now < game.freezeUntilLocalMs;
  view.setControls({
    canReady: client?.connected === true && snapshot.phase === "lobby",
    canSprint: snapshot.phase === "running" && !frozen,
    canFreeze:
      client?.connected === true &&
      snapshot.phase === "running" &&
      target !== undefined &&
      cooldownMs === 0,
    freezeDetail:
      target === undefined
        ? "Needs a connected opponent"
        : cooldownMs > 0
          ? `Cooldown ${(cooldownMs / 1_000).toFixed(1)}s`
          : `Targets ${target}`,
  });

  if (snapshot.phase === "finished") {
    view.setHint(
      "Local finish reached. A ranked game would now upload deterministic evidence for verification.",
    );
  }
  view.renderDiagnostics({
    offsetMs: client?.clock.estimate?.offsetMs,
    uncertaintyMs: latestUncertaintyMs,
    roomEpoch: client?.roomEpoch,
    eventSequence: client?.lastEventSequence ?? 0,
  });
  requestAnimationFrame(renderFrame);
}

view.renderLocal(game.snapshot());
view.setConnection("idle", "Not connected");
requestAnimationFrame(renderFrame);
