import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

const root = fileURLToPath(new URL("..", import.meta.url));
const jobDirectory = path.resolve(process.argv[2] || path.join(root, "beta-runs", "synthetic-codex-job"));
const referencePath = path.resolve(process.argv[3] || path.join(root, "beta-runs", "synthetic-reference.json"));
const videoPath = path.join(jobDirectory, "synthetic-full-video.mp4");
const generatedAt = new Date().toISOString();
const betaPythonPath = path.join(root, ".beta-tools", "venv", "bin", "python");
const betaModelDirectory = path.join(root, ".beta-tools", "models");

await stat(videoPath);
const reference = JSON.parse(await readFile(referencePath, "utf8"));
const [editingGuide, basePolicy, codexAgents, indexText] = await Promise.all([
  readFile(path.join(root, "extension", "knowledge", "base-editing-guidelines.md"), "utf8"),
  readFile(path.join(root, "extension", "knowledge", "default-creator-policy.md"), "utf8"),
  readFile(path.join(root, "extension", "knowledge", "codex-job-agents.md"), "utf8"),
  readFile(path.join(root, "extension", "knowledge", "creator-policy-index.json"), "utf8")
]);
const policyIndex = JSON.parse(indexText);
const streamerName = "합성 베타 진행자";
const resolvedPolicies = resolveCreatorPolicies({ streamerName }, policyIndex);
const syntheticPolicy = `# 합성 베타 원본 권리 확인

- 원본 영상은 이 저장소의 베타테스트를 위해 새로 생성한 합성 영상이다.
- 실제 방송인, 실제 아티스트, 실제 제3자 사람의 얼굴·목소리·콘텐츠를 포함하지 않는다.
- 제3자 음원이나 게임 화면을 포함하지 않는다.
- 로컬 비공개 전처리와 검수본 제작을 허용한다.
- 공개·업로드·수익화는 이 베타의 범위가 아니며 계속 차단한다.
- HUMAN_REVENUE_REVIEW: PENDING
- HUMAN_MUSIC_REVIEW: PENDING
- AUTOMATIC_PUBLICATION: BLOCKED`;
const creatorPolicy = `${compileCreatorPolicyMarkdown({
  basePolicyMarkdown: basePolicy,
  resolvedPolicies
})}\n\n---\n\n${syntheticPolicy}`;

const expectedById = Object.fromEntries(reference.expectedSessions.map((session) => [session.id, session]));
const semanticSession = expectedById["semantic-cut"];
const policySession = expectedById["policy-gates"];
if (!semanticSession || !policySession) {
  throw new Error("Synthetic reference is missing expected session boundaries.");
}

const segments = [
  createSegment({
    id: "beta-semantic-selection",
    startText: semanticSession.startSeconds.toFixed(3),
    endText: semanticSession.endSeconds.toFixed(3),
    description: "사용자가 선택한 이 경계를 그대로 유지하고, 범위 안의 한국어 자막 초안을 만들어줘."
  }),
  createSegment({
    id: "beta-policy-selection",
    startText: policySession.startSeconds.toFixed(3),
    endText: policySession.endSeconds.toFixed(3),
    description: "이 확정 구간 안에서 정책 관련 발화를 받아쓰고 비공개 검수본으로 만들어줘."
  })
];

const source = {
  platform: "LOCAL_SYNTHETIC_BETA",
  url: "local://synthetic-full-video.mp4",
  canonicalUrl: "local://synthetic-full-video.mp4",
  contentId: "synthetic-beta-v1",
  contentType: "vod",
  streamerName,
  broadcastTitle: "키리누키 말의 세션·정책 게이트 합성 베타",
  category: "synthetic-talk",
  observedAt: generatedAt
};
const projectName = "키리누키 Codex 합성 E2E 베타";
const globalInstruction = "합성 원본을 사용한 비공개 베타다. 두 사용자 확정 구간의 경계와 저장 순서를 바꾸지 말고 한국어 자막을 입혀라.";
const prompt = generateEditPrompt({
  projectName,
  source,
  globalInstruction,
  segments,
  editingGuideMarkdown: editingGuide,
  creatorPolicyMarkdown: creatorPolicy,
  resolvedCreatorPolicies: resolvedPolicies,
  generatedAt
});
const manifest = buildCodexJobManifest({
  projectName,
  source,
  globalInstruction,
  segments,
  resolvedCreatorPolicies: resolvedPolicies,
  generatedAt
});
manifest.status = "READY";
manifest.inputs.fullVideo.status = "PRESENT";
manifest.inputs.fullVideo.fileName = path.basename(videoPath);
manifest.inputs.fullVideo.sha256 = reference.video.sha256;

