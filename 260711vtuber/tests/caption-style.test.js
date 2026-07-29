import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPTION_FONT_REGISTRY,
  CAPTION_STYLE_PRESETS,
  DEFAULT_CAPTION_STYLE_PRESET_ID,
  LEGACY_CAPTION_STYLE_PRESET_ID,
  PAPERLOGY_CAPTION_STYLE_PRESET_ID,
  captionSpeakerColor,
  captionSpeakerColorAssignments,
  captionStyleDefaults,
  captionStylePreset,
  normalizeCaptionStylePresetId
} from "../extension/lib/caption-style.js";
import { EXTENSION_PACKAGE_FILES } from "../scripts/extension-package-files.mjs";
import { PAPERLOGY_FONT } from "../scripts/paperlogy-font.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Paperlogy asset manifest pins the official 1.001 source and local bytes", async () => {
  assert.equal(PAPERLOGY_FONT.version, "1.001");
  assert.equal(PAPERLOGY_FONT.upstreamCommit, "8ef35f53b318c7ca914c52b1b382b9a8bad07a61");
  assert.match(PAPERLOGY_FONT.upstreamUrl, /github\.com\/Freesentation\/paperlogy/);
  assert.equal(
    sha256(await readFile(new URL(`../${PAPERLOGY_FONT.sourceFontPath}`, import.meta.url))),
    PAPERLOGY_FONT.fontSha256
  );
  assert.equal(
    sha256(await readFile(new URL(`../${PAPERLOGY_FONT.sourceLicensePath}`, import.meta.url))),
    PAPERLOGY_FONT.licenseSha256
  );
});

test("Paperlogy distribution copy, license, CSS face, and package list stay wired", async () => {
  const [font, license, css] = await Promise.all([
    readFile(new URL(`../extension/${PAPERLOGY_FONT.extensionFontPath}`, import.meta.url)),
    readFile(new URL(`../extension/${PAPERLOGY_FONT.extensionLicensePath}`, import.meta.url)),
    readFile(new URL("../extension/editor/editor.css", import.meta.url), "utf8")
  ]);

  assert.equal(sha256(font), PAPERLOGY_FONT.fontSha256);
  assert.equal(sha256(license), PAPERLOGY_FONT.licenseSha256);
  assert.match(css, /font-family:\s*"Paperlogy"/);
  assert.match(css, /url\("fonts\/Paperlogy-8ExtraBold\.woff2"\)/);
  assert.ok(EXTENSION_PACKAGE_FILES.includes(PAPERLOGY_FONT.extensionFontPath));
  assert.ok(EXTENSION_PACKAGE_FILES.includes(PAPERLOGY_FONT.extensionLicensePath));
});

test("caption font registry contains licensed Paperlogy and the Pretendard legacy font", () => {
  assert.deepEqual(
    Object.keys(CAPTION_FONT_REGISTRY).sort(),
    ["paperlogy", "pretendard"]
  );
  assert.equal(CAPTION_FONT_REGISTRY.paperlogy.license, "SIL Open Font License 1.1");
  assert.equal(CAPTION_FONT_REGISTRY.paperlogy.version, "1.001");
  assert.equal(CAPTION_FONT_REGISTRY.pretendard.version, "1.3.9");
  assert.match(CAPTION_FONT_REGISTRY.paperlogy.licenseFile, /PAPERLOGY-OFL-1\.1\.txt$/);
  assert.equal(Object.isFrozen(CAPTION_FONT_REGISTRY.paperlogy), true);
});

test("clean preset exactly matches the measured typography in the user's finals", () => {
  const preset = captionStylePreset();

  assert.equal(preset.id, DEFAULT_CAPTION_STYLE_PRESET_ID);
  assert.equal(preset.fontId, "pretendard");
  assert.equal(preset.typography.fontFamily, "Pretendard");
  assert.equal(preset.typography.fontWeight, 800);
  assert.equal(preset.typography.fontScale, 0.0675);
  assert.equal(preset.typography.maxLines, 1);
  assert.equal(preset.paint.color, "#ffffff");
  assert.equal(preset.paint.backgroundColor, "transparent");
  assert.equal(preset.paint.outlineColor, "#111111");
  assert.equal(preset.paint.outlineWidth, 0.006);
  assert.equal(preset.placement.x, 0.5);
  assert.equal(preset.placement.y, 0.84);
  assert.equal(preset.measurement.sampleCount, 190);
  assert.equal(preset.measurement.selectedFontScale, preset.typography.fontScale);
  assert.equal(Object.isFrozen(preset.paint), true);
});

