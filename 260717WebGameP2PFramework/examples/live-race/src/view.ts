import type { LiveRaceProgress } from "./game.js";

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

  readonly #connectionStatus: HTMLElement;
  readonly #connectionLabel: HTMLElement;
  readonly #roomInput: HTMLInputElement;
  readonly #playerInput: HTMLInputElement;
  readonly #serverInput: HTMLInputElement;
  readonly #localName: HTMLElement;
  readonly #localScore: HTMLElement;
  readonly #localProgress: HTMLElement;
  readonly #localRunner: HTMLElement;
  readonly #localPercent: HTMLElement;
  readonly #localCombo: HTMLElement;
  readonly #remoteName: HTMLElement;
  readonly #remoteScore: HTMLElement;
  readonly #remoteProgress: HTMLElement;
  readonly #remoteRunner: HTMLElement;
  readonly #remotePercent: HTMLElement;
  readonly #remoteFreshness: HTMLElement;
  readonly #countdown: HTMLElement;
  readonly #freezeDetail: HTMLElement;
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
    this.#connectionStatus = requiredElement(document, "connection-status");
    this.#connectionLabel = requiredElement(document, "connection-label");
    this.#roomInput = requiredElement(document, "room-id");
    this.#playerInput = requiredElement(document, "player-id");
    this.#serverInput = requiredElement(document, "server-url");
    this.#localName = requiredElement(document, "local-name");
    this.#localScore = requiredElement(document, "local-score");
    this.#localProgress = requiredElement(document, "local-progress");
    this.#localRunner = requiredElement(document, "local-runner");
    this.#localPercent = requiredElement(document, "local-percent");
    this.#localCombo = requiredElement(document, "local-combo");
    this.#remoteName = requiredElement(document, "remote-name");
    this.#remoteScore = requiredElement(document, "remote-score");
    this.#remoteProgress = requiredElement(document, "remote-progress");
    this.#remoteRunner = requiredElement(document, "remote-runner");
    this.#remotePercent = requiredElement(document, "remote-percent");
    this.#remoteFreshness = requiredElement(document, "remote-freshness");
    this.#countdown = requiredElement(document, "countdown");
    this.#freezeDetail = requiredElement(document, "freeze-detail");
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

  renderRemote(playerId: string, progress: LiveRaceProgress, ageMs: number): void {
    const formatted = percent(progress.normalizedProgress);
    this.#remoteName.textContent = playerId;
    this.#remoteScore.textContent = String(progress.score);
    this.#remoteProgress.style.width = formatted;
    this.#remoteRunner.style.left = formatted;
    this.#remotePercent.textContent = formatted;
    this.#remoteFreshness.textContent = `${Math.max(0, ageMs / 1_000).toFixed(1)}s`;
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
}
