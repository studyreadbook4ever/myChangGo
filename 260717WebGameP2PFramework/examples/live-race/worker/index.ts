import {
  createRelayPlayDurableObject,
  createWorker,
  type RelayPlayCloudflareEnv,
} from "@relayplay/cloudflare";

import {
  LIVE_RACE_CONFIG,
  LIVE_RACE_MINIMUM_PLAYERS_TO_START,
} from "../src/config.js";
import {
  validateLiveRaceFinish,
  validateLiveRaceInteraction,
  validateLiveRaceProgress,
} from "../server/validators.js";

interface ExampleEnv extends RelayPlayCloudflareEnv {
  readonly RELAYPLAY_INSECURE_DEV_TOKEN: string;
}

/**
 * Local demonstration room. The fixed token is deliberately insecure and is
 * confined to wrangler's local configuration. Replace this class in production.
 */
export class GameRoom extends createRelayPlayDurableObject<ExampleEnv>({
  config: LIVE_RACE_CONFIG,
  minimumPlayersToStart: LIVE_RACE_MINIMUM_PLAYERS_TO_START,
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
  validateProgress: validateLiveRaceProgress,
  validateInteraction: validateLiveRaceInteraction,
  validateFinish: validateLiveRaceFinish,
}) {}

export default createWorker<ExampleEnv>({ binding: "ROOMS" });
