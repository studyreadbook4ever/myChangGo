import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

export const DEV_RUNNER_LOCK_SCHEMA = "chzzk-kirinuki-dev-runner-lock/v1";
const DEV_RUNNER_ROLES = new Set(["editor", "package", "validate"]);

export function createDevRunnerLock({
  pid = process.pid,
  role = "editor",
  createdAt = new Date(),
  token = randomUUID()
} = {}) {
  const createdAtDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("개발 runner 잠금 PID가 올바르지 않습니다.");
  }
  if (!DEV_RUNNER_ROLES.has(role)) {
    throw new TypeError(`지원하지 않는 개발 runner 잠금 역할입니다: ${role}`);
  }
  if (!Number.isFinite(createdAtDate.getTime())) {
    throw new TypeError("개발 runner 잠금 생성 시각이 올바르지 않습니다.");
  }
  if (
    typeof token !== "string"
    || token.length < 16
    || token.length > 128
    || !/^[a-zA-Z0-9-]+$/u.test(token)
  ) {
    throw new TypeError("개발 runner 잠금 token이 올바르지 않습니다.");
  }
  return {
    schema: DEV_RUNNER_LOCK_SCHEMA,
    pid,
    role,
    createdAt: createdAtDate.toISOString(),
    token
  };
}

export function isDevRunnerLock(value) {
  return Boolean(
    value
    && (
      (
        value.schema === DEV_RUNNER_LOCK_SCHEMA
        && typeof value.token === "string"
        && value.token.length >= 16
        && value.token.length <= 128
        && /^[a-zA-Z0-9-]+$/u.test(value.token)
      )
      || (
        value.schema === undefined
        && value.token === undefined
      )
    )
    && Number.isInteger(value.pid)
    && value.pid > 0
    && (
      value.role === undefined
      || DEV_RUNNER_ROLES.has(value.role)
    )
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt))
  );
}

export async function readDevRunnerLock(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    if (!isDevRunnerLock(value)) {
      return null;
    }
    return {
      ...value,
      role: value.role ?? "editor"
    };
  } catch {
    return null;
  }
}

