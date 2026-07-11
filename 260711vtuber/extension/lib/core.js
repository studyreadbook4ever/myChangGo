export const SCHEMA_VERSION = "chzzk-kirinuki-edit-brief/v1";
export const CODEX_JOB_SCHEMA_VERSION = "chzzk-kirinuki-codex-job/v1";
export const STORAGE_KEY = "chzzkKirinukiProjectV1";

const nowIso = () => new Date().toISOString();

export function createInitialState() {
  return {
    schemaVersion: 1,
    projectName: "",
    source: {
      platform: "CHZZK",
      url: "",
      canonicalUrl: "",
      channelId: "",
      contentId: "",
      contentType: "unknown",
      streamerName: "",
      broadcastTitle: "",
      broadcastStartedAt: "",
      clipActive: null,
      timeMachineActive: null,
      category: "",
      observedAt: ""
    },
    globalInstruction: "",
    draft: {
      startText: "",
      endText: "",
      description: "",
      startCapture: null,
      endCapture: null,
      editingId: null
    },
    segments: [],
    updatedAt: nowIso()
  };
}

export function normalizeState(raw) {
  const initial = createInitialState();
  if (!raw || typeof raw !== "object") {
    return initial;
  }

  return {
    ...initial,
    ...raw,
    source: { ...initial.source, ...(raw.source ?? {}) },
    draft: { ...initial.draft, ...(raw.draft ?? {}) },
    segments: Array.isArray(raw.segments) ? raw.segments : []
  };
}

