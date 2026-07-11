import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  buildCodexJobManifest,
  compileCreatorPolicyMarkdown,
  createSegment,
  generateCodexStartHere,
  generateEditPrompt,
  resolveCreatorPolicies
} from "../extension/lib/core.js";

const root = path.resolve(import.meta.dirname, "..");
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
assert(manifest.host_permissions?.includes("https://chzzk.naver.com/*"), "치지직 host permission이 없습니다.");
assert(manifest.host_permissions?.includes("https://api.chzzk.naver.com/*"), "치지직 라이브 상태 메타데이터 permission이 없습니다.");
assert(manifest.content_scripts?.some((entry) => entry.matches?.includes("https://chzzk.naver.com/*")), "치지직 content script가 없습니다.");

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...manifest.content_scripts.flatMap((entry) => entry.js ?? []),
  "sidepanel.css",
  "sidepanel.js",
  "lib/core.js",
  "knowledge/base-editing-guidelines.md",
  "knowledge/default-creator-policy.md",
  "knowledge/codex-job-agents.md",
  "knowledge/creator-policy-index.json",
  "knowledge/creator-policies/charon-universe-w.md"
].filter(Boolean);

for (const relativePath of referencedFiles) {
  try {
    await access(path.join(extensionRoot, relativePath));
  } catch {
    errors.push(`필수 파일이 없습니다: ${relativePath}`);
  }
}

const [html, panelScript, contentScript, editingGuide, policyGuide, codexAgentGuide, policyIndexText, charonSnapshot] = await Promise.all([
  read("sidepanel.html"),
  read("sidepanel.js"),
  read("content-script.js"),
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
for (const fileName of ["AGENTS.md", "START_HERE.md", "edit-brief.md", "creator-policy.md", "creator-policy-index.json", "job-manifest.json"]) {
  assert(panelScript.includes(`"${fileName}"`), `Codex 작업 폴더 출력이 없습니다: ${fileName}`);
}
assert(contentScript.includes("HTMLVideoElement") || contentScript.includes("querySelectorAll(\"video\")"), "플레이어 시각 읽기 로직이 없습니다.");
assert(editingGuide.includes("의미적으로 함께 있어야"), "대화 세션 지침이 누락되었습니다.");
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
assert(codexAgentGuide.includes("의미가 완결되는 말의 세션"), "Codex 작업 규칙에 발화 세션 목표가 없습니다.");
assert(codexAgentGuide.includes("외부 서비스에 업로드하지 않는다"), "Codex 작업 규칙에 미디어 외부 업로드 금지가 없습니다.");
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
  console.log(`Extension 검증 통과: ${referencedFiles.length}개 필수 파일, 핵심 UI, MD 지침, 프롬프트 smoke test`);
}
