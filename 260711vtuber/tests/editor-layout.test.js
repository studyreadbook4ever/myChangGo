import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorHtmlUrl = new URL("../extension/editor.html", import.meta.url);
const editorCssUrl = new URL("../extension/editor/editor.css", import.meta.url);

function cssRule(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match, `${selector} CSS 규칙을 찾을 수 없습니다.`);
  return match[1];
}

function assertDeclaration(rule, property, valuePattern) {
  assert.match(
    rule,
    new RegExp(`${property}\\s*:\\s*${valuePattern}\\s*;`, "u"),
    `${property} 선언이 미리보기 레이아웃 계약과 다릅니다.`
  );
}

test("미리보기 영상은 원본 종횡비와 무관하게 stage 안에서 contain 된다", async () => {
  const [html, css] = await Promise.all([
    readFile(editorHtmlUrl, "utf8"),
    readFile(editorCssUrl, "utf8")
  ]);
  const stageRule = cssRule(css, ".stage");
  const videoRule = cssRule(css, ".preview-video");

  assert.match(
    html,
    /<video\s+id="preview-video"\s+class="preview-video preview-video-active"/u
  );
  assertDeclaration(stageRule, "position", "relative");
  assertDeclaration(stageRule, "min-height", "0");
  assertDeclaration(stageRule, "overflow", "hidden");

  assertDeclaration(videoRule, "position", "absolute");
  assertDeclaration(videoRule, "inset", "0");
  assertDeclaration(videoRule, "display", "block");
  assertDeclaration(videoRule, "min-width", "0");
  assertDeclaration(videoRule, "min-height", "0");
  assertDeclaration(videoRule, "width", "100%");
  assertDeclaration(videoRule, "height", "100%");
  assertDeclaration(videoRule, "max-width", "100%");
  assertDeclaration(videoRule, "max-height", "100%");
  assertDeclaration(videoRule, "object-fit", "contain");
  assertDeclaration(videoRule, "object-position", "center");
});
