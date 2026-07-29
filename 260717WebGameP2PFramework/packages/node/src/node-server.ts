import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RoomEngine } from "@relayplay/server";

import { AnonymousRoomService } from "./anonymous-rooms.js";
import { NodeRoomBroadcaster } from "./broadcaster.js";
import { RelayPlaySqliteDatabase } from "./database.js";
import { HttpControlPlane } from "./http-control-plane.js";
import { NodeMetrics } from "./metrics.js";
import {
  resolveNodeServerOptions,
  type RelayPlayNodeServerOptions,
  type ResolvedNodeServerOptions,
} from "./options.js";
import { RoomAlarmScheduler } from "./room-alarms.js";
import { SqliteRoomStorage } from "./sqlite-storage.js";
import { NodeWebSocketGateway } from "./websocket-gateway.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export interface RelayPlayNodeAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

/**
 * Composition root only. Policy, storage, auth, HTTP, WebSocket fanout, and
 * scheduling remain separate replaceable modules to avoid a maintenance-heavy
 * monolith even though the recommended deployment is one small process.
 */
export class RelayPlayNodeServer {
  readonly options: ResolvedNodeServerOptions;
  readonly database: RelayPlaySqliteDatabase;
  readonly storage: SqliteRoomStorage;
  readonly anonymousRooms: AnonymousRoomService;
  readonly broadcaster: NodeRoomBroadcaster;
  readonly engine: RoomEngine;
  readonly metrics: NodeMetrics;
  readonly alarms: RoomAlarmScheduler;
  readonly gateway: NodeWebSocketGateway;
  readonly http: Server;
  readonly #recoveredRooms: readonly string[];
  readonly #cleanupTimer: ReturnType<typeof setInterval>;
  readonly #httpRequests = new Set<Promise<void>>();
  #ready = false;
  #started = false;
  #stopped = false;
  #startPromise: Promise<RelayPlayNodeAddress> | undefined;
  #stopPromise: Promise<void> | undefined;