test("Paperlogy is an optional licensed style rather than a silent substitution", () => {
  const preset = captionStylePreset(PAPERLOGY_CAPTION_STYLE_PRESET_ID);

  assert.equal(preset.fontId, "paperlogy");
  assert.equal(preset.typography.fontFamily, "Paperlogy");
  assert.equal(preset.typography.maxLines, 1);
  assert.ok(preset.typography.fontScale >= 0.058);
  assert.ok(preset.typography.fontScale <= 0.063);
  assert.equal(preset.paint.backgroundColor, "transparent");
});

test("unknown presets fail closed to clean while legacy remains addressable", () => {
  assert.equal(normalizeCaptionStylePresetId("not-a-style"), DEFAULT_CAPTION_STYLE_PRESET_ID);
  assert.equal(
    normalizeCaptionStylePresetId(` ${LEGACY_CAPTION_STYLE_PRESET_ID} `),
    LEGACY_CAPTION_STYLE_PRESET_ID
  );
  assert.equal(captionStylePreset("not-a-style").id, DEFAULT_CAPTION_STYLE_PRESET_ID);
  assert.equal(
    captionStylePreset(LEGACY_CAPTION_STYLE_PRESET_ID),
    CAPTION_STYLE_PRESETS[LEGACY_CAPTION_STYLE_PRESET_ID]
  );
  assert.equal(
    CAPTION_STYLE_PRESETS[LEGACY_CAPTION_STYLE_PRESET_ID].typography.fontFamily,
    "Pretendard"
  );
});

test("flat defaults map directly to editor subtitle defaults", () => {
  const defaults = captionStyleDefaults();

  assert.equal(defaults.stylePresetId, DEFAULT_CAPTION_STYLE_PRESET_ID);
  assert.equal(defaults.fontFamily, "Pretendard");
  assert.equal(defaults.fontWeight, 800);
  assert.equal(defaults.fontScale, 0.0675);
  assert.equal(defaults.backgroundColor, "transparent");
  assert.equal(defaults.outlineColor, "#111111");
  assert.equal(defaults.x, 0.5);
  assert.equal(defaults.y, 0.84);
  defaults.color = "#000000";
  assert.equal(captionStyleDefaults().color, "#ffffff");
});

test("speaker colors keep main and unknown white and assign a stable distinct palette", () => {
  assert.equal(captionSpeakerColor("main"), "#ffffff");
  assert.equal(captionSpeakerColor("unknown"), "#ffffff");
  assert.equal(captionSpeakerColor("streamer"), "#ffffff");
  assert.equal(captionSpeakerColor(null), "#ffffff");
  assert.equal(captionSpeakerColor("speaker-0"), "#ffffff");
  assert.notEqual(captionSpeakerColor("speaker-1"), "#ffffff");
  assert.notEqual(captionSpeakerColor("speaker-1"), captionSpeakerColor("speaker-2"));
  assert.equal(captionSpeakerColor("speaker-8"), captionSpeakerColor("speaker-1"));
  assert.equal(captionSpeakerColor("guest:alice"), captionSpeakerColor("guest:alice"));
});

test("프로젝트 화자색 할당은 기존 색을 보존하고 팔레트 소진 전 서로 겹치지 않는다", () => {
  const assignments = captionSpeakerColorAssignments(
    ["main", "speaker-3", "guest", "charlie"],
    { "existing-guest": "#f06088" }
  );

  assert.equal(assignments.main, "#ffffff");
  assert.equal(assignments["existing-guest"], "#f06088");
  assert.equal(new Set([
    assignments["existing-guest"],
    assignments["speaker-3"],
    assignments.guest,
    assignments.charlie
  ]).size, 4);
  assert.deepEqual(
    captionSpeakerColorAssignments(["guest"], assignments),
    assignments
  );
});
