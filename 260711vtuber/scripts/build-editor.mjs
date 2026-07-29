import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { PAPERLOGY_FONT } from "./paperlogy-font.mjs";
import { PRETENDARD_FONT } from "./pretendard-font.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const editorSourceRoot = path.join(root, "src", "editor");
const outputRoot = path.join(root, "extension", "editor");
const fontRoot = path.join(outputRoot, "fonts");
const extensionRoot = path.join(root, "extension");
const licenseRoot = path.join(extensionRoot, "licenses");

await mkdir(outputRoot, { recursive: true });
await mkdir(fontRoot, { recursive: true });
await mkdir(licenseRoot, { recursive: true });

async function assertSha256(relativePath, expectedSha256, label) {
  const file = await readFile(path.join(root, relativePath));
  const actualSha256 = createHash("sha256").update(file).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} 원본 무결성 검증 실패: ${relativePath}\n` +
      `expected=${expectedSha256}\nactual=${actualSha256}`
    );
  }
}

await Promise.all([
  assertSha256(PRETENDARD_FONT.sourceFontPath, PRETENDARD_FONT.fontSha256, "Pretendard"),
  assertSha256(PRETENDARD_FONT.sourceLicensePath, PRETENDARD_FONT.licenseSha256, "Pretendard"),
  assertSha256(PAPERLOGY_FONT.sourceFontPath, PAPERLOGY_FONT.fontSha256, "Paperlogy"),
  assertSha256(PAPERLOGY_FONT.sourceLicensePath, PAPERLOGY_FONT.licenseSha256, "Paperlogy")
]);

const shared = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "esm",
  sourcemap: false,
  minify: false,
  legalComments: "eof",
  logLevel: "info"
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(editorSourceRoot, "main.js")],
    outfile: path.join(outputRoot, "editor.js")
  }),
  build({
    ...shared,
    format: "iife",
    entryPoints: [path.join(root, "src", "content-script.js")],
    outfile: path.join(extensionRoot, "content-script.js")
  })
]);

await Promise.all([
  copyFile(
    path.join(root, "legal", "THIRD_PARTY_NOTICES.md"),
    path.join(extensionRoot, "THIRD_PARTY_NOTICES.md")
  ),
  copyFile(
    path.join(root, "node_modules", "mediabunny", "LICENSE"),
    path.join(licenseRoot, "MEDIABUNNY-MPL-2.0.txt")
  ),
  copyFile(
    path.join(root, PRETENDARD_FONT.sourceFontPath),
    path.join(extensionRoot, PRETENDARD_FONT.extensionFontPath)
  ),
  copyFile(
    path.join(root, PRETENDARD_FONT.sourceLicensePath),
    path.join(extensionRoot, PRETENDARD_FONT.extensionLicensePath)
  ),
  copyFile(
    path.join(root, PAPERLOGY_FONT.sourceFontPath),
    path.join(extensionRoot, PAPERLOGY_FONT.extensionFontPath)
  ),
  copyFile(
    path.join(root, PAPERLOGY_FONT.sourceLicensePath),
    path.join(extensionRoot, PAPERLOGY_FONT.extensionLicensePath)
  )
]);

console.log(
  `Editor/content bridge bundles, Pretendard ${PRETENDARD_FONT.version}, ` +
  `and Paperlogy ${PAPERLOGY_FONT.version} ` +
  `written to ${path.relative(root, extensionRoot)}`
);