  public constructor(rawOptions: RelayPlayNodeServerOptions) {
    this.options = resolveNodeServerOptions(rawOptions);
    this.database = new RelayPlaySqliteDatabase({ path: this.options.databasePath });
    this.#recoveredRooms = this.database.reconcileOpenSessions();
    this.storage = new SqliteRoomStorage(this.database);
    this.anonymousRooms = new AnonymousRoomService(this.database, this.storage, {
      maxPlayers: this.options.config.room.maxPlayers,
      maxRooms: this.options.maxRooms,
      roomTtlMs: this.options.roomTtlMs,
      credentialTtlMs: this.options.credentialTtlMs,
    });
    this.metrics = new NodeMetrics();
    this.broadcaster = new NodeRoomBroadcaster({
      maxBufferedBytes: this.options.maxBufferedBytes,
      onProgressDropped: () => this.metrics.increment("progress_dropped"),
      onSlowConsumer: () => this.metrics.increment("slow_consumers"),
    });
    this.engine = new RoomEngine({
      storage: this.storage,
      broadcaster: this.broadcaster,
      authenticate: (request) => this.anonymousRooms.authenticateRoomRequest(request),
      config: this.options.config,
      minimumPlayersToStart: this.options.minimumPlayersToStart,
      replayBatchSize: this.options.replayBatchSize,
      ...(this.options.validateInteraction === undefined
        ? {}
        : { validateInteraction: this.options.validateInteraction }),
      ...(this.options.validateProgress === undefined
        ? {}
        : { validateProgress: this.options.validateProgress }),
      ...(this.options.validateFinish === undefined
        ? {}
        : { validateFinish: this.options.validateFinish }),
      ...(this.options.verifyReplay === undefined
        ? {}
        : { verifyReplay: this.options.verifyReplay }),
    });
    this.alarms = new RoomAlarmScheduler(this.engine, this.options.logger);
    this.gateway = new NodeWebSocketGateway({
      engine: this.engine,
      anonymousRooms: this.anonymousRooms,
      broadcaster: this.broadcaster,
      alarms: this.alarms,
      metrics: this.metrics,
      server: this.options,
      isReady: () => this.#ready,
    });
    const control = new HttpControlPlane({
      anonymousRooms: this.anonymousRooms,
      metrics: this.metrics,
      server: this.options,
      isReady: () => this.#ready,
      activeConnections: () => this.broadcaster.size,
      storageReady: () => this.database.ping(),
    });
    this.http = createServer(
      {
        requestTimeout: 10_000,
        headersTimeout: 5_000,
        keepAliveTimeout: 5_000,
        connectionsCheckingInterval: 1_000,
        maxHeaderSize: 8_192,
        requireHostHeader: true,
      },
      (request, response) => {
        const operation = control.handle(request, response).catch(() => {
          try {
            this.options.logger.error("http_request_failed");
            if (!response.headersSent) {
              response.statusCode = 500;
              response.end();
            } else {
              response.destroy();
            }
          } catch {
            response.destroy();
          }
        });
        this.#httpRequests.add(operation);
        void operation.then(() => this.#httpRequests.delete(operation));
      },
    );
    this.http.maxHeadersCount = 64;
    this.http.maxRequestsPerSocket = 100;
    this.http.on("upgrade", (request, socket, head) => {
      this.gateway.handleUpgrade(request, socket, head);
    });
    this.http.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    this.#cleanupTimer = setInterval(() => {
      try {
        this.database.cleanup(Date.now());
      } catch {
        this.options.logger.error("database_cleanup_failed");
      }
    }, 60 * 60 * 1_000);
    this.#cleanupTimer.unref();
  }

  public get ready(): boolean {
    return this.#ready;
  }

  public async start(): Promise<RelayPlayNodeAddress> {
    if (this.#stopped) throw new Error("RelayPlayNodeServer has been stopped");
    if (this.#started) return this.address();
    if (this.#startPromise !== undefined) return this.#startPromise;
    const starting = this.#startInternal();
    this.#startPromise = starting;
    try {
      return await starting;
    } catch (error) {
      if (!this.#stopped) await this.stop();
      throw error;
    } finally {
      if (this.#startPromise === starting) this.#startPromise = undefined;
    }
  }

  async #startInternal(): Promise<RelayPlayNodeAddress> {
    for (const roomId of this.#recoveredRooms) {
      if (this.#stopped) throw new Error("RelayPlayNodeServer stopped during startup");
      await this.alarms.schedule(roomId);
    }
    if (this.#stopped) throw new Error("RelayPlayNodeServer stopped during startup");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.http.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.http.off("error", onError);
        resolve();
      };
      this.http.once("error", onError);
      this.http.once("listening", onListening);
      this.http.listen(this.options.port, this.options.host);
    });
    this.#started = true;
    if (this.#stopped) throw new Error("RelayPlayNodeServer stopped during startup");
    this.#ready = true;
    const address = this.address();
    try {
      this.options.logger.info("server_started", { port: address.port });
    } catch {
      // Observability must not take down a healthy listener.
    }
    return address;
  }

  public address(): RelayPlayNodeAddress {
    const address = this.http.address();
    if (address === null || typeof address === "string") {
      throw new Error("RelayPlayNodeServer is not listening");
    }
    const info = address as AddressInfo;
    const displayHost = this.options.host === "0.0.0.0" || this.options.host === "::"
      ? "127.0.0.1"
      : this.options.host;
    return {
      host: info.address,
      port: info.port,
      origin: `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${String(info.port)}`,
    };
  }

  public stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    if (this.#stopped) return Promise.resolve();
    this.#stopped = true;
    this.#ready = false;
    const stopping = this.#stopInternal();
    this.#stopPromise = stopping;
    return stopping;
  }

  async #stopInternal(): Promise<void> {
    clearInterval(this.#cleanupTimer);
    this.gateway.close();
    const alarmDrain = this.alarms.stop();
    const starting = this.#startPromise;
    if (starting !== undefined) await starting.catch(() => undefined);

    let closed: Promise<void> | undefined;
    if (this.#started) {
      closed = new Promise<void>((resolve) => this.http.close(() => resolve()));
      this.broadcaster.closeAll(1012, "server restarting");
      await Promise.race([
        Promise.all([closed, this.gateway.waitForIdle()]),
        delay(this.options.shutdownGraceMs),
      ]);
      this.http.closeAllConnections();
    }
    await this.gateway.forceDisconnectAll();
    if (closed !== undefined) await closed;
    await alarmDrain;
    while (this.#httpRequests.size > 0) {
      await Promise.all(this.#httpRequests);
    }
    this.database.close();
    try {
      this.options.logger.info("server_stopped");
    } catch {
      // Resource shutdown has already completed.
    }
  }
}

export function createRelayPlayNodeServer(
  options: RelayPlayNodeServerOptions,
): RelayPlayNodeServer {
  return new RelayPlayNodeServer(options);
}

export function installGracefulShutdown(server: RelayPlayNodeServer): () => void {
  let stopping = false;
  const handle = (): void => {
    if (stopping) return;
    stopping = true;
    void server.stop().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  return () => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
}
