import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PLATFORM_CHZZK,
  SOURCE_PLATFORM_YOUTUBE,
  canStartSourceRefresh,
  canonicalSourceUrl,
  inferSourceIdentifiers,
  isSupportedSourceUrl,
  selectSupportedSourceTab,
  sourcePlayerStatusText,
  sourcePlatformFromUrl,
  sourceRefreshFailureAction
} from "../extension/lib/source-platform.js";

test("치지직과 지원 YouTube 최상위 영상 URL만 허용한다", () => {
  assert.equal(
    sourcePlatformFromUrl("https://chzzk.naver.com/video/14405629"),
    SOURCE_PLATFORM_CHZZK
  );
  for (const url of [
    "https://chzzk.naver.com/video/14405629",
    "https://chzzk.naver.com/live/088973112d8acc831ec20274f7ffbb99",
    "https://chzzk.naver.com/clips/123456"
  ]) {
    assert.equal(isSupportedSourceUrl(url), true);
  }
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
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=abcdef",
    "https://chzzk.naver.com/",
    "https://chzzk.naver.com/088973112d8acc831ec20274f7ffbb99",
    "https://chzzk.naver.com/video/",
    "https://chzzk.naver.com/live/"
  ]) {
    assert.equal(
      isSupportedSourceUrl(url),
      false,
      `${url}은 실제 타임스탬프 영상 페이지가 아닙니다.`
    );
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

test("치지직 canonical URL은 stale DOM 주소가 아니라 현재 식별자로 결정한다", () => {
  assert.equal(
    canonicalSourceUrl(
      "https://chzzk.naver.com/video/14405629?from=old#stale",
      {
        platform: SOURCE_PLATFORM_CHZZK,
        contentId: "13583412",
        contentType: "vod"
      }
    ),
    "https://chzzk.naver.com/video/13583412"
  );
  assert.equal(
    canonicalSourceUrl(
      "https://chzzk.naver.com/",
      {
        platform: SOURCE_PLATFORM_CHZZK,
        channelId: "088973112d8acc831ec20274f7ffbb99",
        contentType: "live"
      }
    ),
    "https://chzzk.naver.com/live/088973112d8acc831ec20274f7ffbb99"
  );
  assert.equal(
    canonicalSourceUrl(
      "https://chzzk.naver.com/clips/stale",
      {
        platform: SOURCE_PLATFORM_CHZZK,
        contentId: "current-clip",
        contentType: "clip"
      }
    ),
    "https://chzzk.naver.com/clips/current-clip"
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

  const youtubeFeed = {
    id: 14,
    active: true,
    url: "https://www.youtube.com/feed/subscriptions"
  };
  assert.equal(
    selectSupportedSourceTab([youtubeFeed, chzzk, editor], {
      expectedSource: {
        canonicalUrl: chzzk.url
      }
    })?.id,
    chzzk.id,
    "활성 비영상 YouTube 페이지가 저장된 실제 원본을 선점하면 안 됩니다."
  );

  const staleChzzk = {
    id: 15,
    active: false,
    url: "https://chzzk.naver.com/video/14405629"
  };
  assert.equal(
    selectSupportedSourceTab([staleChzzk, chzzk, editor], {
      expectedSource: {
        platform: SOURCE_PLATFORM_CHZZK,
        canonicalUrl: staleChzzk.url,
        contentId: "13583412",
        contentType: "vod"
      }
    })?.id,
    chzzk.id,
    "저장된 명시적 contentId가 stale canonical URL보다 우선해야 합니다."
  );

  const chzzkLive = {
    id: 16,
    active: false,
    url: "https://chzzk.naver.com/live/088973112d8acc831ec20274f7ffbb99"
  };
  assert.equal(
    selectSupportedSourceTab([staleChzzk, chzzkLive, editor], {
      expectedSource: {
        platform: SOURCE_PLATFORM_CHZZK,
        canonicalUrl: staleChzzk.url,
        channelId: "088973112d8acc831ec20274f7ffbb99",
        contentType: "live"
      }
    })?.id,
    chzzkLive.id,
    "명시적 live 채널 identity에 stale VOD contentId를 섞으면 안 됩니다."
  );

  assert.equal(
    selectSupportedSourceTab([staleChzzk, chzzkLive, editor], {
      expectedSource: {
        platform: SOURCE_PLATFORM_CHZZK,
        canonicalUrl: staleChzzk.url,
        channelId: "088973112d8acc831ec20274f7ffbb99",
        contentId: "14405629",
        contentType: "live"
      }
    })?.id,
    chzzkLive.id,
    "저장된 live identity의 stale VOD contentId가 올바른 live 탭을 밀어내면 안 됩니다."
  );

  const collidingClip = {
    id: 17,
    active: false,
    url: "https://chzzk.naver.com/clips/14405629"
  };
  assert.equal(
    selectSupportedSourceTab([staleChzzk, collidingClip, editor], {
      expectedSource: {
        platform: SOURCE_PLATFORM_CHZZK,
        contentId: "14405629",
        contentType: "clip"
      }
    })?.id,
    collidingClip.id,
    "같은 contentId 문자열이어도 VOD와 clip의 identity를 섞으면 안 됩니다."
  );
});

test("SOURCE silent 갱신의 일시 오류만 마지막 정상 문맥을 유지한다", () => {
  assert.equal(
    sourceRefreshFailureAction({
      silent: true,
      hasCurrentContext: true,
      sourceUnavailable: false
    }),
    "retain"
  );
  for (const input of [
    {
      silent: false,
      hasCurrentContext: true,
      sourceUnavailable: false
    },
    {
      silent: true,
      hasCurrentContext: false,
      sourceUnavailable: false
    },
    {
      silent: true,
      hasCurrentContext: true,
      sourceUnavailable: true
    }
  ]) {
    assert.equal(sourceRefreshFailureAction(input), "clear");
  }
});

test("SOURCE silent 갱신은 사용자의 foreground 문맥 요청을 선점하지 않는다", () => {
  assert.equal(canStartSourceRefresh({
    silent: true,
    foregroundRequestCount: 1
  }), false);
  assert.equal(canStartSourceRefresh({
    silent: true,
    foregroundRequestCount: 2
  }), false);
  assert.equal(canStartSourceRefresh({
    silent: true,
    foregroundRequestCount: 0
  }), true);
  assert.equal(canStartSourceRefresh({
    silent: false,
    foregroundRequestCount: 1
  }), true);
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