export function parseTimestamp(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  const input = String(value ?? "").trim();
  if (!input) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(input)) {
    const seconds = Number(input);
    return Number.isFinite(seconds) ? seconds : null;
  }

  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = numbers;
    if (seconds >= 60) {
      return null;
    }
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  if (minutes >= 60 || seconds >= 60) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(value, { precision = 0 } = {}) {
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return "--:--:--";
  }

  const factor = 10 ** precision;
  const rounded = Math.round(parsed * factor) / factor;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded - hours * 3600 - minutes * 60;
  const wholeSeconds = Math.floor(seconds);
  const fraction = precision > 0 ? `.${String(Math.round((seconds - wholeSeconds) * factor)).padStart(precision, "0")}` : "";

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(wholeSeconds).padStart(2, "0")}${fraction}`
  ].join(":");
}

export function validateSegmentInput({ startText, endText, description }) {
  const startSeconds = parseTimestamp(startText);
  const endSeconds = parseTimestamp(endText);
  const note = String(description ?? "").trim();

  if (startSeconds === null) {
    return { ok: false, message: "시작 시각을 HH:MM:SS 또는 초 단위로 입력해 주세요." };
  }
  if (endSeconds === null) {
    return { ok: false, message: "끝 시각을 HH:MM:SS 또는 초 단위로 입력해 주세요." };
  }
  if (endSeconds <= startSeconds) {
    return { ok: false, message: "끝 시각은 시작 시각보다 뒤여야 합니다." };
  }
  if (!note) {
    return { ok: false, message: "이 구간을 선택한 이유나 원하는 편집 방향을 자연어로 적어 주세요." };
  }

  return { ok: true, startSeconds, endSeconds, description: note };
}

export function createSegment({
  id = crypto.randomUUID(),
  startText,
  endText,
  description,
  startCapture = null,
  endCapture = null,
  createdAt = nowIso()
}) {
  const validation = validateSegmentInput({ startText, endText, description });
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  return {
    id,
    startSeconds: validation.startSeconds,
    endSeconds: validation.endSeconds,
    description: validation.description,
    startCapture,
    endCapture,
    createdAt,
    updatedAt: createdAt
  };
}

export function safeInline(value, fallback = "미확인") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

export function markdownQuote(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "> (입력 없음)";
  }
  return text.split(/\r?\n/).map((line) => `> ${line || " "}`).join("\n");
}

export function sanitizeFileName(value, fallback = "chzzk-kirinuki-edit-brief") {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function normalizeCreatorIdentity(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveCreatorPolicies({ streamerName = "", additionalNames = [] } = {}, policyIndex = {}) {
  const names = [streamerName, ...(Array.isArray(additionalNames) ? additionalNames : [])]
    .map(normalizeCreatorIdentity)
    .filter(Boolean);
  const uniqueNames = [...new Set(names)];
  const policies = Array.isArray(policyIndex?.policies) ? policyIndex.policies : [];

  return policies.flatMap((policy) => {
    const artists = Array.isArray(policy.artists) ? policy.artists : [];
    const aliases = [policy.group, ...(Array.isArray(policy.aliases) ? policy.aliases : [])].filter(Boolean);
    const artistMatch = artists.find((artist) => uniqueNames.includes(normalizeCreatorIdentity(artist)));
    const groupMatch = aliases.find((alias) => uniqueNames.includes(normalizeCreatorIdentity(alias)));
    const matchedValue = artistMatch || groupMatch;
    if (!matchedValue) {
      return [];
    }

    const cache = policy.cache && typeof policy.cache === "object"
      ? {
        extensionPath: policy.cache.extensionPath ?? null,
        jobPath: policy.cache.jobPath ?? `policy-cache/${policy.id}.md`,
        capturedAt: policy.cache.capturedAt ?? null,
        sourceBodySha256: policy.cache.sourceBodySha256 ?? null,
        authority: "FALLBACK_ONLY"
      }
      : null;

    return [{
      id: policy.id,
      group: policy.group,
      artists,
      sourceUrl: policy.sourceUrl,
      status: policy.status || "UNKNOWN",
      checkedAt: policy.checkedAt ?? null,
      cache,
      matchedBy: {
        type: artistMatch ? "artist" : "group",
        input: uniqueNames.find((name) => name === normalizeCreatorIdentity(matchedValue)) || null,
        value: matchedValue
      }
    }];
  });
}

export function compileCreatorPolicyMarkdown({
  basePolicyMarkdown = "",
  resolvedPolicies = []
} = {}) {
  const base = String(basePolicyMarkdown ?? "").trim();
  const matches = Array.isArray(resolvedPolicies) ? resolvedPolicies : [];
  const resolutionSection = matches.length === 0
    ? [
      "# 현재 작업 대상 자동 정책 매칭",
      "",
      "- 결과: `NO_REGISTERED_POLICY_MATCH`",
      "- 방송인 이름과 등록 인덱스가 정확히 일치하지 않았다. 기본 규정을 적용하고 공식 정책을 별도로 확인한다."
    ].join("\n")
    : [
      "# 현재 작업 대상 자동 정책 매칭",
      "",
      "> 이 섹션은 정책 본문을 복제하지 않고 방송인과 공식 정책 원문의 위치만 연결한다. 작업 시점에 공식 URL을 다시 열어 최신 본문을 확인해야 한다.",
      "",
      ...matches.flatMap((policy, index) => {
        const cache = policy.cache && typeof policy.cache === "object" ? policy.cache : null;
        const cacheDescription = cache?.extensionPath
          ? [
            `- Optional cache: \`${safeInline(cache.jobPath, `policy-cache/${safeInline(policy.id)}.md`)}\` (작업폴더에 제공된 경우만)`,
            `- Cache captured at: ${safeInline(cache.capturedAt)}`,
            `- Source body SHA-256 at capture: \`${safeInline(cache.sourceBodySha256)}\``,
            "- Cache authority: `FALLBACK_ONLY` — 현재 원문을 대신하지 않으며 프롬프트 본문에는 삽입하지 않는다."
          ]
          : ["- Optional cache: `NONE`"];
        return [
          `## 매칭 ${index + 1}: ${safeInline(policy.matchedBy?.value)} → ${safeInline(policy.group)}`,
          "",
          `- Match type: \`EXACT_${safeInline(policy.matchedBy?.type).toUpperCase()}\``,
          `- Policy ID: \`${safeInline(policy.id)}\``,
          `- Official policy source: ${safeInline(policy.sourceUrl)}`,
          `- Last access status: \`${safeInline(policy.status)}\``,
          `- Last checked at: ${safeInline(policy.checkedAt)}`,
          "- Runtime rule: 작업을 시작할 때 공식 링크를 다시 열고 최신 원문을 기준으로 핵심 조항을 추출한다.",
          ...cacheDescription
        ];
      })
    ].join("\n");

  return [resolutionSection, base].filter(Boolean).join("\n\n---\n\n");
}

