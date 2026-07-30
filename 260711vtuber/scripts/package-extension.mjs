import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXTENSION_PACKAGE_FILES } from "./extension-package-files.mjs";
import {
  acquireDevRunnerLock,
  failClosedOnDevRunnerOwnerLoss,
  releaseDevRunnerLock
} from "./dev-runner-lock.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = path.join(root, "extension");
const devRunnerLockPath = path.join(root, ".dev-editor.lock");
const devRunnerLockLease = await acquireDevRunnerLock(devRunnerLockPath, {
  pid: process.pid,
  role: "package",
  inheritedToken: process.env.KIRINUKI_RELEASE_LOCK_TOKEN,
  onOwnerLost: failClosedOnDevRunnerOwnerLoss("package")
});

try {
const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
const version = manifest.version;
const distRoot = path.join(root, "dist");
const archivePath = path.join(distRoot, `chzzk-kirinuki-studio-v${version}.zip`);
const checksumPath = `${archivePath}.sha256`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageMetadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8")
);
assert(
  packageMetadata.version === version,
  "package.json과 Extension manifest 버전이 다릅니다."
);
assert(
  packageMetadata.license === "UNLICENSED",
  "first-party package는 UNLICENSED여야 합니다."
);

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`패키지에 심볼릭 링크나 특수 파일을 넣을 수 없습니다: ${relativePath}`);
    }
  }
  return files.sort();
}

async function run(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", (error) => {
      reject(new Error(`${command} 실행 실패: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ""}`));
      }
    });
  });
}

const expectedFiles = [...EXTENSION_PACKAGE_FILES].sort();
const actualFiles = await listFiles(extensionRoot);
assert(
  JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
  "extension 패키지 파일 목록이 allowlist와 다릅니다.\n" +
    `expected=${JSON.stringify(expectedFiles, null, 2)}\n` +
    `actual=${JSON.stringify(actualFiles, null, 2)}`
);

await run(process.execPath, [
  path.join(root, "scripts", "check-third-party-licenses.mjs")
]);

await mkdir(distRoot, { recursive: true });
for (const entry of await readdir(distRoot)) {
  if (/^chzzk-kirinuki-studio-v.+\.zip(?:\.sha256)?$/u.test(entry)) {
    await rm(path.join(distRoot, entry), { force: true });
  }
}

await run("zip", ["-q", archivePath, ...expectedFiles], { cwd: extensionRoot });
const archiveEntries = (await run("unzip", ["-Z1", archivePath], { capture: true }))
  .stdout
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((entry) => !entry.endsWith("/"))
  .sort();
assert(
  JSON.stringify(archiveEntries) === JSON.stringify(expectedFiles),
  "생성된 ZIP의 파일 목록이 allowlist와 다릅니다."
);

const extractRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-kirinuki-package-smoke-"));
try {
  await run("unzip", ["-q", archivePath, "-d", extractRoot]);
  const packagedManifest = JSON.parse(
    await readFile(path.join(extractRoot, "manifest.json"), "utf8")
  );
  assert(packagedManifest.version === version, "ZIP manifest 버전이 원본과 다릅니다.");
  await run(process.execPath, [
    path.join(root, "scripts", "browser-smoke.mjs"),
    extractRoot
  ]);
} finally {
  await rm(extractRoot, { recursive: true, force: true });
}

const archive = await readFile(archivePath);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(
  checksumPath,
  `${digest}  ${path.basename(archivePath)}\n`
);

console.log(JSON.stringify({
  archive: path.relative(root, archivePath),
  bytes: archive.byteLength,
  files: expectedFiles.length,
  sha256: digest,
  checksum: path.relative(root, checksumPath)
}, null, 2));
} finally {
  await releaseDevRunnerLock(devRunnerLockLease);
}
