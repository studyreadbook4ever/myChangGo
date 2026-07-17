import {
  createRelayPlayDurableObject,
  createWorker,
  type RelayPlayCloudflareEnv,
} from "@relayplay/cloudflare";
import { createPresetConfig, isPlainObject } from "@relayplay/core";

interface ExampleEnv extends RelayPlayCloudflareEnv {
  readonly RELAYPLAY_INSECURE_DEV_TOKEN: string;
}

const config = createPresetConfig("soft-battle", "universal", {
  room: {
    maxPlayers: 2,
  },
  progress: {
    intervalMs: 1_000,
  },
  features: {
    verification: {
      interactionClaims: true,
    },
  },
  security: {
    rateLimits: {
      actions: {
        freeze: {
          capacity: 1,
          refillPerSecond: 0.125,
        },
      },
    },
  },
});

/**
 * Local demonstration room. The fixed token is deliberately insecure and is
 * confined to wrangler's local configuration. Replace this class in production.
 */
export class GameRoom extends createRelayPlayDurableObject<ExampleEnv>({
  config,
  minimumPlayersToStart: 2,
  authenticate: (request, env) => {
    if (
      request.credential !== env.RELAYPLAY_INSECURE_DEV_TOKEN ||
      request.requestedPlayerId === undefined
    ) {
      throw new Error("invalid local demonstration credential");
    }
    return {
      playerId: request.requestedPlayerId,
      ...(request.requestedSessionId === undefined
        ? {}
        : { sessionId: request.requestedSessionId }),
      roles: ["player"],
    };
  },
  validateInteraction: (command, context) => {
    if (command.action !== "freeze") {
      return { accepted: false, code: "UNKNOWN_ACTION", message: "unsupported action" };
    }
    if (context.target === undefined) {
      return { accepted: false, code: "TARGET_REQUIRED", message: "freeze needs a target" };
    }
    if (!isPlainObject(command.payload)) {
      return { accepted: false, code: "INVALID_PAYLOAD", message: "freeze payload must be an object" };
    }
    const durationMs = command.payload.durationMs;
    if (
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 500 ||
      durationMs > 2_000
    ) {
      return {
        accepted: false,
        code: "INVALID_DURATION",
        message: "freeze duration must be an integer from 500 to 2000 ms",
      };
    }
    return {
      accepted: true,
      payload: { durationMs },
      effectiveAt: {
        kind: "server-time",
        serverTimeMs: context.now + 750,
      },
    };
  },
}) {}

export default createWorker<ExampleEnv>({ binding: "ROOMS" });
