#!/usr/bin/env node

import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './serve.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const HARNESS_PATH = resolve(PROJECT_ROOT, 'tests/browser-harness.html');
const ARTIFACT_DIR = resolve(PROJECT_ROOT, '.artifacts');
const SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'browser-smoke.png');
const MOBILE_SCREENSHOT_PATH = resolve(
  ARTIFACT_DIR,
  'browser-smoke-mobile.png',
);
const PASS_MARKER =
  /<body\b[^>]*\bdata-test-status=(?:"pass"|'pass')[^>]*>/i;
const FAIL_MARKER =
  /<body\b[^>]*\bdata-test-status=(?:"fail"|'fail')[^>]*>/i;

async function findChromium() {
  const candidates = [
    process.env.EFCHSQL_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit executable path.
    }
  }

  throw new Error(
    'Chromium was not found. Expected /usr/bin/chromium or EFCHSQL_CHROMIUM.',
  );
}

function runProcess(command, arguments_, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Chromium exceeded ${timeoutMs} ms.`));
    }, timeoutMs);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error);
      else resolveRun(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('Chromium output exceeded 16 MiB.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) {
        stderr = stderr.slice(-4 * 1024 * 1024);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-12).join('\n');
        finish(
          new Error(
            `Chromium exited with ${code ?? signal}.${detail ? `\n${detail}` : ''}`,
          ),
        );
        return;
      }
      finish(null, { stdout, stderr });
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function assertHarnessPassed(dom, label) {
  if (FAIL_MARKER.test(dom)) {
    const statusMatch = dom.match(
      /<output\b[^>]*\bid=(?:"status"|'status')[^>]*>([\s\S]*?)<\/output>/i,
    );
    const statusText = statusMatch?.[1]
      ?.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(
      `${label} harness reported data-test-status="fail".${
        statusText ? ` ${statusText}` : ''
      }`,
    );
  }
  if (!PASS_MARKER.test(dom)) {
    const excerpt = dom.replace(/\s+/g, ' ').slice(-1200);
    throw new Error(
      `${label} harness pass marker was not found. DOM tail:\n${excerpt}`,
    );
  }
}

async function main() {
  await access(HARNESS_PATH, fsConstants.R_OK);
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await rm(SCREENSHOT_PATH, { force: true });
  await rm(MOBILE_SCREENSHOT_PATH, { force: true });

  const chromium = await findChromium();
  const profileDirectory = await mkdtemp(join(tmpdir(), 'efchsql-chromium-'));
  const server = createStaticServer({ root: PROJECT_ROOT });

  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Static server did not expose a TCP port.');
    }

    const harnessUrl =
      `http:${'//'}${address.address}:${address.port}/tests/browser-harness.html`;
    const mobileHarnessUrl = `${harnessUrl}?mobile=1`;
    const sharedArguments = [
      '--headless=new',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      `--user-data-dir=${profileDirectory}`,
      '--virtual-time-budget=60000',
    ];
    const desktopArguments = [...sharedArguments, '--window-size=1440,1100'];
    const mobileArguments = [...sharedArguments, '--window-size=430,900'];

    const { stdout: desktopDom } = await runProcess(
      chromium,
      [...desktopArguments, '--dump-dom', harnessUrl],
      { timeoutMs: 35_000 },
    );
    assertHarnessPassed(desktopDom, 'Desktop');

    const { stdout: mobileDom } = await runProcess(
      chromium,
      [...mobileArguments, '--dump-dom', mobileHarnessUrl],
      { timeoutMs: 35_000 },
    );
    assertHarnessPassed(mobileDom, 'Mobile');

    await runProcess(
      chromium,
      [
        ...desktopArguments,
        `--screenshot=${SCREENSHOT_PATH}`,
        harnessUrl,
      ],
      { timeoutMs: 35_000 },
    );
    await runProcess(
      chromium,
      [
        ...mobileArguments,
        `--screenshot=${MOBILE_SCREENSHOT_PATH}`,
        mobileHarnessUrl,
      ],
      { timeoutMs: 35_000 },
    );
    for (const screenshotPath of [SCREENSHOT_PATH, MOBILE_SCREENSHOT_PATH]) {
      const screenshot = await stat(screenshotPath);
      if (!screenshot.isFile() || screenshot.size === 0) {
        throw new Error(
          `Chromium did not create a non-empty screenshot at ${screenshotPath}.`,
        );
      }
    }

    console.log('[browser-smoke] PASS');
    console.log('[browser-smoke] Desktop + mobile harnesses passed');
    console.log(`[browser-smoke] Chromium: ${chromium}`);
    console.log(`[browser-smoke] Screenshot: ${SCREENSHOT_PATH}`);
    console.log(`[browser-smoke] Mobile screenshot: ${MOBILE_SCREENSHOT_PATH}`);
  } finally {
    try {
      await closeServer(server);
    } finally {
      await rm(profileDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error('[browser-smoke] FAIL:', error.message);
  process.exitCode = 1;
});