export function devRunnerMutexEndpoint(lockPath, platform = process.platform) {
  const digest = createHash("sha256")
    .update(path.resolve(lockPath))
    .digest("hex")
    .slice(0, 24);
  if (platform === "linux") {
    return `\0chzzk-kirinuki-${digest}`;
  }
  if (platform === "win32") {
    return `\\\\.\\pipe\\chzzk-kirinuki-${digest}`;
  }
  return {
    host: "127.0.0.1",
    port: 49_152 + (Number.parseInt(digest.slice(0, 4), 16) % 16_384),
    exclusive: true
  };
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function roleLabel(role) {
  return {
    editor: "dev:editor",
    package: "릴리스 패키징",
    validate: "릴리스 검증"
  }[role] ?? role;
}

export function failClosedOnDevRunnerOwnerLoss(label) {
  return (error) => {
    console.error(
      `[${label}] 상위 릴리스 잠금이 사라져 즉시 중단합니다: ${error.message}`
    );
    process.exit(1);
  };
}

function connectToDevRunnerMutex(endpoint, expectedToken) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const ownerState = {
      expectedClose: false,
      lost: false,
      lossError: null,
      onLost: null
    };
    let settled = false;
    let response = "";
    const finish = (error, token = "") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        const markOwnerLost = (lossError) => {
          if (ownerState.lost || ownerState.expectedClose) {
            return;
          }
          ownerState.lost = true;
          ownerState.lossError = lossError;
          ownerState.onLost?.(lossError);
        };
        socket.on("error", (socketError) => {
          markOwnerLost(socketError);
        });
        socket.once("close", () => {
          markOwnerLost(new Error("상위 릴리스 mutex 연결이 종료됐습니다."));
        });
        resolve({ socket, token, ownerState });
      }
    };
    const onConnect = () => {
      socket.write(`BORROW ${expectedToken}\n`);
    };
    const onData = (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 256) {
        finish(new Error("개발 runner mutex handshake가 너무 큽니다."));
        return;
      }
      const newlineIndex = response.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = response.slice(0, newlineIndex);
        finish(null, line.match(/^OK ([a-zA-Z0-9-]{16,128})$/u)?.[1] ?? line);
      }
    };
    const onError = (error) => {
      finish(error);
    };
    const onClose = () => {
      finish(new Error("개발 runner mutex가 handshake 전에 종료됐습니다."));
    };
    const timeout = setTimeout(() => {
      finish(new Error("개발 runner mutex handshake 시간 초과"));
    }, 2_000);
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function acquireDevRunnerLock(lockPath, options = {}) {
  const inheritedToken = String(options.inheritedToken || "").trim();
  const endpoint = options.endpoint ?? devRunnerMutexEndpoint(lockPath);
  if (inheritedToken) {
    if (typeof options.onOwnerLost !== "function") {
      throw new TypeError(
        "상위 릴리스 잠금을 빌릴 때 onOwnerLost fail-closed 처리가 필요합니다."
      );
    }
    let handshake;
    try {
      handshake = await connectToDevRunnerMutex(endpoint, inheritedToken);
    } catch (error) {
      throw new Error(
        `상위 릴리스 잠금 프로세스가 더 이상 실행 중이지 않습니다: ${error.message}`
      );
    }
    if (handshake.token !== inheritedToken) {
      handshake.ownerState.expectedClose = true;
      handshake.socket.destroy();
      throw new Error("상위 릴리스 mutex token이 현재 소유자와 일치하지 않습니다.");
    }
    const owner = await readDevRunnerLock(lockPath);
    if (
      !owner
      || owner.role !== "package"
      || owner.token !== inheritedToken
    ) {
      handshake.ownerState.expectedClose = true;
      handshake.socket.destroy();
      throw new Error("상위 릴리스 잠금 token이 현재 소유자와 일치하지 않습니다.");
    }
    if (handshake.ownerState.lost) {
      throw new Error(
        `상위 릴리스 잠금 프로세스가 handshake 중 종료됐습니다: `
        + handshake.ownerState.lossError?.message
      );
    }
    handshake.ownerState.onLost = options.onOwnerLost;
    return {
      lock: owner,
      lockPath,
      endpoint,
      server: null,
      ownerSocket: handshake.socket,
      ownerState: handshake.ownerState,
      borrowed: true,
      released: false
    };
  }

  const lock = createDevRunnerLock(options);
  const mutexState = {
    closing: false,
    pendingSockets: new Set(),
    borrowerSockets: new Set(),
    drainWaiters: new Set()
  };
  const resolveBorrowerDrain = () => {
    if (mutexState.borrowerSockets.size !== 0) {
      return;
    }
    for (const resolve of mutexState.drainWaiters) {
      resolve();
    }
    mutexState.drainWaiters.clear();
  };
  const ownerSockets = new Set();
  const server = net.createServer((socket) => {
    ownerSockets.add(socket);
    mutexState.pendingSockets.add(socket);
    socket.on("error", () => {});
    let request = "";
    const timer = setTimeout(() => socket.destroy(), 2_000);
    const onData = (chunk) => {
      request += chunk.toString("utf8");
      if (request.length > 256) {
        socket.destroy();
        return;
      }
      const newlineIndex = request.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      socket.off("data", onData);
      clearTimeout(timer);
      mutexState.pendingSockets.delete(socket);
      const requestedToken = request
        .slice(0, newlineIndex)
        .match(/^BORROW ([a-zA-Z0-9-]{16,128})$/u)?.[1];
      if (
        mutexState.closing
        || requestedToken !== lock.token
      ) {
        socket.end("DENY\n");
        return;
      }
      mutexState.borrowerSockets.add(socket);
      socket.write(`OK ${lock.token}\n`);
    };
    socket.on("data", onData);
    socket.once("close", () => {
      clearTimeout(timer);
      ownerSockets.delete(socket);
      mutexState.pendingSockets.delete(socket);
      mutexState.borrowerSockets.delete(socket);
      resolveBorrowerDrain();
    });
  });
  try {
    await listen(server, endpoint);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }
    const owner = await readDevRunnerLock(lockPath);
    const ownerDescription = owner
      ? `${roleLabel(owner.role)} (pid ${owner.pid})`
      : "다른 로컬 프로세스";
    throw new Error(
      `${ownerDescription}가 개발·검증·패키징 잠금을 사용 중입니다.`
    );
  }

  try {
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    await close(server);
    throw error;
  }
  return {
    lock,
    lockPath,
    endpoint,
    server,
    ownerSockets,
    ownerSocket: null,
    ownerState: null,
    mutexState,
    borrowed: false,
    released: false
  };
}

export async function releaseDevRunnerLock(lease) {
  if (!lease || lease.released) {
    return false;
  }
  lease.released = true;
  if (lease.borrowed) {
    lease.ownerState.expectedClose = true;
    lease.ownerSocket?.destroy();
    return true;
  }
  lease.mutexState.closing = true;
  for (const socket of lease.mutexState.pendingSockets) {
    socket.destroy();
  }
  if (lease.mutexState.borrowerSockets.size > 0) {
    await new Promise((resolve) => {
      lease.mutexState.drainWaiters.add(resolve);
    });
  }
  await close(lease.server);
  return true;
}

export function releaseDevRunnerLockSync(lease) {
  if (!lease || lease.released) {
    return false;
  }
  lease.released = true;
  if (lease.borrowed) {
    lease.ownerState.expectedClose = true;
    lease.ownerSocket?.destroy();
    return true;
  }
  lease.mutexState.closing = true;
  for (const socket of lease.ownerSockets) {
    socket.destroy();
  }
  lease.server.close();
  return true;
}
