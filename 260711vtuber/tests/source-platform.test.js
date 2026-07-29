import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PLATFORM_CHZZK,
  SOURCE_PLATFORM_YOUTUBE,
  canonicalSourceUrl,
  inferSourceIdentifiers,
  isSupportedSourceUrl,
  selectSupportedSourceTab,
  sourcePlayerStatusText,
  sourcePlatformFromUrl
} from "../extension/lib/source-platform.js";

test("치지직과 지원 YouTube 최상위 영상 URL만 허용한다", () => {
  assert.equal(
    sourcePlatformFromUrl("https://chzzk.naver.com/video/14405629"),
    SOURCE_PLATFORM_CHZZK
  );
  for (const url of [
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://youtube.com/watch?v=abcdefghijk",
    "https://m.youtube.com/shorts/abcdefghijk",
    "https://www.youtube.com/embed/abcdefghijk",
    "https://youtu.be/abcdefghijk"
  ]) {
    assert.equal(sourcePlatformFromUrl(url), SOURCE_PLATFORM_YOUTUBE);
    assert.equal(isSupportedSourceUrl(url), true);
  }
  for (const url of [
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://music.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.example/watch?v=abcdefghijk",
    "https://example.com/?next=https://www.youtube.com/watch?v=abcdefghijk"
  ]) {
    assert.equal(isSupportedSourceUrl(url), false);
  }
});

test("watch·shorts·embed·youtu.be의 같은 영상은 동일한 YouTube VOD로 정규화한다", () => {
  const urls = [
    "https://www.youtube.com/watch?v=abcdefghijk&t=33s&list=playlist",
    "https://m.youtube.com/shorts/abcdefghijk?feature=share",
    "https://www.youtube.com/embed/abcdefghijk?autoplay=1",
    "https://www.youtube.com/live/abcdefghijk?feature=share",
    "https://youtu.be/abcdefghijk?t=10"
  ];
  const identifiers = urls.map((url) => inferSourceIdentifiers(url));
  assert(identifiers.every(
    (value) => (
      value.platform === SOURCE_PLATFORM_YOUTUBE
      && value.contentType === "vod"
      && value.contentId === "abcdefghijk"
    )
  ));
  assert.deepEqual(
    urls.map((url, index) => canonicalSourceUrl(url, identifiers[index])),
    Array.from(
      { length: urls.length },
      () => "https://www.youtube.com/watch?v=abcdefghijk"
    )
  );
});

test("YouTube 영상 ID가 없거나 비정상인 페이지는 원본 VOD로 만들지 않는다", () => {
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=abcdef",
    "https://www.youtube.com/watch?v=bad!",
    "https://youtu.be/"
  ]) {
    const identifiers = inferSourceIdentifiers(url);
    assert.equal(identifiers.platform, SOURCE_PLATFORM_YOUTUBE);
    assert.equal(identifiers.contentId, "");
    assert.equal(identifiers.contentType, "unknown");
  }
});

test("치지직 VOD·LIVE 식별과 연결된 채널 ID 회귀를 보존한다", () => {
  assert.deepEqual(
    inferSourceIdentifiers(
      "https://chzzk.naver.com/video/14405629",
      {
        linkedUrls: [
          "https://chzzk.naver.com/088973112d8acc831ec20274f7ffbb99"
        ]
      }
    ),
    {
      platform: SOURCE_PLATFORM_CHZZK,
      channelId: "088973112d8acc831ec20274f7ffbb99",
      contentId: "14405629",
      contentType: "vod"
    }
  );
  assert.deepEqual(
    inferSourceIdentifiers(
      "https://chzzk.naver.com/live/088973112d8acc831ec20274f7ffbb99"
    ),
    {
      platform: SOURCE_PLATFORM_CHZZK,
      channelId: "088973112d8acc831ec20274f7ffbb99",
      contentId: "",
      contentType: "live"
    }
  );
});

test("SOURCE 패널은 활성 영상 탭을 우선하고 닫힌 편집 세션의 원본으로 안전하게 폴백한다", () => {
  const chzzk = {
    id: 11,
    active: false,
    url: "https://chzzk.naver.com/video/13583412"
  };
  const youtube = {
    id: 12,
    active: false,
    url: "https://www.youtube.com/watch?v=abcdefghijk"
  };
  const editor = {
    id: 13,
    active: true,
    url: "chrome-extension://example/editor.html"
  };

  assert.equal(
    selectSupportedSourceTab([
      chzzk,
      { ...youtube, active: true }
    ])?.id,
    youtube.id,
    "사용자가 보고 있는 지원 영상 탭이 최우선이어야 합니다."
  );
  assert.equal(
    selectSupportedSourceTab([chzzk, youtube, editor], {
      expectedSource: {
        canonicalUrl: "https://chzzk.naver.com/video/13583412"
      }
    })?.id,
    chzzk.id,
    "편집기나 확장 화면이 활성화돼도 저장된 원본 영상 탭을 다시 찾아야 합니다."
  );
  assert.equal(
    selectSupportedSourceTab([chzzk, editor])?.id,
    chzzk.id,
    "지원 영상 탭이 하나뿐이면 그 탭을 사용해야 합니다."
  );
  assert.equal(
    selectSupportedSourceTab([chzzk, youtube, editor]),
    null,
    "여러 영상 탭 중 저장된 원본과 일치하는 탭이 없으면 추측하면 안 됩니다."
  );
});

test("SOURCE 상태는 VOD 남은 시간을 라이브 지연으로 오표시하지 않는다", () => {
  const player = {
    found: true,
    paused: false,
    liveEdgeOffsetSeconds: 3_492.4
  };
  assert.equal(
    sourcePlayerStatusText({
      contentType: "vod",
      clipActive: true,
      player
    }),
    "재생 중 · 클립 허용"
  );
  assert.equal(
    sourcePlayerStatusText({
      contentType: "live",
      clipActive: true,
      player
    }),
    "재생 중 · 라이브 지연 3492.4초 · 클립 허용"
  );
});
