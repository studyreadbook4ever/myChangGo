import {
  RelayPlayClient,
  SessionStorageResumeStore,
  type RelayPlayClientState,
} from "@relayplay/client";
import {
  isPlainObject,
  type CanonicalEvent,
  type JsonValue,
  type RoomStatus,
} from "@relayplay/core";

import {
  FREEZE_COOLDOWN_MS,
  FREEZE_DURATION_MS,
  FREEZE_MAX_DURATION_MS,
  FREEZE_MIN_DURATION_MS,
  LATE_BOUNDARY_MS,
  LIVE_RACE_CONFIG,
  LIVE_RACE_FINISH_SCORE,
  LIVE_RACE_MAX_OPPONENTS,
  LIVE_RACE_MINIMUM_PLAYERS_TO_START,
} from "./config.js";
import { LiveRaceGame, type GamePhase, type LiveRaceProgress } from "./game.js";
import {
  createGuestRoom,
  GuestControlPlaneError,
  joinGuestRoom,
  validGuestInvite,
  type GuestRoomSession,
} from "./guest-control-plane.js";
import {
  createBoundedFinishResult,
  finishPlacement,
  FinishPlacements,
  OpponentRoster,
  RoundFinishGate,
} from "./race-session.js";
import {
  LiveRaceView,
  type ConnectionViewState,
  type JoinFormValue,
} from "./view.js";

const CONFIGURED_DEVELOPMENT_TOKEN = import.meta.env.VITE_RELAYPLAY_DEV_TOKEN;
const LOCAL_DEVELOPMENT_TOKEN = "relayplay-local-only";
const DEFAULT_GAME_HINT =
  "Progress is reported once per second. Your local button never waits for the network.";

const view = new LiveRaceView(document);
let game = new LiveRaceGame(LIVE_RACE_FINISH_SCORE);
const opponents = new OpponentRoster(LIVE_RACE_MAX_OPPONENTS);
const finishGate = new RoundFinishGate();
const finishPlacements = new FinishPlacements();

let client: RelayPlayClient | undefined;
let localPlayerId = "";
let localReady = false;
let localCanonicalPlacement: number | undefined;
let startsAtLocalMs: number | undefined;
let freezeCooldownUntilMs = 0;
let latestUncertaintyMs: number | undefined;
let nextOpponentRenderAtMs = 0;
let roomStatus: RoomStatus | undefined;
let createdInvite: string | undefined;
let guestOperationActive = false;

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

function developmentToken(serverUrl: string): string | undefined {
  if (
    typeof CONFIGURED_DEVELOPMENT_TOKEN === "string" &&
    CONFIGURED_DEVELOPMENT_TOKEN.length > 0
  ) {
    return CONFIGURED_DEVELOPMENT_TOKEN;
  }
  try {
    const endpoint = new URL(
      serverUrl.replaceAll("{roomId}", "demo-room"),
      location.href,
    );
    const loopback =
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "[::1]";
    return loopback && endpoint.port === "8787"
      ? LOCAL_DEVELOPMENT_TOKEN
      : undefined;
  } catch {
    return undefined;
  }
}

const search = new URLSearchParams(location.search);
view.setDefaults({
  roomId: search.get("room") ?? "demo-room",
  playerId: search.get("player") ?? generatedPlayerId(),
  serverUrl: search.get("server") ?? defaultEndpoint(),
});
const fragmentInvite = new URLSearchParams(location.hash.slice(1)).get("invite");
if (fragmentInvite !== null && validGuestInvite(fragmentInvite)) {
  view.setInvite(fragmentInvite);
}
view.showCreatedInvite();

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
    score > LIVE_RACE_FINISH_SCORE ||
    typeof normalizedProgress !== "number" ||
    !Number.isFinite(normalizedProgress) ||
    normalizedProgress < 0 ||
    normalizedProgress > 1 ||
    typeof combo !== "number" ||
    !Number.isSafeInteger(combo) ||
    combo < 0 ||
    combo > LIVE_RACE_FINISH_SCORE ||
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
  return opponents.firstConnectedPlayerId();
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

function scheduleLocalRound(localTime: number): void {
  finishGate.reset();
  finishPlacements.clear();
  opponents.resetPlacements();
  localCanonicalPlacement = undefined;
  view.setLocalPlacement(undefined);
  view.setFinishStatus();
  view.setHint(DEFAULT_GAME_HINT);
  startsAtLocalMs = localTime;
  roomStatus = "scheduled";
  game.scheduleStart(localTime);
}

function handleStart(event: CanonicalEvent): void {
  const localTime = effectiveLocalTime(event);
  if (localTime === undefined) {
    view.log("Rejected start without a server-time schedule");
    return;
  }
  scheduleLocalRound(localTime);
  view.log(`Canonical start #${event.sequence} scheduled`);
}