const captureDetails = (capture) => {
  if (!capture || typeof capture !== "object") {
    return "직접 입력";
  }
  const items = [safeInline(capture.method, "직접 입력")];
  if (capture.observedAt) {
    items.push(`관측 ${capture.observedAt}`);
  }
  if (Number.isFinite(capture.liveEdgeOffsetSeconds)) {
    items.push(`라이브 엣지 대비 약 ${capture.liveEdgeOffsetSeconds.toFixed(1)}초 지연`);
  }
  return items.join(" · ");
};

const buildMachineMetadata = ({ projectName, source, globalInstruction, segments, resolvedCreatorPolicies = [], generatedAt }) => ({
  schema: SCHEMA_VERSION,
  generatedAt,
  projectName: projectName || null,
  source: {
    platform: source.platform || "CHZZK",
    url: source.url || null,
    canonicalUrl: source.canonicalUrl || null,
    channelId: source.channelId || null,
    contentId: source.contentId || null,
    contentType: source.contentType || "unknown",
    streamerName: source.streamerName || null,
    broadcastTitle: source.broadcastTitle || null,
    broadcastStartedAt: source.broadcastStartedAt || null,
    clipActive: typeof source.clipActive === "boolean" ? source.clipActive : null,
    timeMachineActive: typeof source.timeMachineActive === "boolean" ? source.timeMachineActive : null,
    category: source.category || null,
    observedAt: source.observedAt || null
  },
  globalInstruction: globalInstruction || null,
  policyGates: {
    revenueHumanReview: "PENDING",
    musicHumanReview: "PENDING",
    thirdPartyCrossCheck: "REQUIRED_IF_PRESENT",
    automaticPublication: "BLOCKED"
  },
  creatorPolicyResolution: resolvedCreatorPolicies.map((policy) => ({
    id: policy.id,
    group: policy.group,
    sourceUrl: policy.sourceUrl,
    status: policy.status,
    checkedAt: policy.checkedAt ?? null,
    cache: {
      available: Boolean(policy.cache?.extensionPath),
      jobPath: policy.cache?.jobPath ?? null,
      capturedAt: policy.cache?.capturedAt ?? null,
      sourceBodySha256: policy.cache?.sourceBodySha256 ?? null,
      authority: policy.cache?.extensionPath ? "FALLBACK_ONLY" : null
    },
    matchedBy: policy.matchedBy ?? null
  })),
  segments: segments.map((segment, index) => ({
    order: index + 1,
    id: segment.id,
    anchorStartSeconds: segment.startSeconds,
    anchorEndSeconds: segment.endSeconds,
    userDescription: segment.description,
    startCapture: segment.startCapture ?? null,
    endCapture: segment.endCapture ?? null
  }))
});

