#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ConfigValidationError,
  createPresetConfig,
  type ClockMode,
  type GamePresetName,
  type LateEventPolicy,
  type PlatformTarget,
  type RankedInputPool,
  type RelayPlayConfigInput,
} from "../packages/core/src/index.js";

interface ConfigureOptions {
  preset: GamePresetName;
  platform: PlatformTarget;
  output: string;
  stdout: boolean;
  force: boolean;
  progressMs?: number;
  maxPlayers?: number;
  startLeadMs?: number;
  interactionLeadMs?: number;
  clockMode?: ClockMode;
  lateEventPolicy?: LateEventPolicy;
  interactions?: boolean;
  targeted?: boolean;
  scheduled?: boolean;
  reconnect?: boolean;
  replayEvents?: boolean;
  replayEvidence?: boolean;
  stateHashes?: boolean;
  touch?: boolean;
  keyboard?: boolean;
  pointer?: boolean;
  gamepad?: boolean;
  crossPlay?: boolean;
  rankedPool?: RankedInputPool;
  allowInputSwitch?: boolean;
}

const GAME_PRESETS = new Set<GamePresetName>([
  "live-race",
  "soft-battle",
  "falling-block-battle",
  "rhythm-race",
]);
const PLATFORM_TARGETS = new Set<PlatformTarget>([
  "universal",
  "mobile-first",
  "desktop-first",
]);
const CLOCK_MODES = new Set<ClockMode>(["monotonic", "fixed-tick", "audio"]);
const LATE_POLICIES = new Set<LateEventPolicy>([
  "apply-immediately",
  "drop",
  "next-boundary",
]);
const RANKED_POOLS = new Set<RankedInputPool>([
  "unified",
  "same-input-preferred",
  "separate",
]);

