import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { EXTENSION_PACKAGE_FILES } from "../scripts/extension-package-files.mjs";

const rootUrl = new URL("../", import.meta.url);

async function isAbsent(relativePath) {
  try {
    await access(new URL(relativePath, rootUrl));
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

test("first-party 배포는 UNLICENSED이고 프로젝트 LICENSE를 싣지 않는다", async () => {
  const [packageJson, packageLock] = await Promise.all([
    readFile(new URL("package.json", rootUrl), "utf8").then(JSON.parse),
    readFile(new URL("package-lock.json", rootUrl), "utf8").then(JSON.parse)
  ]);

  assert.equal(packageJson.license, "UNLICENSED");
  assert.equal(packageLock.packages?.[""]?.license, "UNLICENSED");
  assert.equal(await isAbsent("LICENSE"), true);
  assert.equal(await isAbsent("extension/LICENSE"), true);
  assert.equal(EXTENSION_PACKAGE_FILES.includes("LICENSE"), false);
});

test("독립 라이선스인 제3자 고지와 원문은 ZIP allowlist에 남긴다", () => {
  for (const relativePath of [
    "THIRD_PARTY_NOTICES.md",
    "licenses/AUDSEG-MIT.txt",
    "licenses/MEDIABUNNY-MPL-2.0.txt",
    "licenses/PAPERLOGY-OFL-1.1.txt",
    "licenses/PRETENDARD-OFL-1.1.txt"
  ]) {
    assert.equal(
      EXTENSION_PACKAGE_FILES.includes(relativePath),
      true,
      `${relativePath}가 ZIP allowlist에 있어야 합니다.`
    );
  }
});

test("패키저는 제거한 companion-origin 예외 모드를 사용하지 않는다", async () => {
  const packageScript = await readFile(
    new URL("scripts/package-extension.mjs", rootUrl),
    "utf8"
  );

  assert.doesNotMatch(packageScript, /expect-package-origin-rejection/u);
  assert.match(packageScript, /packageMetadata\.license === "UNLICENSED"/u);
});

test("AudSeg 전용 역검증이 Whisper·loopback·endpoint 회귀를 차단한다", async () => {
  const validator = await readFile(
    new URL("scripts/validate-extension.mjs", rootUrl),
    "utf8"
  );

  for (const forbiddenGuard of [
    '"whisper"',
    '"127.0.0.1"',
    '"localhost"',
    '"caption-agent-endpoint"',
    '"caption-agent-token"',
    '"/v1/captions"',
    '"/v1/session"'
  ]) {
    assert.match(
      validator,
      new RegExp(forbiddenGuard.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
    );
  }
});
