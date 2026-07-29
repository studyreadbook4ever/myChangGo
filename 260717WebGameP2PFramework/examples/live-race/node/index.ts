import {
  createRelayPlayNodeServer,
  installGracefulShutdown,
  nodeServerOptionsFromEnv,
} from "@relayplay/node";

import {
  validateLiveRaceFinish,
  validateLiveRaceInteraction,
  validateLiveRaceProgress,
} from "../server/validators.js";
import {
  LIVE_RACE_CONFIG,
  LIVE_RACE_MINIMUM_PLAYERS_TO_START,
} from "../src/config.js";

const environmentOptions = nodeServerOptionsFromEnv();
const server = createRelayPlayNodeServer({
  ...environmentOptions,
  config: LIVE_RACE_CONFIG,
  minimumPlayersToStart: LIVE_RACE_MINIMUM_PLAYERS_TO_START,
  validateProgress: validateLiveRaceProgress,
  validateInteraction: validateLiveRaceInteraction,
  validateFinish: validateLiveRaceFinish,
});

installGracefulShutdown(server);
server.start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "RelayPlay failed to start");
  process.exitCode = 1;
});
