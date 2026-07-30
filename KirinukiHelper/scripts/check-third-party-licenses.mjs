import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_PACKAGE_FILES } from "./extension-package-files.mjs";
import {
  PINNED_MODELS,
  PINNED_VAD_MODEL,
  PINNED_WHISPER_CPP
} from "./local-caption-stack-core.mjs";
import { PAPERLOGY_FONT } from "./paperlogy-font.mjs";
import { PRETENDARD_FONT } from "./pretendard-font.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const siblingAudSegRoot = path.join(root, "..", "AudSeg");
const extensionRoot = path.join(root, "extension");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function bytes(relativePath, base = root) {
  return readFile(path.join(base, relativePath));
}

async function assertAbsent(relativePath) {
  try {
    await access(path.join(root, relativePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`삭제한 외부 서비스·재배포 캐시 파일이 다시 생겼습니다: ${relativePath}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactObject(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} 목록이 승인된 라이선스 인벤토리와 다릅니다.`
  );
}

function assertLockPackage(packagePath, metadata) {
  const version = String(metadata?.version || "");
  const license = String(metadata?.license || "");
  if (packagePath === "node_modules/mediabunny") {
    assert(version === "1.51.0", "Mediabunny 버전이 승인된 1.51.0과 다릅니다.");
    assert(license === "MPL-2.0", "Mediabunny 라이선스가 MPL-2.0이 아닙니다.");
    assert(metadata.dev !== true, "Mediabunny가 runtime dependency가 아닙니다.");
    return;
  }
  if (packagePath === "node_modules/esbuild") {
    assert(version === "0.25.6", "esbuild 버전이 승인된 0.25.6과 다릅니다.");
    assert(license === "MIT", "esbuild 라이선스가 MIT가 아닙니다.");
    assert(metadata.dev === true, "esbuild는 build-only dependency여야 합니다.");
    return;
  }
  if (/^node_modules\/@esbuild\/[^/]+$/u.test(packagePath)) {
    assert(version === "0.25.6", `${packagePath} 버전이 esbuild와 다릅니다.`);
    assert(license === "MIT", `${packagePath} 라이선스가 MIT가 아닙니다.`);
    assert(
      metadata.dev === true && metadata.optional === true,
      `${packagePath}는 optional build-only binary여야 합니다.`
    );
    return;
  }
  const approvedTypePackages = new Map([
    ["node_modules/@types/dom-mediacapture-transform", "0.1.12"],
    ["node_modules/@types/dom-webcodecs", "0.1.13"]
  ]);
  if (approvedTypePackages.has(packagePath)) {
    assert(
      version === approvedTypePackages.get(packagePath),
      `${packagePath} 버전이 승인 목록과 다릅니다.`
    );
    assert(license === "MIT", `${packagePath} 라이선스가 MIT가 아닙니다.`);
    return;
  }
  throw new Error(
    `승인되지 않은 npm 패키지입니다: ${packagePath} ${version} (${license || "license 없음"})`
  );
}

const [packageJson, packageLock] = await Promise.all([
  bytes("package.json").then((value) => JSON.parse(value)),
  bytes("package-lock.json").then((value) => JSON.parse(value))
]);
assert(packageJson.license === "MIT", "KirinukiHelper package license는 MIT여야 합니다.");
await Promise.all([
  assertAbsent("scripts/create-synthetic-beta.py"),
  assertAbsent("scripts/solar-caption-gateway.mjs"),
  assertAbsent("src/caption-agent/solar-gateway-core.js"),
  assertAbsent("extension/knowledge/creator-policies/charon-universe-w.md")
]);
const mediabunnyLock = packageLock.packages?.["node_modules/mediabunny"];

assertExactObject(
  packageJson.dependencies,
  { mediabunny: "1.51.0" },
  "runtime dependency"
);
assertExactObject(
  packageJson.devDependencies,
  { esbuild: "0.25.6" },
  "development dependency"
);
assert(
  packageLock.lockfileVersion === 3,
  "package-lock.json lockfileVersion은 3이어야 합니다."
);
assert(
  packageLock.packages?.[""]?.license === "MIT",
  "package-lock root license는 MIT여야 합니다."
);
assert(
  mediabunnyLock?.resolved
    === "https://registry.npmjs.org/mediabunny/-/mediabunny-1.51.0.tgz",
  "Mediabunny 대응 소스 package URL이 고정값과 다릅니다."
);
assert(
  mediabunnyLock?.integrity
    === "sha512-u327374xU8Ho0gCaMII7fUK8t0PnqkabCox1k8uUwvgvGb9o6YQGZEG2Qr4DTe7nTMpzfL7ukgnHDvDROySZ+Q==",
  "Mediabunny 대응 소스 package integrity가 고정값과 다릅니다."
);
for (const [packagePath, metadata] of Object.entries(packageLock.packages || {})) {
  if (!packagePath) {
    continue;
  }
  assertLockPackage(packagePath, metadata);
}

const [
  projectLicense,
  distributedProjectLicense,
  mediabunnyInstalledLicense,
  mediabunnyDistributedLicense,
  audSegSourceLicense,
  audSegDistributedLicense,
  extensionNotices,
  runtimeNotices
] = await Promise.all([
  bytes("LICENSE"),
  bytes("LICENSE", extensionRoot),
  bytes("node_modules/mediabunny/LICENSE"),
  bytes("licenses/MEDIABUNNY-MPL-2.0.txt", extensionRoot),
  bytes("LICENSE", siblingAudSegRoot),
  bytes("licenses/AUDSEG-MIT.txt", extensionRoot),
  bytes("THIRD_PARTY_NOTICES.md", extensionRoot),
  bytes("legal/THIRD_PARTY_NOTICES.md")
]);
assert(
  projectLicense.equals(distributedProjectLicense),
  "KirinukiHelper MIT 원문과 Extension 배포 사본이 다릅니다."
);
assert(
  projectLicense.toString("utf8").startsWith("MIT License\n")
    && projectLicense.toString("utf8").includes(
      "Copyright (c) 2026 studyreadbook4ever"
    ),
  "KirinukiHelper MIT 라이선스 원문 또는 저작권 고지가 올바르지 않습니다."
);

assert(
  mediabunnyInstalledLicense.equals(mediabunnyDistributedLicense),
  "Mediabunny MPL-2.0 원문과 Extension 배포 사본이 다릅니다."
);
assert(
  audSegSourceLicense.equals(audSegDistributedLicense),
  "AudSeg MIT 원문과 Extension 배포 사본이 다릅니다."
);
assert(
  extensionNotices.equals(runtimeNotices),
  "Extension 고지와 로컬 runtime 설치 고지가 다릅니다."
);
await access(path.join(root, "node_modules", "mediabunny", "src", "index.ts"));

for (const font of [PRETENDARD_FONT, PAPERLOGY_FONT]) {
  const [
    sourceFont,
    distributedFont,
    sourceLicense,
    distributedLicense
  ] = await Promise.all([
    bytes(font.sourceFontPath),
    bytes(font.extensionFontPath, extensionRoot),
    bytes(font.sourceLicensePath),
    bytes(font.extensionLicensePath, extensionRoot)
  ]);
  assert(sourceFont.equals(distributedFont), `${font.family || "Pretendard"} 글꼴 사본이 다릅니다.`);
  assert(sourceLicense.equals(distributedLicense), `${font.family || "Pretendard"} OFL 사본이 다릅니다.`);
  assert(sha256(sourceFont) === font.fontSha256, `${font.family || "Pretendard"} 글꼴 SHA-256이 다릅니다.`);
  assert(sha256(sourceLicense) === font.licenseSha256, `${font.family || "Pretendard"} OFL SHA-256이 다릅니다.`);
}

for (const requiredPath of [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/AUDSEG-MIT.txt",
  "licenses/MEDIABUNNY-MPL-2.0.txt",
  PRETENDARD_FONT.extensionLicensePath,
  PAPERLOGY_FONT.extensionLicensePath
]) {
  assert(
    EXTENSION_PACKAGE_FILES.includes(requiredPath),
    `Extension 배포 allowlist에 라이선스 파일이 없습니다: ${requiredPath}`
  );
}

assert(
  EXTENSION_PACKAGE_FILES.every((relativePath) => !relativePath.startsWith("knowledge/creator-policies/")),
  "재배포 허가가 확인되지 않은 방송인 정책 본문이 Extension 배포 목록에 있습니다."
);
const creatorPolicyIndex = JSON.parse(
  await bytes("knowledge/creator-policy-index.json", extensionRoot)
);
assert(
  Array.isArray(creatorPolicyIndex.policies)
    && creatorPolicyIndex.policies.every((policy) => !Object.hasOwn(policy, "cache")),
  "방송인 정책 인덱스에는 공식 링크만 허용되며 본문 캐시 메타데이터를 둘 수 없습니다."
);

const notices = extensionNotices.toString("utf8");
for (const requiredNotice of [
  "Mediabunny 1.51.0",
  "Mozilla Public License 2.0",
  mediabunnyLock.resolved,
  mediabunnyLock.integrity,
  "AudSeg 0.1.0",
  "License: MIT",
  "Pretendard 1.3.9",
  "SIL Open Font License 1.1",
  "Paperlogy 1.001",
  PINNED_WHISPER_CPP.commit,
  PINNED_WHISPER_CPP.archive.sha256,
  PINNED_VAD_MODEL.sha256,
  "https://github.com/openai/whisper/blob/main/LICENSE",
  "https://github.com/snakers4/silero-vad"
]) {
  assert(notices.includes(requiredNotice), `Third-party 고지에 필수 근거가 없습니다: ${requiredNotice}`);
}
for (const model of Object.values(PINNED_MODELS)) {
  assert(
    notices.includes(model.name) && notices.includes(model.sha256),
    `Third-party 고지에 Whisper 모델 근거가 없습니다: ${model.id}`
  );
}

console.log(JSON.stringify({
  ok: true,
  projectLicense: "MIT",
  npmPackages: Object.keys(packageLock.packages).length - 1,
  runtimeDependencies: packageJson.dependencies,
  buildDependencies: packageJson.devDependencies,
  distributedLicenses: [
    "Mediabunny MPL-2.0",
    "AudSeg MIT",
    "Pretendard OFL-1.1",
    "Paperlogy OFL-1.1"
  ],
  runtimeDownloaded: [
    "whisper.cpp MIT",
    "OpenAI Whisper models MIT",
    "Silero VAD MIT"
  ]
}, null, 2));
