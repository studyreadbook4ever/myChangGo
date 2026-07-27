#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function sendText(response, statusCode, message) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function resolveRequestPath(root, rawUrl) {
  const requestUrl = new URL(rawUrl || '/', 'http://localhost');
  let pathname;

  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return { error: [400, 'Malformed URL encoding'] };
  }

  if (pathname.includes('\0')) {
    return { error: [400, 'Invalid path'] };
  }

  const relativePath =
    pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let candidate = resolve(root, relativePath);

  if (!isInside(root, candidate)) {
    return { error: [403, 'Path is outside the project root'] };
  }

  let fileStats;
  try {
    fileStats = await stat(candidate);
    if (fileStats.isDirectory()) {
      candidate = resolve(candidate, 'index.html');
      if (!isInside(root, candidate)) {
        return { error: [403, 'Path is outside the project root'] };
      }
      fileStats = await stat(candidate);
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { error: [404, 'Not found'] };
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    return { error: [404, 'Not found'] };
  }

  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    return { error: [403, 'Symbolic link is outside the project root'] };
  }

  return { filePath: canonicalCandidate, fileStats };
}

/**
 * Create the dependency-free development server without binding a port.
 *
 * The caller owns the returned server and must close it.
 */
export function createStaticServer({ root = PROJECT_ROOT } = {}) {
  const resolvedRoot = resolve(root);

  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed');
      return;
    }

    try {
      const result = await resolveRequestPath(resolvedRoot, request.url);
      if (result.error) {
        sendText(response, ...result.error);
        return;
      }

      const contentType =
        CONTENT_TYPES.get(extname(result.filePath).toLowerCase()) ??
        'application/octet-stream';
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': result.fileStats.size,
        'content-type': contentType,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      const stream = createReadStream(result.filePath);
      stream.on('error', (error) => {
        if (!response.headersSent) {
          sendText(response, 500, 'Unable to read file');
        } else {
          response.destroy(error);
        }
      });
      stream.pipe(response);
    } catch (error) {
      console.error('[serve] request failed:', error);
      if (!response.headersSent) {
        sendText(response, 500, 'Internal server error');
      } else {
        response.destroy(error);
      }
    }
  });
}

export async function listen({
  host = '127.0.0.1',
  port = 4173,
  root = PROJECT_ROOT,
} = {}) {
  const server = createStaticServer({ root });

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
    server.listen(port, host);
  });

  return server;
}

function parseCliOptions(arguments_) {
  const options = {
    host: process.env.EFCHSQL_HOST || '127.0.0.1',
    port: Number(process.env.EFCHSQL_PORT || 4173),
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--host') {
      options.host = arguments_[index + 1];
      index += 1;
    } else if (argument === '--port') {
      options.port = Number(arguments_[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (
    typeof options.host !== 'string' ||
    options.host.length === 0 ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error('Host must be non-empty and port must be 0..65535.');
  }

  return options;
}

async function runCli() {
  const options = parseCliOptions(process.argv.slice(2));
  const server = await listen(options);
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : options.port;

  const displayUrl = `http:${'//'}${options.host}:${boundPort}`;
  console.log(`efchSQL dev server: ${displayUrl}`);
  console.log('Press Ctrl+C to stop.');

  const close = (signal) => {
    console.log(`\n[serve] ${signal}; shutting down.`);
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';

if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    console.error('[serve] failed:', error.message);
    process.exitCode = 1;
  });
}
