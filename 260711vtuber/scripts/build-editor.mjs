import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(root, "src", "editor");
const outputRoot = path.join(root, "extension", "editor");
const vendorRoot = path.join(outputRoot, "vendor");
const extensionRoot = path.join(root, "extension");
const licenseRoot = path.join(extensionRoot, "licenses");

await mkdir(outputRoot, { recursive: true });
await mkdir(vendorRoot, { recursive: true });
await mkdir(licenseRoot, { recursive: true });

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
    entryPoints: [path.join(sourceRoot, "main.js")],
    outfile: path.join(outputRoot, "editor.js")
  }),
  build({
    ...shared,
    entryPoints: [path.join(sourceRoot, "asr-worker.js")],
    outfile: path.join(outputRoot, "asr-worker.js")
  })
]);

const asrBundlePath = path.join(outputRoot, "asr-worker.js");
const asrBundle = await readFile(asrBundlePath, "utf8");
const remoteWasmFallback = /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}]+\}\/dist\/`/gu;
const fallbackMatches = asrBundle.match(remoteWasmFallback) || [];
if (fallbackMatches.length !== 1) {
  throw new Error(`Transformers 원격 WASM fallback을 정확히 하나 찾지 못했습니다: ${fallbackMatches.length}`);
}
const localOnlyAsrBundle = asrBundle.replace(
  remoteWasmFallback,
  'new URL("./vendor/", self.location.href).href'
);
if (localOnlyAsrBundle.includes("cdn.jsdelivr.net")) {
  throw new Error("ASR worker 번들에 원격 실행 코드 fallback이 남아 있습니다.");
}
await writeFile(asrBundlePath, localOnlyAsrBundle);

const transformersDist = path.join(root, "node_modules", "@huggingface", "transformers", "dist");
for (const fileName of [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm"
]) {
  await copyFile(path.join(transformersDist, fileName), path.join(vendorRoot, fileName));
}

await Promise.all([
  copyFile(
    path.join(root, "legal", "THIRD_PARTY_NOTICES.md"),
    path.join(extensionRoot, "THIRD_PARTY_NOTICES.md")
  ),
  copyFile(
    path.join(root, "legal", "ONNXRUNTIME-MIT.txt"),
    path.join(licenseRoot, "ONNXRUNTIME-MIT.txt")
  ),
  copyFile(
    path.join(root, "node_modules", "@huggingface", "transformers", "LICENSE"),
    path.join(licenseRoot, "TRANSFORMERS-APACHE-2.0.txt")
  ),
  copyFile(
    path.join(root, "node_modules", "mediabunny", "LICENSE"),
    path.join(licenseRoot, "MEDIABUNNY-MPL-2.0.txt")
  )
]);

console.log(`Editor bundles and ONNX runtime assets written to ${path.relative(root, outputRoot)}`);
