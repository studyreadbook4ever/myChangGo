#!/usr/bin/env node
import { nodeServerOptionsFromEnv } from "./env.js";
import { createRelayPlayNodeServer, installGracefulShutdown } from "./node-server.js";

async function main(): Promise<void> {
  const server = createRelayPlayNodeServer(nodeServerOptionsFromEnv());
  const uninstallShutdown = installGracefulShutdown(server);
  try {
    await server.start();
  } catch (error) {
    uninstallShutdown();
    await server.stop().catch(() => undefined);
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "RelayPlay failed to start");
  process.exitCode = 1;
});