export function generateEditPrompt({
  projectName = "",
  source = {},
  globalInstruction = "",
  segments = [],
  editingGuideMarkdown = "",
  creatorPolicyMarkdown = "",
  resolvedCreatorPolicies = [],
  generatedAt = nowIso()
}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("프롬프트를 만들려면 구간을 하나 이상 저장해야 합니다.");
  }

  const orderedSegments = [...segments];
  const metadata = buildMachineMetadata({
    projectName,
    source,
    globalInstruction,
    segments: orderedSegments,
    resolvedCreatorPolicies,
    generatedAt
  });
  const segmentSections = orderedSegments.map((segment, index) => {
    const duration = Math.max(0, segment.endSeconds - segment.startSeconds);
    return [
      `### 구간 ${index + 1}`,
      "",
      `- 관심 시작 앵커: \`${formatTimestamp(segment.startSeconds)}\``,
      `- 관심 종료 앵커: \`${formatTimestamp(segment.endSeconds)}\``,
      `- 앵커 범위 길이: 약 ${Math.round(duration)}초`,
      `- 시작값 출처: ${captureDetails(segment.startCapture)}`,
      `- 끝값 출처: ${captureDetails(segment.endCapture)}`,
      "- 사용자의 편집 의도:",
      "",
      markdownQuote(segment.description)
    ].join("\n");
  }).join("\n\n");

  const editingGuide = String(editingGuideMarkdown ?? "").trim() || "(내장 편집 지침을 불러오지 못했습니다. 사용자에게 확인한 뒤 진행하세요.)";
  const creatorPolicy = String(creatorPolicyMarkdown ?? "").trim() || "(방송인별 정책이 등록되지 않았습니다. 공개 또는 게시 전에 반드시 권리와 규정을 확인하세요.)";

  return `# Codex 영상 전처리 작업 요청서

> 스키마: \`${SCHEMA_VERSION}\`
> 생성 시각: ${generatedAt}
> 이 문서는 치지직 키리누키 프롬프트 확장 프로그램이 동일한 규격으로 생성했습니다.

## 1. 실행 목표

함께 제공된 치지직 풀영상 파일을 실제로 분석하고 편집하여, 아래 사용자가 표시한 관심 구간들을 **의미가 완결되는 말의 세션 단위**로 다듬은 한국어 자막 포함 검수용 영상을 생성하세요. 설명만 답하지 말고, 가능한 로컬 미디어 도구를 사용해 결과 파일을 만드세요.

타임스탬프는 최종 컷 경계가 아니라 관심 사건을 찾기 위한 앵커입니다. 각 앵커 주변을 전사한 뒤 질문과 답변, 설정과 결론, 농담과 반응처럼 하나의 의미가 닫히는 최소 대화 세션을 선택하세요.

**편집을 시작하기 전에 정책 프리플라이트를 먼저 수행하세요.** 방송인별 최신 공식 정책은 Extension 기본 규정보다 우선합니다. 다만 수익 관련 조항과 음원은 정책이 허용하는 것처럼 보여도 사람이 반드시 다시 확인해야 하며, 제3자가 등장하면 그 제3자의 정책을 모두 교차확인해야 합니다. 링크 본문을 읽지 못한 경우 조항을 추정하지 말고 **SOURCE_UNREADABLE**로 기록하세요.

## 2. 프로젝트와 원본

- 프로젝트명: ${safeInline(projectName, "미지정")}
- 플랫폼: ${safeInline(source.platform, "CHZZK")}
- 방송인/채널명: ${safeInline(source.streamerName)}
- 방송 제목: ${safeInline(source.broadcastTitle)}
- 방송 시작 시각(CHZZK): ${safeInline(source.broadcastStartedAt)}
- 치지직 클립 설정: ${typeof source.clipActive === "boolean" ? (source.clipActive ? "허용" : "미허용") : "미확인"}
- 카테고리: ${safeInline(source.category)}
- 콘텐츠 유형: ${safeInline(source.contentType)}
- 채널 ID: ${safeInline(source.channelId)}
- 콘텐츠 ID: ${safeInline(source.contentId)}
- 원본 URL: ${safeInline(source.canonicalUrl || source.url)}
- Extension 관측 시각: ${safeInline(source.observedAt)}

## 3. 방송 전체에 적용할 사용자 지시

${markdownQuote(globalInstruction || "별도 지시 없음. 아래 구간별 편집 의도와 내장 지침을 우선 적용할 것.")}

## 4. 사용자가 표시한 관심 구간

${segmentSections}

## 5. 편집 수행 순서

1. 이 문서와 방송인 정책 자료의 모든 링크·근거를 점검하고 policy-check.md를 먼저 만드세요. 접근할 수 없는 링크는 검증된 것으로 취급하지 마세요.
2. 영상에 등장하는 방송인, 게스트, 합방 참여자, 음성 통화 참여자와 식별 가능한 제3자를 목록화하고 각자의 정책을 교차확인하세요.
3. 수익 관련 상태와 음원 상태는 반드시 PENDING으로 시작하고, 사람의 명시적 확인 없이는 승인하지 마세요.
4. 입력 영상의 실제 재생시간, 프레임레이트, 오디오 트랙을 확인하세요.
5. 각 관심 앵커의 앞뒤를 전사하고 발화자와 발화 경계를 식별하세요.
6. 사용자 설명과 가장 일치하는 최소 완결 대화 세션을 선택하세요. 문장 중간, 질문만 남은 지점, 반응이 끝나기 전에는 자르지 마세요.
7. 서로 겹치거나 같은 사건에 속한 구간은 중복 없이 병합하고 그 사실을 기록하세요.
8. 별도 지시가 없으면 선택된 세션을 원방송 시간순으로 연결하세요.
9. 원문의 의미와 말투를 보존한 한국어 자막을 만들고, 읽기 좋은 호흡으로 나누세요. 들리지 않는 내용을 추측하지 마세요.
10. 정책상 비공개 검수본 제작이 가능한 범위에서 영상을 렌더링하고 아래 필수 산출물을 함께 남기세요.

## 6. 필수 산출물

- **policy-check.md**: 출연자·제3자·음원·수익·플랫폼별 정책 근거와 사람 검수 게이트
- \`edited-preview.mp4\`: 선택 구간을 연결하고 한국어 자막을 입힌 검수용 영상
- \`edit-plan.json\`: 원본 기준 컷 시작/끝, 선택 이유, 신뢰도, 병합 여부
- \`subtitles.ko.srt\`: 최종 영상 기준 한국어 자막
- \`review-notes.md\`: 불확실한 발화, 경계 선택 이유, 사람이 확인할 항목

자동으로 업로드하거나 게시하지 마세요. 결과는 반드시 사람이 검수할 수 있는 상태로 끝내세요.

## 7. Extension 내장 편집 지침

${editingGuide}

## 8. 방송인·아티스트 정책 자료와 기본 규정

${creatorPolicy}

## 9. 기계 판독용 원본 메타데이터

아래 JSON은 사용자 입력과 앵커의 원본값입니다. 자연어 섹션과 충돌할 경우 이 값을 보존하고 \`review-notes.md\`에 충돌을 기록하세요.

\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`

