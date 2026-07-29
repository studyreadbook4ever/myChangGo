export type MetricCounter =
  | "http_rejected"
  | "rooms_created"
  | "guests_joined"
  | "websocket_opened"
  | "websocket_rejected"
  | "frames_rejected"
  | "progress_dropped"
  | "slow_consumers";

/** Low-cardinality process counters; room/player/IP labels are intentionally absent. */
export class NodeMetrics {
  readonly #counters = new Map<MetricCounter, number>();

  public increment(counter: MetricCounter): void {
    this.#counters.set(counter, (this.#counters.get(counter) ?? 0) + 1);
  }

  public value(counter: MetricCounter): number {
    return this.#counters.get(counter) ?? 0;
  }

  public prometheus(activeConnections: number, ready: boolean): string {
    const lines = [
      "# HELP relayplay_ready Whether this process accepts new sessions.",
      "# TYPE relayplay_ready gauge",
      `relayplay_ready ${ready ? "1" : "0"}`,
      "# HELP relayplay_active_connections Current WebSocket connections.",
      "# TYPE relayplay_active_connections gauge",
      `relayplay_active_connections ${String(activeConnections)}`,
    ];
    for (const counter of [
      "http_rejected",
      "rooms_created",
      "guests_joined",
      "websocket_opened",
      "websocket_rejected",
      "frames_rejected",
      "progress_dropped",
      "slow_consumers",
    ] as const) {
      lines.push(`# TYPE relayplay_${counter}_total counter`);
      lines.push(`relayplay_${counter}_total ${String(this.value(counter))}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