const HELP = `RelayPlay configuration generator

Usage:
  npm run configure -- [options]

Starting point:
  --preset <name>               live-race | soft-battle |
                                falling-block-battle | rhythm-race
  --platform <target>           universal | mobile-first | desktop-first

Room and cadence:
  --max-players <integer>       1..256
  --progress-ms <integer>       100..60000 (default is 1000)

Timing:
  --clock <mode>                monotonic | fixed-tick | audio
  --start-lead-ms <integer>     0..120000
  --interaction-lead-ms <int>   0..30000
  --late-policy <policy>        apply-immediately | drop | next-boundary

Feature toggles (each also accepts --no-<name>):
  --interactions  --targeted  --scheduled
  --reconnect     --replay-events
  --replay-evidence  --state-hashes
  --touch  --keyboard  --pointer  --gamepad
  --cross-play  --allow-input-switch

Matchmaking:
  --ranked-pool <policy>        unified | same-input-preferred | separate

Output:
  --output <path>               default: relayplay.config.json
  --stdout                      print JSON and do not write a file
  --force                       replace an existing output file
  --help

Examples:
  npm run configure -- --preset soft-battle --platform universal
  npm run configure -- --preset rhythm-race --clock audio --no-gamepad
  npm run configure -- --preset falling-block-battle --ranked-pool separate
`;

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function integerInRange(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function enumValue<T extends string>(value: string, flag: string, allowed: Set<T>): T {
  if (!allowed.has(value as T)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value as T;
}

function parseBooleanFlag(
  name: string,
  value: boolean,
  options: ConfigureOptions,
): boolean {
  const assignments: Record<string, keyof ConfigureOptions> = {
    interactions: "interactions",
    targeted: "targeted",
    scheduled: "scheduled",
    reconnect: "reconnect",
    "replay-events": "replayEvents",
    "replay-evidence": "replayEvidence",
    "state-hashes": "stateHashes",
    touch: "touch",
    keyboard: "keyboard",
    pointer: "pointer",
    gamepad: "gamepad",
    "cross-play": "crossPlay",
    "allow-input-switch": "allowInputSwitch",
  };
  const property = assignments[name];
  if (property === undefined) {
    return false;
  }
  (options as unknown as Record<string, unknown>)[property] = value;
  return true;
}

function parseArguments(args: readonly string[]): ConfigureOptions | undefined {
  const options: ConfigureOptions = {
    preset: "live-race",
    platform: "universal",
    output: "relayplay.config.json",
    stdout: false,
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--help" || raw === "-h") {
      process.stdout.write(HELP);
      return undefined;
    }
    if (raw === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (raw === "--force") {
      options.force = true;
      continue;
    }
    if (raw?.startsWith("--no-")) {
      if (!parseBooleanFlag(raw.slice(5), false, options)) {
        throw new Error(`unknown option: ${raw}`);
      }
      continue;
    }
    if (raw?.startsWith("--")) {
      const name = raw.slice(2);
      if (parseBooleanFlag(name, true, options)) {
        continue;
      }
      const value = requireValue(args, index, raw);
      index += 1;
      switch (name) {
        case "preset":
          options.preset = enumValue(value, raw, GAME_PRESETS);
          break;
        case "platform":
          options.platform = enumValue(value, raw, PLATFORM_TARGETS);
          break;
        case "output":
          options.output = value;
          break;
        case "progress-ms":
          options.progressMs = integerInRange(value, raw, 100, 60_000);
          break;
        case "max-players":
          options.maxPlayers = integerInRange(value, raw, 1, 256);
          break;
        case "start-lead-ms":
          options.startLeadMs = integerInRange(value, raw, 0, 120_000);
          break;
        case "interaction-lead-ms":
          options.interactionLeadMs = integerInRange(value, raw, 0, 30_000);
          break;
        case "clock":
          options.clockMode = enumValue(value, raw, CLOCK_MODES);
          break;
        case "late-policy":
          options.lateEventPolicy = enumValue(value, raw, LATE_POLICIES);
          break;
        case "ranked-pool":
          options.rankedPool = enumValue(value, raw, RANKED_POOLS);
          break;
        default:
          throw new Error(`unknown option: ${raw}`);
      }
      continue;
    }
    throw new Error(`unexpected positional argument: ${raw}`);
  }

  return options;
}

function buildOverrides(options: ConfigureOptions): RelayPlayConfigInput {
  const overrides: Record<string, unknown> = {};

  if (options.maxPlayers !== undefined) {
    overrides.room = { maxPlayers: options.maxPlayers };
  }
  if (options.progressMs !== undefined) {
    overrides.progress = { intervalMs: options.progressMs };
  }

  const interactions: Record<string, boolean> = {};
  if (options.interactions !== undefined) {
    interactions.enabled = options.interactions;
    if (!options.interactions) {
      interactions.targeted = options.targeted ?? false;
      interactions.scheduled = options.scheduled ?? false;
    }
  }
  if (options.targeted !== undefined) interactions.targeted = options.targeted;
  if (options.scheduled !== undefined) interactions.scheduled = options.scheduled;

  const reconnect: Record<string, boolean> = {};
  if (options.reconnect !== undefined) {
    reconnect.enabled = options.reconnect;
    if (!options.reconnect) reconnect.replayCanonicalEvents = options.replayEvents ?? false;
  }
  if (options.replayEvents !== undefined) {
    reconnect.replayCanonicalEvents = options.replayEvents;
  }

  const evidence: Record<string, boolean> = {};
  if (options.replayEvidence !== undefined) evidence.replayChunks = options.replayEvidence;
  if (options.stateHashes !== undefined) evidence.stateHashes = options.stateHashes;

  const featureOverrides: Record<string, unknown> = {};
  if (Object.keys(interactions).length > 0) featureOverrides.interactions = interactions;
  if (Object.keys(reconnect).length > 0) featureOverrides.reconnect = reconnect;
  if (Object.keys(evidence).length > 0) featureOverrides.evidence = evidence;
  if (Object.keys(featureOverrides).length > 0) overrides.features = featureOverrides;

  const time: Record<string, unknown> = {};
  if (options.clockMode !== undefined) time.clockMode = options.clockMode;
  if (options.startLeadMs !== undefined) time.startLeadMs = options.startLeadMs;
  if (options.interactionLeadMs !== undefined) {
    time.interactionLeadMs = options.interactionLeadMs;
  }
  if (options.lateEventPolicy !== undefined) {
    time.lateEventPolicy = options.lateEventPolicy;
  }
  if (Object.keys(time).length > 0) overrides.time = time;

  const inputs: Record<string, boolean> = {};
  for (const inputName of ["touch", "keyboard", "pointer", "gamepad"] as const) {
    const value = options[inputName];
    if (value !== undefined) inputs[inputName] = value;
  }
  const crossPlay: Record<string, boolean | RankedInputPool> = {};
  if (options.crossPlay !== undefined) crossPlay.enabled = options.crossPlay;
  if (options.rankedPool !== undefined) crossPlay.rankedPool = options.rankedPool;
  if (options.allowInputSwitch !== undefined) {
    crossPlay.allowInputSwitch = options.allowInputSwitch;
  }
  const platform: Record<string, unknown> = {};
  if (Object.keys(inputs).length > 0) platform.inputs = inputs;
  if (Object.keys(crossPlay).length > 0) platform.crossPlay = crossPlay;
  if (Object.keys(platform).length > 0) overrides.platform = platform;

  return overrides as RelayPlayConfigInput;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) return;

  const config = createPresetConfig(
    options.preset,
    options.platform,
    buildOverrides(options),
  );
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  if (options.stdout) {
    process.stdout.write(serialized);
    return;
  }

  const outputPath = resolve(process.cwd(), options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  });
  process.stdout.write(
    `Created ${outputPath}\nPreset: ${options.preset}\nPlatform: ${options.platform}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`Configuration is invalid:\n`);
    for (const problem of error.issues) {
      process.stderr.write(`- ${problem.path}: ${problem.message}\n`);
    }
  } else if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  ) {
    process.stderr.write("Output already exists. Pass --force to replace it.\n");
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