## 10. 완료 조건

필수 산출물 다섯 개가 실제로 생성되고, 각 사용자 관심 구간이 누락되지 않았으며, 자막과 영상 싱크를 확인한 뒤 작업을 완료로 보고하세요. 수익·음원 사람 검수가 PENDING이거나 제3자 정책이 미확인이라면 비공개 검수본까지만 완료하고 공개 가능하다고 표현하지 마세요.
`;
}

export function buildCodexJobManifest({
  projectName = "",
  source = {},
  globalInstruction = "",
  segments = [],
  resolvedCreatorPolicies = [],
  generatedAt = nowIso()
} = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("Codex 작업 폴더를 만들려면 구간을 하나 이상 저장해야 합니다.");
  }

  const metadata = buildMachineMetadata({
    projectName,
    source,
    globalInstruction,
    segments,
    resolvedCreatorPolicies,
    generatedAt
  });
  return {
    schema: CODEX_JOB_SCHEMA_VERSION,
    generatedAt,
    status: "AWAITING_SOURCE_VIDEO",
    projectName: projectName || null,
    source: metadata.source,
    inputs: {
      agentInstructions: "AGENTS.md",
      startGuide: "START_HERE.md",
      editBrief: "edit-brief.md",
      creatorPolicy: "creator-policy.md",
      creatorPolicyIndex: "creator-policy-index.json",
      creatorPolicyCache: {
        location: "policy-cache",
        required: false,
        authority: "FALLBACK_ONLY"
      },
      fullVideo: {
        location: "job-folder-root",
        required: true,
        expectedCount: 1,
        status: "USER_TO_ADD",
        supportedExtensions: [".mp4", ".mkv", ".mov", ".webm", ".m4v"]
      }
    },
    userIntent: {
      globalInstruction: globalInstruction || null,
      anchors: metadata.segments
    },
    creatorPolicyResolution: metadata.creatorPolicyResolution,
    policyGates: metadata.policyGates,
    execution: {
      scope: "PRIVATE_REVIEW_PREPROCESSING_ONLY",
      preserveSourceVideo: true,
      uploadSourceVideo: "FORBIDDEN",
      automaticPublication: "FORBIDDEN",
      requiredOutputs: [
        "policy-check.md",
        "edited-preview.mp4",
        "edit-plan.json",
        "subtitles.ko.srt",
        "review-notes.md"
      ]
    }
  };
}

export function generateCodexStartHere({
  projectName = "",
  source = {},
  generatedAt = nowIso()
} = {}) {
  const title = safeInline(projectName, "이름 없는 키리누키 작업");
  const streamer = safeInline(source.streamerName);
  const command = "이 폴더의 AGENTS.md, START_HERE.md, edit-brief.md, creator-policy.md, creator-policy-index.json과 job-manifest.json을 읽고 작업을 끝까지 실행해줘. 공식 정책 링크의 최신 원문을 먼저 확인해 정책 프리플라이트를 수행하고, 수익·음원·제3자 확인이 필요한 부분은 policy-check.md에 보류 상태로 남긴 뒤 비공개 검수용 영상까지만 만들어줘. 원본 영상은 변경하지 마.";

  return `# Codex 작업 시작 안내

