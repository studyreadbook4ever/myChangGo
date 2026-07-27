#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

const steps = [
  ['license and dependency audit', ['scripts/license-audit.mjs']],
  ['Node test suite', ['--test']],
  ['benchmark assertions', ['scripts/benchmark.mjs']],
  ['Chromium browser smoke test', ['scripts/browser-smoke.mjs']],
];

function runNode(arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            `${process.execPath} ${arguments_.join(' ')} exited with ${
              code ?? signal
            }`,
          ),
        );
      }
    });
  });
}

async function main() {
  const startedAt = performance.now();

  for (let index = 0; index < steps.length; index += 1) {
    const [label, arguments_] = steps[index];
    console.log(`\n[verify ${index + 1}/${steps.length}] ${label}`);
    await runNode(arguments_);
  }

  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
  console.log(`\n[verify] PASS (${elapsed}s)`);
}

main().catch((error) => {
  console.error('\n[verify] FAIL:', error.message);
  process.exitCode = 1;
});
