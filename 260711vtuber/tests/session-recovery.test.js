import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecoverySessionSummaries,
  buildSavedEditorUrl,
  editorTabMatchesProject
} from "../extension/lib/session-recovery.js";

test("최근 편집은 projectId별 현재본과 임시저장 메타데이터만 안전하게 요약한다", () => {
  const sessions = buildRecoverySessionSummaries([
    {
      id: "project-old",
      name: "  오래된   프로젝트  ",
      updatedAt: "2026-07-28T01:00:00.000Z",
      clips: [{}, {}],
      subtitles: [{}],
      imageAssets: [],
      audioRegions: [{}],
      captionUpstageApiKey: "must-not-leak",
      ai: { providerApiKey: "also-must-not-leak" }
    },
    {
      id: "project-new",
      name: "새 프로젝트",
      updatedAt: "2026-07-29T02:00:00.000Z",
      clips: [{}],
      subtitles: [{}, {}, {}],
      imageAssets: [{}, {}],
      audioRegions: []
    }
  ], [
    {
      id: "draft-new",
      projectId: "project-new",
      reason: "auto",
      createdAtMs: Date.parse("2026-07-29T03:00:00.000Z"),
      project: { id: "project-new", name: "새 프로젝트" }
    },
    {
      id: "draft-old",
      projectId: "project-new",
      reason: "manual",
      createdAt: "2026-07-29T02:30:00.000Z",
      project: { id: "project-new", name: "새 프로젝트" }
    },
    {
      id: "wrong-project",
      projectId: "project-old",
      reason: "manual",
      createdAt: "2026-07-30T00:00:00.000Z",
      project: { id: "different-project" }
    }
  ]);

  assert.deepEqual(
    sessions.map((session) => session.projectId),
    ["project-new", "project-old"]
  );
  assert.deepEqual(sessions[0], {
    projectId: "project-new",
    title: "새 프로젝트",
    updatedAt: "2026-07-29T03:00:00.000Z",
    updatedAtMs: Date.parse("2026-07-29T03:00:00.000Z"),
    counts: {
      clips: 1,
      subtitles: 3,
      assets: 2,
      audio: 0
    },
    draftCount: 2,
    latestDraftReason: "auto",
    latestDraftAt: "2026-07-29T03:00:00.000Z"
  });
  assert.equal(sessions[1].title, "오래된 프로젝트");
  assert.deepEqual(sessions[1].counts, {
    clips: 2,
    subtitles: 1,
    assets: 0,
    audio: 1
  });
  assert.equal(sessions[1].draftCount, 0);
  assert.equal(
    JSON.stringify(sessions).includes("must-not-leak"),
    false
  );
  assert.deepEqual(
    buildRecoverySessionSummaries(
      [{ id: "a", updatedAt: "2026-01-01" }, { id: "b", updatedAt: "2026-01-02" }],
      [],
      { limit: 1 }
    ).map((session) => session.projectId),
    ["b"]
  );
});

test("저장 세션 URL은 원본 탭과 무관한 resume 모드와 선택적 복구 UI만 지정한다", () => {
  const editorRoot = "chrome-extension://abcdefghijklmnop/editor.html";
  const continueUrl = new URL(buildSavedEditorUrl(
    editorRoot,
    "project-한글"
  ));
  assert.equal(continueUrl.searchParams.get("project"), "project-한글");
  assert.equal(continueUrl.searchParams.get("session"), "resume");
  assert.equal(continueUrl.searchParams.has("recovery"), false);

  const recoveryUrl = new URL(buildSavedEditorUrl(
    editorRoot,
    "project-한글",
    { recoveryDrafts: true }
  ));
  assert.equal(recoveryUrl.searchParams.get("project"), "project-한글");
  assert.equal(recoveryUrl.searchParams.get("session"), "resume");
  assert.equal(recoveryUrl.searchParams.get("recovery"), "drafts");
  assert.throws(
    () => buildSavedEditorUrl(editorRoot, ""),
    /프로젝트 ID/
  );
});

test("같은 projectId의 정확한 extension editor 경로만 중복 탭으로 판정한다", () => {
  const editorRoot = "chrome-extension://abcdefghijklmnop/editor.html";
  assert.equal(
    editorTabMatchesProject(
      `${editorRoot}?project=project-1&session=resume`,
      editorRoot,
      "project-1"
    ),
    true
  );
  assert.equal(
    editorTabMatchesProject(
      `${editorRoot}?project=project-2`,
      editorRoot,
      "project-1"
    ),
    false
  );
  assert.equal(
    editorTabMatchesProject(
      "chrome-extension://abcdefghijklmnop/editor.html-old?project=project-1",
      editorRoot,
      "project-1"
    ),
    false
  );
  assert.equal(
    editorTabMatchesProject(
      "https://example.com/editor.html?project=project-1",
      editorRoot,
      "project-1"
    ),
    false
  );
  assert.equal(editorTabMatchesProject("not a url", editorRoot, "project-1"), false);
});