> 프로젝트: ${title}
> 방송인/채널: ${streamer}
> 작업 폴더 생성 시각: ${generatedAt}

이 폴더는 코딩을 몰라도 Codex에 그대로 열어 작업할 수 있는 키리누키 전처리 패키지입니다. Extension은 영상을 포함하지 않으며 공개·업로드·수익화도 수행하지 않습니다.

## 1. 풀영상 넣기

치지직 공식 다시보기 등 적법하게 준비한 풀영상 파일 **하나만** 이 폴더의 최상위에 넣으세요. 지원 대상은 MP4, MKV, MOV, WEBM, M4V입니다. 원본 영상은 이름을 바꾸지 않아도 됩니다.

## 2. Codex에서 폴더 열기

Codex 앱이나 Codex가 연결된 개발 환경에서 이 폴더를 프로젝트로 여세요. **AGENTS.md**가 작업 규칙을, **edit-brief.md**가 구간과 자연어 편집 의도를, **creator-policy-index.json**이 방송인과 공식 정책 링크의 관계를 제공합니다. \`policy-cache/\`는 존재하더라도 원문 접근 실패 시의 참고자료일 뿐입니다.

## 3. 아래 한 문장 전송하기

    ${command}

## 사람이 반드시 확인할 것

- 수익·상업 이용 상태는 사람이 승인하기 전까지 **HUMAN_REVENUE_REVIEW: PENDING**입니다.
- 음원·가창·게임 음악은 사람이 승인하기 전까지 **HUMAN_MUSIC_REVIEW: PENDING**입니다.
- 제3자가 등장하면 그 사람과 소속 그룹의 정책이 모두 교차확인되어야 합니다.
- 네이버 카페 링크의 본문을 읽지 못하면 허용으로 추정하지 않고 **SOURCE_UNREADABLE**로 남깁니다.
- 결과물은 비공개 검수본입니다. 게시·업로드·수익화는 별도 사람 검수 뒤에만 진행하세요.

## 완료 시 생기는 파일

- **policy-check.md**
- **edited-preview.mp4**
- **edit-plan.json**
- **subtitles.ko.srt**
- **review-notes.md**
`;
}