const startHere = `${generateCodexStartHere({ projectName, source, generatedAt })}

## 이 베타에 준비된 로컬 전사 도구

자세한 명령은 **LOCAL_BETA_TOOLS.md**를 읽으세요. 원본 미디어는 외부로 업로드하지 않고 faster-whisper를 CPU에서 실행합니다.
`;
const toolsGuide = `# 로컬 베타 도구

## 원본 전사

다음 명령을 작업 폴더에서 실행할 수 있습니다.

    HF_HUB_OFFLINE=1 ${betaPythonPath} tools/transcribe-beta.py synthetic-full-video.mp4 --json raw-transcript.json --srt raw-transcript.srt --model base --model-dir ${betaModelDirectory}

- 모델 저장 위치: ${betaModelDirectory}
- 실행 방식: CPU int8 / 한국어 고정 / word timestamps
- 첫 실행에서 모델 파일만 내려받으며 원본 영상은 외부 서비스로 전송하지 않습니다.
- raw-transcript 파일은 원본 타임라인용 중간 산출물입니다. 최종 subtitles.ko.srt는 편집본 타임라인으로 다시 계산해야 합니다.

## 미디어 도구

- ffprobe: 입력 스트림과 재생시간 확인
- ffmpeg: 무손상에 가까운 구간 추출, 연결, 자막 입히기와 MP4 렌더링
`;

await mkdir(path.join(jobDirectory, "tools"), { recursive: true });
await Promise.all([
  writeFile(path.join(jobDirectory, "edit-brief.md"), prompt, "utf8"),
  writeFile(path.join(jobDirectory, "creator-policy.md"), creatorPolicy, "utf8"),
  writeFile(path.join(jobDirectory, "creator-policy-index.json"), `${JSON.stringify(policyIndex, null, 2)}\n`, "utf8"),
  writeFile(
    path.join(jobDirectory, "AGENTS.md"),
    `${codexAgents}\n\n## 이 합성 베타의 추가 지침\n\n- LOCAL_BETA_TOOLS.md를 읽고 준비된 로컬 전사 도구를 사용한다.\n- 실제 방송인 콘텐츠로 오인하지 않는다.\n`,
    "utf8"
  ),
  writeFile(path.join(jobDirectory, "START_HERE.md"), startHere, "utf8"),
  writeFile(path.join(jobDirectory, "LOCAL_BETA_TOOLS.md"), toolsGuide, "utf8"),
  writeFile(path.join(jobDirectory, "job-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  copyFile(path.join(root, "scripts", "transcribe-beta.py"), path.join(jobDirectory, "tools", "transcribe-beta.py"))
]);

console.log(JSON.stringify({
  jobDirectory,
  video: path.basename(videoPath),
  videoSha256: reference.video.sha256,
  segments: segments.map(({ id, startSeconds, endSeconds, description }) => ({ id, startSeconds, endSeconds, description })),
  resolvedPolicies: resolvedPolicies.map(({ id, group }) => ({ id, group })),
  files: [
    "AGENTS.md",
    "START_HERE.md",
    "LOCAL_BETA_TOOLS.md",
    "edit-brief.md",
    "creator-policy.md",
    "creator-policy-index.json",
    "job-manifest.json",
    "synthetic-full-video.mp4",
    "tools/transcribe-beta.py"
  ]
}, null, 2));
