import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildCodexJobManifest,
  compileCreatorPolicyMarkdown,
  createSegment,
  generateCodexStartHere,
  generateEditPrompt,
  resolveCreatorPolicies
} from "../extension/lib/core.js";
import { EXTENSION_PACKAGE_FILES } from "./extension-package-files.mjs";
import { PAPERLOGY_FONT } from "./paperlogy-font.mjs";
import { PRETENDARD_FONT } from "./pretendard-font.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = path.join(root, "extension");

const errors = [];
const assert = (condition, message) => {
  if (!condition) {
    errors.push(message);
  }
};

const read = (relativePath) => readFile(path.join(extensionRoot, relativePath), "utf8");

const manifest = JSON.parse(await read("manifest.json"));
assert(manifest.manifest_version === 3, "manifest_version은 3이어야 합니다.");
assert(manifest.side_panel?.default_path === "sidepanel.html", "사이드패널 진입점이 없습니다.");
assert(manifest.version === "2.2.0", "통합 편집기 manifest 버전이 2.2.0이 아닙니다.");
assert(manifest.host_permissions?.includes("https://chzzk.naver.com/*"), "치지직 host permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://api.chzzk.naver.com/*"), "치지직 라이브 상태 메타데이터 permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://youtube.com/*"), "YouTube 루트 영상 permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://www.youtube.com/*"), "YouTube 영상 permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://m.youtube.com/*"), "YouTube 모바일 영상 permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://youtu.be/*"), "youtu.be 영상 permission이 없습니다.");
assert(manifest.host_permissions?.includes("http://127.0.0.1/*"), "로컬 자막 에이전트 permission이 없습니다.");
assert(manifest.optional_host_permissions?.includes("https://*/*"), "사용자 선택 HTTPS 자막 에이전트 permission이 없습니다.");
assert(!manifest.host_permissions?.some((permission) => permission.includes("huggingface") || permission.includes("hf.co")), "삭제한 로컬 모델의 Hugging Face permission이 남아 있습니다.");
assert(manifest.content_scripts?.some((entry) => entry.matches?.includes("https://chzzk.naver.com/*")), "치지직 content script가 없습니다.");
assert(manifest.content_scripts?.some((entry) => entry.matches?.includes("https://youtube.com/*")), "YouTube 루트 content script가 없습니다.");
assert(manifest.content_scripts?.some((entry) => entry.matches?.includes("https://www.youtube.com/*")), "YouTube content script가 없습니다.");
assert(!manifest.content_security_policy?.extension_pages?.includes("'wasm-unsafe-eval'"), "삭제한 로컬 ONNX용 wasm-unsafe-eval CSP가 남아 있습니다.");

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...manifest.content_scripts.flatMap((entry) => entry.js ?? []),
  "sidepanel.css",
  "sidepanel.js",
  "editor.html",
  "editor/editor.css",
  "editor/editor.js",
  PAPERLOGY_FONT.extensionFontPath,
  PRETENDARD_FONT.extensionFontPath,
  "lib/core.js",
  "lib/editor-core.js",
  "lib/source-platform.js",
  "knowledge/base-editing-guidelines.md",
  "knowledge/default-creator-policy.md",
  "knowledge/codex-job-agents.md",
  "knowledge/creator-policy-index.json",
  "knowledge/creator-policies/charon-universe-w.md",
  "THIRD_PARTY_NOTICES.md",
  "licenses/MEDIABUNNY-MPL-2.0.txt",
  PAPERLOGY_FONT.extensionLicensePath,
  PRETENDARD_FONT.extensionLicensePath,
  ...EXTENSION_PACKAGE_FILES
].filter(Boolean);

const uniqueReferencedFiles = [...new Set(referencedFiles)];
for (const relativePath of uniqueReferencedFiles) {
  try {
    await access(path.join(extensionRoot, relativePath));
  } catch {
    errors.push(`필수 파일이 없습니다: ${relativePath}`);
  }
}

