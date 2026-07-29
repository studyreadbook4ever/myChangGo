import type { LiveRaceProgress } from "./game.js";
import type { OpponentState } from "./race-session.js";

export type ConnectionViewState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface JoinFormValue {
  readonly roomId: string;
  readonly playerId: string;
  readonly serverUrl: string;
}

export interface NetworkDiagnostics {
  readonly offsetMs: number | undefined;
  readonly uncertaintyMs: number | undefined;
  readonly roomEpoch: number | undefined;
  readonly eventSequence: number;
}

interface OpponentElements {
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly status: HTMLElement;
  readonly score: HTMLElement;
  readonly progress: HTMLElement;
  readonly runner: HTMLElement;
  readonly percent: HTMLElement;
  readonly freshness: HTMLElement;
  readonly placement: HTMLElement;
}

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Example markup is missing #${id}`);
  }
  return element as T;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export class LiveRaceView {
  readonly joinForm: HTMLFormElement;
  readonly readyButton: HTMLButtonElement;
  readonly tapButton: HTMLButtonElement;
  readonly freezeButton: HTMLButtonElement;
  readonly disconnectButton: HTMLButtonElement;
  readonly createRoomButton: HTMLButtonElement;
  readonly joinInviteButton: HTMLButtonElement;
  readonly copyInviteButton: HTMLButtonElement;

  readonly #connectionStatus: HTMLElement;
  readonly #connectionLabel: HTMLElement;
  readonly #roomInput: HTMLInputElement;
  readonly #playerInput: HTMLInputElement;
  readonly #serverInput: HTMLInputElement;
  readonly #inviteInput: HTMLInputElement;
  readonly #inviteResult: HTMLElement;
  readonly #createdInvite: HTMLElement;
  readonly #guestStatus: HTMLOutputElement;
  readonly #localName: HTMLElement;
  readonly #localScore: HTMLElement;
  readonly #localProgress: HTMLElement;
  readonly #localRunner: HTMLElement;
  readonly #localPercent: HTMLElement;
  readonly #localCombo: HTMLElement;
  readonly #localPlacement: HTMLElement;
  readonly #opponentList: HTMLElement;
  readonly #opponentEmpty: HTMLElement;
  readonly #opponentRows = new Map<string, OpponentElements>();
  readonly #countdown: HTMLElement;
  readonly #freezeDetail: HTMLElement;
  readonly #finishStatus: HTMLElement;
  readonly #gameHint: HTMLElement;
  readonly #clockOffset: HTMLElement;
  readonly #clockUncertainty: HTMLElement;
  readonly #roomEpoch: HTMLElement;
  readonly #eventSequence: HTMLElement;
  readonly #eventLog: HTMLOListElement;
  readonly #freezeOverlay: HTMLElement;
  readonly #freezeCountdown: HTMLElement;

  constructor(document: Document) {
    this.joinForm = requiredElement(document, "join-form");
    this.readyButton = requiredElement(document, "ready-button");
    this.tapButton = requiredElement(document, "tap-button");
    this.freezeButton = requiredElement(document, "freeze-button");
    this.disconnectButton = requiredElement(document, "disconnect-button");
    this.createRoomButton = requiredElement(document, "create-room-button");
    this.joinInviteButton = requiredElement(document, "join-invite-button");
    this.copyInviteButton = requiredElement(document, "copy-invite-button");
    this.#connectionStatus = requiredElement(document, "connection-status");
    this.#connectionLabel = requiredElement(document, "connection-label");
    this.#roomInput = requiredElement(document, "room-id");
    this.#playerInput = requiredElement(document, "player-id");
    this.#serverInput = requiredElement(document, "server-url");
    this.#inviteInput = requiredElement(document, "invite-code");
    this.#inviteResult = requiredElement(document, "invite-result");
    this.#createdInvite = requiredElement(document, "created-invite");
    this.#guestStatus = requiredElement(document, "guest-status");
    this.#localName = requiredElement(document, "local-name");
    this.#localScore = requiredElement(document, "local-score");
    this.#localProgress = requiredElement(document, "local-progress");
    this.#localRunner = requiredElement(document, "local-runner");
    this.#localPercent = requiredElement(document, "local-percent");
    this.#localCombo = requiredElement(document, "local-combo");
    this.#localPlacement = requiredElement(document, "local-placement");
    this.#opponentList = requiredElement(document, "opponent-list");
    this.#opponentEmpty = requiredElement(document, "opponent-empty");
    this.#countdown = requiredElement(document, "countdown");
    this.#freezeDetail = requiredElement(document, "freeze-detail");
    this.#finishStatus = requiredElement(document, "finish-status");
    this.#gameHint = requiredElement(document, "game-hint");
    this.#clockOffset = requiredElement(document, "clock-offset");
    this.#clockUncertainty = requiredElement(document, "clock-uncertainty");
    this.#roomEpoch = requiredElement(document, "room-epoch");
    this.#eventSequence = requiredElement(document, "event-sequence");
    this.#eventLog = requiredElement(document, "event-log");
    this.#freezeOverlay = requiredElement(document, "freeze-overlay");
    this.#freezeCountdown = requiredElement(document, "freeze-countdown");
  }

  setDefaults(values: JoinFormValue): void {
    this.#roomInput.value = values.roomId;
    this.#playerInput.value = values.playerId;
    this.#serverInput.value = values.serverUrl;
  }

  readJoinForm(): JoinFormValue {
    return {
      roomId: this.#roomInput.value.trim(),
      playerId: this.#playerInput.value.trim(),
      serverUrl: this.#serverInput.value.trim(),
    };
  }

  readInvite(): string {
    return this.#inviteInput.value.trim();
  }

  setInvite(invite: string): void {
    this.#inviteInput.value = invite;
  }

  setRoomConnection(values: JoinFormValue): void {
    this.setDefaults(values);
    this.setLocalPlayer(values.playerId);
  }

  setGuestBusy(busy: boolean): void {
    this.createRoomButton.disabled = busy;
    this.joinInviteButton.disabled = busy;
    this.#inviteInput.disabled = busy;
  }

  showCreatedInvite(invite?: string): void {
    this.#inviteResult.hidden = invite === undefined;
    this.#createdInvite.textContent = invite ?? "";
    this.copyInviteButton.disabled = invite === undefined;
  }

  setGuestStatus(message: string): void {
    this.#guestStatus.textContent = message;
  }

  setConnection(state: ConnectionViewState, label: string): void {
    this.#connectionStatus.dataset.state = state;
    this.#connectionLabel.textContent = label;
    this.disconnectButton.disabled = state !== "connected";
  }

  setLocalPlayer(playerId: string): void {
    this.#localName.textContent = playerId;
  }

  renderLocal(progress: LiveRaceProgress): void {
    const formatted = percent(progress.normalizedProgress);
    this.#localScore.textContent = String(progress.score);
    this.#localProgress.style.width = formatted;
    this.#localRunner.style.left = formatted;
    this.#localPercent.textContent = formatted;
    this.#localCombo.textContent = String(progress.combo);
  }

  setLocalPlacement(placement: number | undefined): void {
    this.#localPlacement.textContent = placement === undefined ? "—" : `#${String(placement)}`;
  }

  clearOpponents(): void {
    for (const row of this.#opponentRows.values()) row.root.remove();
    this.#opponentRows.clear();
    this.#opponentEmpty.hidden = false;
  }

  renderOpponents(opponents: readonly OpponentState[], localNowMs: number): void {
    const present = new Set(opponents.map(({ playerId }) => playerId));
    for (const [playerId, row] of this.#opponentRows) {
      if (present.has(playerId)) continue;
      row.root.remove();
      this.#opponentRows.delete(playerId);
    }

    const orderedRows: OpponentElements[] = [];
    for (const opponent of opponents) {
      const row = this.#opponentRows.get(opponent.playerId) ?? this.#createOpponentRow();
      this.#opponentRows.set(opponent.playerId, row);
      orderedRows.push(row);
      const progress = opponent.progress;
      const formatted = percent(progress?.normalizedProgress ?? 0);
      row.name.textContent = opponent.playerId;
      row.status.textContent = `${opponent.connected ? "Online" : "Offline"} · ${opponent.ready ? "Ready" : "Not ready"}`;
      row.score.textContent = String(progress?.score ?? 0);
      row.progress.style.width = formatted;
      row.runner.style.left = formatted;
      row.percent.textContent = formatted;
      row.freshness.textContent =
        opponent.receivedAtLocalMs === undefined
          ? "—"
          : `${Math.max(0, (localNowMs - opponent.receivedAtLocalMs) / 1_000).toFixed(1)}s`;
      row.placement.textContent =
        opponent.placement === undefined ? "—" : `#${String(opponent.placement)}`;
      row.root.dataset.connected = String(opponent.connected);
    }
    const renderedRows = [...this.#opponentList.children].filter(
      (element) => element !== this.#opponentEmpty,
    );
    const orderChanged = orderedRows.some(
      ({ root }, index) => renderedRows[index] !== root,
    );
    if (orderChanged || renderedRows.length !== orderedRows.length) {
      for (const { root } of orderedRows) this.#opponentList.append(root);
    }
    this.#opponentEmpty.hidden = opponents.length > 0;
  }

  setCountdown(label: string): void {
    this.#countdown.textContent = label;
  }

  setControls(options: {
    readonly canReady: boolean;
    readonly canSprint: boolean;
    readonly canFreeze: boolean;
    readonly freezeDetail: string;
  }): void {
    this.readyButton.disabled = !options.canReady;
    this.tapButton.disabled = !options.canSprint;
    this.freezeButton.disabled = !options.canFreeze;
    this.#freezeDetail.textContent = options.freezeDetail;
  }

  setHint(text: string): void {
    this.#gameHint.textContent = text;
  }

  setFinishStatus(text?: string): void {
    this.#finishStatus.hidden = text === undefined;
    this.#finishStatus.textContent = text ?? "";
  }

  showFreeze(remainingMs: number): void {
    const active = remainingMs > 0;
    this.#freezeOverlay.hidden = !active;
    this.#freezeCountdown.textContent = `${Math.max(0, remainingMs / 1_000).toFixed(1)}s`;
  }

  renderDiagnostics(diagnostics: NetworkDiagnostics): void {
    this.#clockOffset.textContent =
      diagnostics.offsetMs === undefined ? "—" : `${diagnostics.offsetMs.toFixed(1)}ms`;
    this.#clockUncertainty.textContent =
      diagnostics.uncertaintyMs === undefined
        ? "—"
        : `${diagnostics.uncertaintyMs.toFixed(1)}ms`;
    this.#roomEpoch.textContent = diagnostics.roomEpoch?.toString() ?? "—";
    this.#eventSequence.textContent = diagnostics.eventSequence.toString();
  }

  log(message: string, at = new Date()): void {
    const entry = this.#eventLog.ownerDocument.createElement("li");
    entry.textContent = `${at.toLocaleTimeString()}  ${message}`;
    this.#eventLog.prepend(entry);
    while (this.#eventLog.childElementCount > 24) {
      this.#eventLog.lastElementChild?.remove();
    }
  }

  #createOpponentRow(): OpponentElements {
    const document = this.#opponentList.ownerDocument;
    const root = document.createElement("article");
    root.className = "panel racer remote-racer";

    const heading = document.createElement("div");
    heading.className = "racer-heading";
    const identity = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Opponent";
    const name = document.createElement("h3");
    const status = document.createElement("small");
    status.className = "opponent-status";
    identity.append(eyebrow, name, status);
    const score = document.createElement("strong");
    heading.append(identity, score);

    const track = document.createElement("div");
    track.className = "track";
    track.setAttribute("aria-label", "Opponent progress");
    const progress = document.createElement("div");
    progress.className = "track-fill remote-fill";
    const runner = document.createElement("span");
    runner.className = "runner remote";
    runner.setAttribute("aria-hidden", "true");
    runner.textContent = "●";
    track.append(progress, runner);

    const metrics = document.createElement("div");
    metrics.className = "metrics";
    const distanceLabel = document.createElement("span");
    const percentValue = document.createElement("b");
    distanceLabel.append(percentValue, " distance");
    const freshnessLabel = document.createElement("span");
    const freshness = document.createElement("b");
    freshnessLabel.append(freshness, " update age");
    const placementLabel = document.createElement("span");
    const placement = document.createElement("b");
    placementLabel.append(placement, " place");
    metrics.append(distanceLabel, freshnessLabel, placementLabel);

    root.append(heading, track, metrics);
    return { root, name, status, score, progress, runner, percent: percentValue, freshness, placement };
  }
}
