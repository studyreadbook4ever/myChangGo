import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PLATFORM_CHZZK,
  SOURCE_PLATFORM_YOUTUBE,
  canonicalSourceUrl,
  inferSourceIdentifiers,
  isSupportedSourceUrl,
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
