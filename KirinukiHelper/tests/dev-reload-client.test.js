import assert from "node:assert/strict";
import test from "node:test";

import {
  DEV_RELOAD_SCHEMA,
  devReloadProjectFingerprint,
  devReloadResumeUrl,
  devReloadStyleUrl,
  normalizeDevReloadMarker
} from "../src/editor/dev-reload.js";

test("브라우저 개발 marker는 완전한 로컬 형식만 허용한다", () => {
  const marker = normalizeDevReloadMarker({
    schema: DEV_RELOAD_SCHEMA,
    revision: " r-2 ",
    kind: "editor",
    changedFiles: ["src/editor/main.js", "src/editor/main.js"],
    pid: 12,
    createdAt: "2026-07-30T01:02:03.000Z"
  });
  assert.deepEqual(marker, {
    schema: DEV_RELOAD_SCHEMA,
    revision: "r-2",
    kind: "editor",
    changedFiles: ["src/editor/main.js"],
    pid: 12,
    createdAt: "2026-07-30T01:02:03.000Z"
  });
  assert.equal(normalizeDevReloadMarker({ ...marker, kind: "remote" }), null);
  assert.equal(normalizeDevReloadMarker({ ...marker, revision: "" }), null);
  assert.equal(normalizeDevReloadMarker({ ...marker, pid: 0 }), null);
});

test("재로드 URL은 오래된 capture seed를 제거하고 CURRENT 복원만 지정한다", () => {
  assert.equal(
    devReloadResumeUrl(
      "chrome-extension://abcdefghijkl/editor.html?project=old&recovery=drafts&dev=1#x",
      "project 7"
    ),
    "chrome-extension://abcdefghijkl/editor.html?project=project+7&session=resume&dev=1#x"
  );
  assert.equal(
    devReloadResumeUrl(
      "chrome-extension://abcdefghijkl/editor.html?project=old",
      "project-plain"
    ),
    "chrome-extension://abcdefghijkl/editor.html?project=project-plain&session=resume"
  );
});

test("CSS URL에는 해당 build revision만 cache bust로 넣는다", () => {
  assert.equal(
    devReloadStyleUrl(
      "chrome-extension://abcdefghijkl/editor/editor.css?old=kept",
      "revision 3"
    ),
    "chrome-extension://abcdefghijkl/editor/editor.css?old=kept&dev-reload=revision+3"
  );
});

test("프로젝트 fingerprint는 객체 key 순서와 undefined에 흔들리지 않는다", () => {
  const first = {
    id: "project",
    clips: [{ sourceEndMs: 2000, sourceStartMs: 1000 }],
    ignored: undefined
  };
  const second = {
    clips: [{ sourceStartMs: 1000, sourceEndMs: 2000 }],
    id: "project"
  };
  assert.equal(
    devReloadProjectFingerprint(first),
    devReloadProjectFingerprint(second)
  );
  assert.notEqual(
    devReloadProjectFingerprint(first),
    devReloadProjectFingerprint({ ...second, id: "other" })
  );
});