for (const relativePath of [
  "editor/asr-worker.js",
  "editor/vendor/ort-wasm-simd-threaded.jsep.mjs",
  "editor/vendor/ort-wasm-simd-threaded.jsep.wasm",
  "licenses/ONNXRUNTIME-MIT.txt",
  "licenses/TRANSFORMERS-APACHE-2.0.txt"
]) {
  try {
    await access(path.join(extensionRoot, relativePath));
    errors.push(`삭제한 로컬 음성인식 파일이 남아 있습니다: ${relativePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      errors.push(`삭제 파일 확인 실패: ${relativePath} (${error.message})`);
    }
  }
}

for (const [label, relativePath, expectedSha256] of [
  ["Pretendard", PRETENDARD_FONT.extensionFontPath, PRETENDARD_FONT.fontSha256],
  ["Pretendard", PRETENDARD_FONT.extensionLicensePath, PRETENDARD_FONT.licenseSha256],
  ["Paperlogy", PAPERLOGY_FONT.extensionFontPath, PAPERLOGY_FONT.fontSha256],
  ["Paperlogy", PAPERLOGY_FONT.extensionLicensePath, PAPERLOGY_FONT.licenseSha256]
]) {
  let file;
  try {
    file = await readFile(path.join(extensionRoot, relativePath));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      errors.push(`${label} 배포 파일 읽기 실패: ${relativePath} (${error.message})`);
    }
    continue;
  }
  const actualSha256 = createHash("sha256").update(file).digest("hex");
  assert(
    actualSha256 === expectedSha256,
    `${label} 배포 파일 무결성 검증 실패: ${relativePath} (${actualSha256})`
  );
}

const [html, panelScript, contentScript, editorHtml, editorScript, serviceWorker, editingGuide, policyGuide, codexAgentGuide, policyIndexText, charonSnapshot] = await Promise.all([
  read("sidepanel.html"),
  read("sidepanel.js"),
  read("content-script.js"),
  read("editor.html"),
  read("editor/editor.js"),
  read("service-worker.js"),
  read("knowledge/base-editing-guidelines.md"),
  read("knowledge/default-creator-policy.md"),
  read("knowledge/codex-job-agents.md"),
  read("knowledge/creator-policy-index.json"),
  read("knowledge/creator-policies/charon-universe-w.md")
]);
const policyIndex = JSON.parse(policyIndexText);

for (const id of [
  "start-time",
  "end-time",
  "capture-start",
  "capture-end",
  "segment-description",
  "save-segment",
  "policy-match-badge",
  "create-codex-job",
  "open-editor",
  "generate-prompt",
  "copy-prompt",
  "download-prompt"
]) {
  assert(html.includes(`id="${id}"`), `필수 UI 요소가 없습니다: #${id}`);
}

assert(panelScript.includes("knowledge/base-editing-guidelines.md"), "편집 지침 MD를 읽지 않습니다.");
assert(panelScript.includes("knowledge/default-creator-policy.md"), "정책 초안 MD를 읽지 않습니다.");
assert(panelScript.includes("knowledge/codex-job-agents.md"), "Codex 작업 규칙 MD를 읽지 않습니다.");
assert(panelScript.includes("knowledge/creator-policy-index.json"), "방송인 정책 인덱스를 읽지 않습니다.");
assert(panelScript.includes("compileCreatorPolicyMarkdown"), "매칭된 공식 정책 링크를 프롬프트에 결합하지 않습니다.");
assert(panelScript.includes("creator-policy-index.json"), "Codex 작업폴더에 정책 관계 인덱스를 쓰지 않습니다.");
assert(panelScript.includes("writePolicyCacheFiles"), "선택 정책 캐시를 별도 파일로 쓰는 로직이 없습니다.");
assert(panelScript.includes("showDirectoryPicker"), "Codex 작업 폴더 선택 로직이 없습니다.");
assert(panelScript.includes("KIRINUKI_OPEN_EDITOR"), "사이드패널에서 통합 편집기를 열지 않습니다.");
assert(panelScript.includes("captureStateSourceConflict"), "서로 다른 방송의 캡처 구간 혼합 방지가 없습니다.");
const saveSegmentSource = panelScript.slice(
  panelScript.indexOf("async function saveSegment()"),
  panelScript.indexOf("async function saveSegment()") + 800
);
assert(
  saveSegmentSource.includes("if (sourceConflict)"),
  "다른 방송 감지 중 수동 시각 구간 저장이 차단되지 않습니다."
);
assert(panelScript.includes("precision: 3"), "사용자 확정 컷의 밀리초 정밀도 보존이 없습니다.");
assert(panelScript.includes("KIRINUKI_RESET_BINDINGS"), "초기화 시 치지직 탭 연결을 지우지 않습니다.");
assert(panelScript.includes("KIRINUKI_PERSIST_STATE"), "사이드패널 저장이 공용 직렬화 경로를 사용하지 않습니다.");
assert(panelScript.includes("WORKSPACE_META_KEY"), "다중 창 프로젝트 revision 추적이 없습니다.");
assert(panelScript.includes("chrome.storage.onChanged"), "다른 창의 프로젝트 변경을 반영하지 않습니다.");
assert(panelScript.includes("mergeDirtyFields"), "다른 창 변경 중 현재 입력을 보존하지 않습니다.");
assert(panelScript.includes("samePersistedSource"), "주기적 문맥 갱신이 의미 없는 저장 revision을 만들 수 있습니다.");
assert(panelScript.includes("lastPersistedStateSignature"), "변경 없는 숨김·새로고침 저장을 건너뛰지 않습니다.");
assert(
  panelScript.includes("expectedResetEpoch") && panelScript.includes("expectedRevision"),
  "오래된 창의 저장·편집기 열기 요청을 판별하지 않습니다."
);
for (const fileName of ["AGENTS.md", "START_HERE.md", "edit-brief.md", "creator-policy.md", "creator-policy-index.json", "job-manifest.json"]) {
  assert(panelScript.includes(`"${fileName}"`), `Codex 작업 폴더 출력이 없습니다: ${fileName}`);
}
assert(contentScript.includes("HTMLVideoElement") || contentScript.includes("querySelectorAll(\"video\")"), "플레이어 시각 읽기 로직이 없습니다.");
assert(contentScript.includes("KIRINUKI_PLAYER_COMMAND"), "편집기에서 치지직 플레이어를 제어하는 프로토콜이 없습니다.");
assert(contentScript.includes("/service/v3/videos/"), "치지직 다시보기 회차 메타데이터 연결 로직이 없습니다.");
assert(contentScript.includes("liveOpenDate"), "다시보기를 생방송 회차에 연결할 시작 시각 로직이 없습니다.");
assert(contentScript.includes("youtube-ad-blocked"), "YouTube 광고 시각 캡처 차단이 없습니다.");
assert(contentScript.includes("youtube-live-in-progress"), "진행 중인 YouTube 라이브 캡처 차단이 없습니다.");
assert(contentScript.includes("www.youtube.com/watch"), "YouTube 영상 canonical 연결 로직이 없습니다.");
assert(serviceWorker.includes("KIRINUKI_EDITOR_SOURCE_ACTION"), "서비스 워커에 치지직 source binding 중계가 없습니다.");
assert(serviceWorker.includes("sourceSessionIdentity"), "서비스 워커가 방송 회차 ID를 검증하지 않습니다.");
assert(serviceWorker.includes("KIRINUKI_GET_CONTEXT"), "서비스 워커가 현재 치지직 탭 문맥을 재검증하지 않습니다.");
assert(serviceWorker.includes("KIRINUKI_RESET_BINDINGS"), "서비스 워커에 source binding 초기화가 없습니다.");
assert(serviceWorker.includes("KIRINUKI_PERSIST_STATE"), "서비스 워커에 프로젝트 저장 직렬화가 없습니다.");
assert(serviceWorker.includes("queueWorkspaceOperation"), "저장·열기·초기화 공용 직렬화 큐가 없습니다.");
assert(serviceWorker.includes("indexedDB.deleteDatabase"), "편집 프로젝트 초기화 경로가 없습니다.");
assert(
  serviceWorker.includes("expectedResetEpoch") && serviceWorker.includes("expectedRevision"),
  "서비스 워커가 오래된 창의 프로젝트 요청을 거부하지 않습니다."
);
assert(
  serviceWorker.includes('caches.delete(LEGACY_TRANSFORMERS_CACHE_NAME)'),
  "이전 로컬 Whisper 모델 캐시의 제한적 삭제 경로가 없습니다."
);
for (const id of [
  "preview-video",
  "image-asset-overlays",
  "subtitle-overlays",
  "video-track",
  "asset-track",
  "audio-track",
  "caption-tracks",
  "add-audio-region",
  "add-subtitle-lane",
  "timeline-context-menu",
  "cue-text",
  "cue-review-note",
  "cue-start",
  "cue-end",
  "cue-x",
  "cue-y",
  "font-color",
  "asset-mode-tab",
  "asset-paste",
  "asset-input",
  "asset-start",
  "asset-end",
  "asset-x",
  "asset-y",
  "asset-scale",
  "asset-opacity",
  "audio-volume",
  "audio-mute",
  "caption-agent-endpoint",
  "caption-agent-token",
  "caption-stt-endpoint",
  "caption-stt-model",
  "caption-stt-api-key",
  "caption-upstage-api-key",
  "clear-caption-provider-keys",
  "caption-style-preset",
  "caption-model",
  "caption-advanced-settings",
  "test-caption-agent",
  "caption-agent-warning",
  "generate-captions",
  "create-local-draft",
  "open-local-drafts",
  "clip-group-toolbar",
  "clip-group-status",
  "move-selected-clips-up",
  "move-selected-clips-down",
  "clear-clip-group-selection",
  "local-draft-dialog",
  "local-draft-list",
  "restore-local-draft",
  "close-local-draft-dialog",
  "export-video",
  "source-offset",
  "apply-source-offset"
]) {
  assert(editorHtml.includes(`id="${id}"`), `통합 편집기 UI 요소가 없습니다: #${id}`);
}
assert(editorScript.includes("renderProjectVideo"), "편집기 번들에 영상 렌더 경로가 없습니다.");
assert(editorScript.includes("extractClipPcm16k"), "편집기 번들에 선택 구간 음성 추출 경로가 없습니다.");
assert(editorScript.includes("requestCaptionAgent"), "편집기 번들에 외부 자막 에이전트 요청 경로가 없습니다.");
assert(editorScript.includes("solar-pro3"), "편집기 번들에 Solar Pro 3 기본 모델이 없습니다.");
assert(editorScript.includes("solar-mini"), "편집기 번들에 Solar Mini 선택 모델이 없습니다.");
assert(editorScript.includes("MAX_REMOTE_CUE_DURATION_MS = 4e3"), "원격 자막 4초 상한 검증이 없습니다.");
assert(editorScript.includes("encodePcm16WavBase64"), "선택 구간 PCM을 표준 WAV 요청으로 바꾸지 않습니다.");
assert(editorScript.includes("ensureCaptionAgentPermission"), "사용자 선택 원격 에이전트 권한 요청 경로가 없습니다.");
assert(editorScript.includes("captionProviderHeaders"), "로컬 companion 제공자 API 키 전달 경로가 없습니다.");
assert(
  editorScript.includes("MAX_CAPTION_AGENT_CLIPS_PER_RUN = 16")
    && editorScript.includes("captionAgentResumePlan")
    && editorScript.includes("captionCheckpoints"),
  "16컷 유료 요청 가드 또는 실패 지점 재개 체크포인트가 없습니다."
);
assert(
  editorScript.includes("isLoopbackCaptionAgentEndpoint")
    && editorScript.includes("if (!isLoopbackCaptionAgentEndpoint(endpoint))"),
  "API 키의 원격 에이전트 유출 차단이 없습니다."
);
assert(
  editorScript.includes("pairCaptionAgent")
    && editorScript.includes("bearer-process-memory"),
  "로컬 companion 메모리 세션 자동 연결 경로가 없습니다."
);
assert(editorScript.includes("showDirectoryPicker"), "영상·JSON·SRT 동일 폴더 저장 경로가 없습니다.");
assert(editorScript.includes("chooseUniqueExportBaseName"), "내보내기 파일명 충돌 방지가 없습니다.");
assert(editorScript.includes("navigator.locks"), "여러 편집기 탭의 동시 내보내기 직렬화가 없습니다.");
assert(editorScript.includes("fileHandleStored"), "원본 파일 핸들 복구 상태를 검증하지 않습니다.");
assert(editorScript.includes("findSubtitleOverlaps"), "겹치는 자막 내보내기 방지가 없습니다.");
assert(editorScript.includes("cuesAtTimeline"), "다른 레인의 동시 자막 미리보기 경로가 없습니다.");
assert(editorScript.includes("addSubtitleLane"), "자막 레인 증설 경로가 없습니다.");
assert(editorScript.includes("openTimelineContextMenu"), "자막·음성 우클릭 편집 경로가 없습니다.");
assert(editorScript.includes("updateAudioRegion"), "구간별 음성 설정 저장 경로가 없습니다.");
assert(editorScript.includes("applyAudioAutomationToSample"), "구간별 음성 설정 렌더 경로가 없습니다.");
assert(editorScript.includes("findAudioRegionOverlaps"), "겹치는 음성 설정 구간 방지가 없습니다.");
assert(
  editorScript.includes("saveLocalDraft") &&
    editorScript.includes("restoreLocalDraft") &&
    editorScript.includes("LOCAL_DRAFT_AUTOSAVE_INTERVAL_MS"),
  "수동·5분 자동·복원 직전 로컬 임시저장 경로가 없습니다."
);
assert(editorScript.includes("imageAssetsAtTimeline"), "이미지 에셋 미리보기 경로가 없습니다.");
assert(
  editorScript.includes("saveProjectWithImageAssetBlob"),
  "이미지 에셋 Blob과 프로젝트의 원자적 IndexedDB 저장 경로가 없습니다."
);
assert(editorScript.includes("loadImageAssetBlob"), "저장된 이미지 에셋 Blob 복원 경로가 없습니다.");
assert(editorScript.includes("resolveImageAsset"), "이미지 에셋을 영상 렌더러로 전달하는 경로가 없습니다.");
assert(
  editorScript.includes('addEventListener("paste"') &&
    editorScript.includes("ALLOWED_IMAGE_ASSET_TYPES"),
  "웹 이미지 복사·붙여넣기의 안전한 이미지 전용 경로가 없습니다."
);
assert(
  editorScript.includes("updateSubtitleCue(originalProject"),
  "자막 양끝 손잡이가 drag 시작 시점 기준으로 안정적으로 움직이지 않습니다."
);
assert(
  editorScript.includes("pendingPreviewSeek") &&
    editorScript.includes("retryWhenAvailable"),
  "비영점 PTS 원본의 첫 미리보기 seek 재시도 경로가 없습니다."
);
assert(
  editorScript.includes("updateClipTrim(originalProject"),
  "컷 손잡이를 되돌릴 때 중간 이동에서 잘린 사람 자막을 복구하지 못합니다."
);
assert(
  editorScript.includes("activeJobCancelable") &&
    editorScript.includes('onProgress(0.995, "finalize")'),
  "파일 commit 단계의 취소 불가 전환이 없습니다."
);
assert(editorHtml.includes('value="solar-pro3" selected'), "Solar Pro 3가 자막 기본 모델로 선택되지 않았습니다.");
assert(editorHtml.includes('option value="solar-mini"'), "Solar Mini 선택지가 없습니다.");
assert(!editorHtml.includes('option value="solar-pro2"'), "사용하지 않는 Solar Pro 2 선택지가 남아 있습니다.");
assert(editorHtml.includes('id="caption-advanced-settings"'), "STT·companion 세부설정 접기가 없습니다.");
assert(editorHtml.includes("자막 하나는 최대 4초"), "편집기 UI에 4초 자막 원칙이 없습니다.");
assert(!editorScript.toLowerCase().includes("xenova/whisper"), "편집기 번들에 로컬 Whisper 모델 경로가 남아 있습니다.");
assert(editingGuide.includes("authority: USER"), "사용자 확정 컷 권한 지침이 누락되었습니다.");
assert(editingGuide.includes("자동으로 확장·축소·병합·삭제하지 않는다"), "AI의 컷 경계 보존 지침이 누락되었습니다.");
assert(policyGuide.includes("특정 방송인의 허락을 대신하지 않는다"), "기본 정책의 비허가 고지가 없습니다.");
assert(policyGuide.includes("HUMAN_REVENUE_REVIEW: PENDING"), "수익 사람 검수 게이트가 없습니다.");
assert(policyGuide.includes("HUMAN_MUSIC_REVIEW: PENDING"), "음원 사람 검수 게이트가 없습니다.");
assert(policyGuide.includes("제3자의 정책을 **무조건 교차확인**"), "제3자 정책 교차확인 규칙이 없습니다.");
for (const policyLink of [
  "https://cafe.naver.com/tteokbokk1/709417",
  "https://cafe.naver.com/vkpopstar/1174",
  "https://cafe.naver.com/projectiofficial/2",
  "https://cafe.naver.com/otwoffical/6121",
  "https://cafe.naver.com/listellaofficial/3"
]) {
  assert(policyGuide.includes(policyLink), `아티스트 정책 링크가 없습니다: ${policyLink}`);
}
assert(codexAgentGuide.includes("authority: USER"), "Codex 작업 규칙에 사용자 확정 컷 권한이 없습니다.");
assert(codexAgentGuide.includes("사용자 확정 컷의 16kHz 음성"), "Codex 작업 규칙에 자막 에이전트 전송 범위가 없습니다.");
assert(codexAgentGuide.includes("전체 원본 영상"), "Codex 작업 규칙에 전체 원본 외부 업로드 금지가 없습니다.");
assert(Array.isArray(policyIndex.policies) && policyIndex.policies.length === 5, "방송인 정책 인덱스가 5개 그룹을 포함하지 않습니다.");
const arisaPolicies = resolveCreatorPolicies({ streamerName: "아리사" }, policyIndex);
assert(arisaPolicies.length === 1 && arisaPolicies[0].id === "charon-universe-w", "아리사를 카론유니버스W 정책에 매칭하지 못합니다.");
assert(arisaPolicies[0]?.sourceUrl === "https://cafe.naver.com/vkpopstar/1174", "아리사 정책 출처가 올바르지 않습니다.");
assert(charonSnapshot.includes("캐시 역할: `FALLBACK_ONLY`"), "카론유니버스W 선택 정책 캐시의 권한 표시가 없습니다.");
assert(!html.includes("http://") && !html.includes("https://"), "Extension UI에 원격 코드 또는 원격 자산을 넣지 마세요.");

try {
  const smokeSegment = createSegment({ startText: "10", endText: "20", description: "테스트 구간" });
  const smokePrompt = generateEditPrompt({
    source: { platform: "CHZZK", url: "https://chzzk.naver.com/test" },
    segments: [smokeSegment],
    editingGuideMarkdown: editingGuide,
    creatorPolicyMarkdown: policyGuide,
    generatedAt: "2026-07-11T00:00:00.000Z"
  });
  assert(smokePrompt.includes("Codex 영상 전처리 작업 요청서"), "프롬프트 제목이 없습니다.");
  assert(smokePrompt.includes("테스트 구간"), "사용자 설명이 프롬프트에 포함되지 않았습니다.");
  assert(smokePrompt.includes("policy-check.md"), "정책 프리플라이트 산출물이 프롬프트에 없습니다.");

  const compiledArisaPolicy = compileCreatorPolicyMarkdown({
    basePolicyMarkdown: policyGuide,
    resolvedPolicies: arisaPolicies
  });
  const arisaPrompt = generateEditPrompt({
    source: { platform: "CHZZK", streamerName: "아리사" },
    segments: [smokeSegment],
    creatorPolicyMarkdown: compiledArisaPolicy,
    resolvedCreatorPolicies: arisaPolicies,
    generatedAt: "2026-07-12T00:00:00.000Z"
  });
  assert(arisaPrompt.includes("아리사 → 카론유니버스W"), "아리사 작업 프롬프트에 정책 매칭 결과가 없습니다.");
  assert(arisaPrompt.includes("https://cafe.naver.com/vkpopstar/1174"), "아리사 작업 프롬프트에 공식 정책 링크가 없습니다.");
  assert(arisaPrompt.includes("policy-cache/charon-universe-w.md"), "아리사 작업 프롬프트에 선택 캐시 위치가 없습니다.");
  assert(!arisaPrompt.includes("클립 기반 2차적 저작물"), "정책 캐시 본문이 아리사 작업 프롬프트에 삽입됐습니다.");

  const smokeManifest = buildCodexJobManifest({
    source: { platform: "CHZZK", url: "https://chzzk.naver.com/test" },
    segments: [smokeSegment],
    generatedAt: "2026-07-11T00:00:00.000Z"
  });
  assert(smokeManifest.inputs.fullVideo.expectedCount === 1, "작업 manifest의 원본 영상 규칙이 잘못되었습니다.");
  assert(smokeManifest.inputs.creatorPolicyIndex === "creator-policy-index.json", "작업 manifest의 정책 관계 인덱스가 없습니다.");
  assert(smokeManifest.inputs.creatorPolicyCache.authority === "FALLBACK_ONLY", "작업 manifest의 정책 캐시 권한이 잘못되었습니다.");
  assert(smokeManifest.execution.requiredOutputs.length === 5, "작업 manifest의 필수 산출물 수가 잘못되었습니다.");

  const startHere = generateCodexStartHere({ generatedAt: "2026-07-11T00:00:00.000Z" });
  assert(startHere.includes("이 폴더의 AGENTS.md"), "START_HERE의 한 문장 시작 지시가 없습니다.");
} catch (error) {
  errors.push(`프롬프트 smoke test 실패: ${error.message}`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Extension 검증 통과: ${uniqueReferencedFiles.length}개 필수 파일, 핵심 UI, MD 지침, 프롬프트 smoke test`);
}
