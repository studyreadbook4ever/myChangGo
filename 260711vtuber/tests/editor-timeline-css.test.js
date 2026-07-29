import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorCss = await readFile(
  new URL("../extension/editor/editor.css", import.meta.url),
  "utf8"
);

test("짧은 자막·에셋 블록도 양쪽 손잡이 사이에 몸체 drag 영역을 남긴다", () => {
  const adaptiveHandleRule = editorCss.match(
    /\.asset-block \.trim-handle,\s*\.cue-block \.trim-handle\s*\{([^}]*)\}/u
  );
  assert.ok(adaptiveHandleRule, "자막·에셋 전용 손잡이 규칙이 필요합니다.");
  const percentage = Number(
    adaptiveHandleRule[1].match(/width:\s*min\(\s*14px,\s*(\d+)%\s*\)/u)?.[1]
  );
  assert.ok(
    Number.isFinite(percentage) && percentage > 0 && percentage < 50,
    "양쪽 손잡이가 짧은 블록 몸체 전체를 덮지 않아야 합니다."
  );
  assert.match(
    editorCss,
    /\.asset-block \.trim-handle\.left,\s*\.cue-block \.trim-handle\.left\s*\{[^}]*left:\s*0;/u
  );
  assert.match(
    editorCss,
    /\.asset-block \.trim-handle\.right,\s*\.cue-block \.trim-handle\.right\s*\{[^}]*right:\s*0;/u
  );
});