function handleFinish(event: CanonicalEvent): void {
  const playerId = event.playerId;
  if (playerId === undefined) {
    view.log(`Ignored finish #${event.sequence} without a player`);
    return;
  }
  const disconnected =
    isPlainObject(event.payload) && event.payload.reason === "disconnect-timeout";
  const placement = finishPlacements.record(playerId, finishPlacement(event.payload));
  if (playerId === localPlayerId) {
    localCanonicalPlacement = placement;
    view.setLocalPlacement(placement);
    view.setFinishStatus(
      disconnected
        ? `Server-confirmed disconnect: place #${String(placement)}`
        : `Server-confirmed finish: place #${String(placement)}`,
    );
    view.log(`Your result is canonical at place #${String(placement)}`);
  } else {
    if (!disconnected) opponents.markFinished(playerId, monotonicNow());
    opponents.setPlacement(playerId, placement);
    nextOpponentRenderAtMs = 0;
    view.log(
      `${playerId} ${disconnected ? "left the race" : "finished"} at place #${String(placement)}`,
    );
  }
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
    durationMs < FREEZE_MIN_DURATION_MS ||
    durationMs > FREEZE_MAX_DURATION_MS ||
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
  nextClient.on("snapshot", (message) => {
    roomStatus = message.status;
    const selfPlayerId = nextClient.playerId ?? localPlayerId;
    opponents.reconcilePresence(
      message.players.filter(({ playerId }) => playerId !== selfPlayerId),
    );
    nextOpponentRenderAtMs = 0;
    const localPlayer = message.players.find(({ playerId }) => playerId === selfPlayerId);
    if (localPlayer !== undefined) {
      localReady = localPlayer.ready;
      view.readyButton.textContent = localReady ? "Cancel ready" : "Ready";
    }
    if (
      game.phase === "lobby" &&
      message.startAt !== undefined &&
      (message.status === "scheduled" || message.status === "running")
    ) {
      const localStart = nextClient.clock.toLocalTime(message.startAt);
      scheduleLocalRound(localStart);
      game.advance(monotonicNow());
      view.log("Restored the synchronized start from the room snapshot");
    }
    view.log(
      `Room snapshot: ${String(message.players.length)} player(s), ${message.status}`,
    );
  });
  nextClient.on("presence", ({ playerId, connected, ready }) => {
    if (playerId === localPlayerId) {
      localReady = ready;
      view.readyButton.textContent = localReady ? "Cancel ready" : "Ready";
      return;
    }
    opponents.updatePresence(playerId, connected, ready);
    nextOpponentRenderAtMs = 0;
    view.log(`${playerId} is ${connected ? "online" : "offline"}`);
  });
  nextClient.on("ready", ({ playerId, ready }) => {
    if (playerId === localPlayerId) {
      localReady = ready;
    } else {
      opponents.updateReady(playerId, ready);
      nextOpponentRenderAtMs = 0;
    }
    if (playerId === localPlayerId) {
      view.readyButton.textContent = localReady ? "Cancel ready" : "Ready";
    }
    view.log(`${playerId} is ${ready ? "ready" : "not ready"}`);
  });
  nextClient.on("start", handleStart);
  nextClient.on("interaction", handleInteraction);
  nextClient.on("finish", handleFinish);
  nextClient.on("progress", (message) => {
    if (message.playerId === localPlayerId) return;
    const parsed = parseProgress(message.payload);
    if (parsed === undefined) {
      view.log(`Ignored malformed progress from ${message.playerId}`);
      return;
    }
    opponents.updateProgress(message.playerId, parsed, monotonicNow());
    nextOpponentRenderAtMs = 0;
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

async function connectToRoom(
  values: JoinFormValue,
  authentication: "auto" | "cookie" = "auto",
): Promise<boolean> {
  await client?.destroy();
  game = new LiveRaceGame(LIVE_RACE_FINISH_SCORE);
  opponents.clear();
  view.clearOpponents();
  finishGate.reset();
  finishPlacements.clear();
  localReady = false;
  localCanonicalPlacement = undefined;
  startsAtLocalMs = undefined;
  freezeCooldownUntilMs = 0;
  nextOpponentRenderAtMs = 0;
  roomStatus = undefined;
  localPlayerId = values.playerId;
  view.setRoomConnection(values);
  view.setLocalPlacement(undefined);
  view.readyButton.textContent = "Ready";
  view.setFinishStatus();
  view.setHint(DEFAULT_GAME_HINT);
  const token = authentication === "auto" ? developmentToken(values.serverUrl) : undefined;
  const nextClient = new RelayPlayClient({
    url: values.serverUrl,
    roomId: values.roomId,
    playerId: values.playerId,
    ...(token === undefined ? {} : { token }),
    config: LIVE_RACE_CONFIG,
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
    return true;
  } catch (error) {
    view.setConnection("error", "Connection failed");
    view.log(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function guestErrorCode(error: unknown): string {
  return error instanceof GuestControlPlaneError ? error.code : "request_failed";
}

async function connectGuestSession(session: GuestRoomSession): Promise<boolean> {
  return connectToRoom(
    {
      roomId: session.roomId,
      playerId: session.playerId,
      serverUrl: session.serverUrl,
    },
    "cookie",
  );
}

view.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void connectToRoom(view.readJoinForm());
});

view.createRoomButton.addEventListener("click", () => {
  if (guestOperationActive) return;
  void (async () => {
    guestOperationActive = true;
    view.setGuestBusy(true);
    createdInvite = undefined;
    view.showCreatedInvite();
    view.setGuestStatus("Creating an accountless room…");
    try {
      const session = await createGuestRoom(view.readJoinForm().serverUrl);
      createdInvite = session.invite;
      view.showCreatedInvite(createdInvite);
      view.setGuestStatus("Room created; connecting with the HttpOnly guest cookie…");
      const connected = await connectGuestSession(session);
      view.setGuestStatus(
        connected
          ? "Room created and connected. Copy the invite for up to three guests."
          : "Room created, but the WebSocket connection failed.",
      );
    } catch (error) {
      const code = guestErrorCode(error);
      view.setGuestStatus(`Could not create room: ${code}`);
      view.log(`Guest room creation failed: ${code}`);
    } finally {
      guestOperationActive = false;
      view.setGuestBusy(false);
    }
  })();
});

view.joinInviteButton.addEventListener("click", () => {
  if (guestOperationActive) return;
  void (async () => {
    guestOperationActive = true;
    view.setGuestBusy(true);
    view.setGuestStatus("Joining the accountless room…");
    try {
      const session = await joinGuestRoom(
        view.readJoinForm().serverUrl,
        view.readInvite(),
      );
      createdInvite = undefined;
      view.showCreatedInvite();
      view.setInvite("");
      const connected = await connectGuestSession(session);
      view.setGuestStatus(
        connected
          ? "Joined and connected with the HttpOnly guest cookie."
          : "Joined the room, but the WebSocket connection failed.",
      );
    } catch (error) {
      const code = guestErrorCode(error);
      view.setGuestStatus(`Could not join room: ${code}`);
      view.log(`Guest room join failed: ${code}`);
    } finally {
      guestOperationActive = false;
      view.setGuestBusy(false);
    }
  })();
});

view.copyInviteButton.addEventListener("click", () => {
  void (async () => {
    if (createdInvite === undefined || navigator.clipboard === undefined) {
      view.setGuestStatus("Clipboard access is unavailable; select the visible invite manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(createdInvite);
      view.setGuestStatus("Invite copied. Share it out of band.");
    } catch {
      view.setGuestStatus("Copy failed; select the visible invite manually.");
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
  if (now >= nextOpponentRenderAtMs) {
    view.renderOpponents(opponents.values(), now);
    nextOpponentRenderAtMs = now + LATE_BOUNDARY_MS;
  }

  if (snapshot.phase === "countdown" && startsAtLocalMs !== undefined) {
    view.setCountdown(`Starts in ${Math.max(0, (startsAtLocalMs - now) / 1_000).toFixed(1)}s`);
  } else if (snapshot.phase === "running") {
    roomStatus = "running";
    view.setCountdown("Race live");
  } else if (snapshot.phase === "finished") {
    view.setCountdown("Finished!");
  } else {
    view.setCountdown(
      roomStatus === "finished"
        ? "Race finished"
        : client?.connected
        ? `At least ${String(LIVE_RACE_MINIMUM_PLAYERS_TO_START)} players; everyone connected must be ready`
        : "Join a room",
    );
  }

  const target = firstConnectedOpponent();
  const cooldownMs = Math.max(0, freezeCooldownUntilMs - now);
  const frozen = now < game.freezeUntilLocalMs;
  view.setControls({
    canReady:
      client?.connected === true &&
      snapshot.phase === "lobby" &&
      roomStatus === "waiting",
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
    const finishingClient = client;
    if (finishingClient?.connected === true && !finishGate.submitted) {
      try {
        finishGate.runOnce(() => {
          const idempotencyKey = finishingClient.finish(
            createBoundedFinishResult(snapshot, startsAtLocalMs, now),
          );
          finishingClient.stopProgress();
          view.setFinishStatus("Finish submitted; awaiting canonical placement…");
          view.log(`Submitted finish ${idempotencyKey}`);
        });
      } catch (error) {
        view.log(
          `Finish submission will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    view.setHint(
      localCanonicalPlacement === undefined
        ? "Local finish reached. Waiting for the server's canonical finish event."
        : `Server-confirmed result: place #${String(localCanonicalPlacement)}.`,
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
