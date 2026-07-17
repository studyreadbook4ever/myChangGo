#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateConfig } from "../packages/core/src/index.js";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run validate:config -- [path] [--print-normalized]\n" +
        "Default path: relayplay.config.json\n",
    );
    return;
  }

  const printNormalized = args.includes("--print-normalized");
  const positionals = args.filter((argument) => !argument.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error("provide at most one configuration path");
  }
  const path = resolve(process.cwd(), positionals[0] ?? "relayplay.config.json");
  const source = await readFile(path);
  if (source.byteLength > MAX_CONFIG_BYTES) {
    throw new Error(`configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = validateConfig(parsed);
  if (!result.success) {
    process.stderr.write(`Invalid RelayPlay configuration: ${path}\n`);
    for (const problem of result.issues) {
      process.stderr.write(
        `- ${problem.path} [${problem.code}]: ${problem.message}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  if (printNormalized) {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Valid RelayPlay configuration: ${path}\n` +
        `progress=${result.data.progress.intervalMs}ms ` +
        `clock=${result.data.time.clockMode} ` +
        `platform=${result.data.platform.target}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
