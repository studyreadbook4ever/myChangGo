export const SOURCE_PLATFORM_CHZZK = "CHZZK";
export const SOURCE_PLATFORM_YOUTUBE = "YOUTUBE";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const CHZZK_CHANNEL_ID_PATTERN = /^[a-f0-9]{32}$/iu;

function parsedHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
  ) {
    return null;
  }
  return url;
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/\.$/u, "");
}

function isYouTubeHostname(hostname) {
  return (
    hostname === "youtube.com"
    || hostname === "www.youtube.com"
    || hostname === "m.youtube.com"
    || hostname === "youtu.be"
  );
}

export function sourcePlatformFromUrl(value) {
  const url = parsedHttpsUrl(value);
  if (!url) {
    return "";
  }
  const hostname = normalizedHostname(url);
  if (hostname === "chzzk.naver.com") {
    return SOURCE_PLATFORM_CHZZK;
  }
  if (isYouTubeHostname(hostname)) {
    return SOURCE_PLATFORM_YOUTUBE;
  }
  return "";
}

export function isSupportedSourceUrl(value) {
  const identifiers = inferSourceIdentifiers(value);
  if (identifiers.platform === SOURCE_PLATFORM_YOUTUBE) {
    return Boolean(
      identifiers.contentType === "vod"
      && identifiers.contentId
    );
  }
  if (identifiers.platform !== SOURCE_PLATFORM_CHZZK) {
    return false;
  }
  if (identifiers.contentType === "live") {
    return Boolean(identifiers.channelId);
  }
  return Boolean(
    ["vod", "clip"].includes(identifiers.contentType)
    && identifiers.contentId
  );
}

function sameSourceIdentity(left, right) {
  if (!left?.platform || !right?.platform || left.platform !== right.platform) {
    return false;
  }
  const leftContentType = String(left.contentType || "unknown").toLowerCase();
  const rightContentType = String(right.contentType || "unknown").toLowerCase();
  if (leftContentType !== rightContentType) {
    return false;
  }
  if (left.contentId || right.contentId) {
    return Boolean(
      left.contentId
      && right.contentId
      && left.contentId === right.contentId
    );
  }
  return Boolean(
    left.channelId
    && right.channelId
    && left.channelId === right.channelId
    && left.contentType === right.contentType
  );
}

function expectedSourceIdentifiers(expectedSource) {
  const source = (
    expectedSource
    && typeof expectedSource === "object"
    && !Array.isArray(expectedSource)
  )
    ? expectedSource
    : {};
  const inferred = inferSourceIdentifiers(
    source.canonicalUrl || source.url || ""
  );
  const explicitPlatform = String(source.platform || "")
    .trim()
    .toUpperCase();
  const platform = [
    SOURCE_PLATFORM_CHZZK,
    SOURCE_PLATFORM_YOUTUBE
  ].includes(explicitPlatform)
    ? explicitPlatform
    : inferred.platform;
  const explicitContentType = String(source.contentType || "")
    .trim()
    .toLowerCase();
  const hasExplicitContentType = Boolean(
    explicitContentType && explicitContentType !== "unknown"
  );
  const canUseInferredIdentity = Boolean(
    (!explicitPlatform || explicitPlatform === inferred.platform)
    && (
      !hasExplicitContentType
      || explicitContentType === inferred.contentType
    )
  );
  const contentType = hasExplicitContentType
    ? explicitContentType
    : inferred.contentType;
  return {
    platform,
    channelId: String(
      source.channelId
      || (canUseInferredIdentity ? inferred.channelId : "")
      || ""
    ).trim(),
    contentId: String(
      (contentType === "live" ? "" : source.contentId)
      || (canUseInferredIdentity ? inferred.contentId : "")
      || ""
    ).trim(),
    contentType
  };
}

export function selectSupportedSourceTab(tabs, {
  expectedSource = null
} = {}) {
  const candidates = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => (
      Number.isInteger(tab?.id)
      && isSupportedSourceUrl(tab?.url)
    ));
  const active = candidates.find((tab) => tab.active === true);
  if (active) {
    return active;
  }

  const expectedIdentity = expectedSourceIdentifiers(expectedSource);
  if (expectedIdentity.platform) {
    const matches = candidates.filter((tab) => sameSourceIdentity(
      inferSourceIdentifiers(tab.url),
      expectedIdentity
    ));
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

export function sourceRefreshFailureAction({
  silent = false,
  hasCurrentContext = false,
  sourceUnavailable = false
} = {}) {
  return (
    silent
    && hasCurrentContext
    && !sourceUnavailable
  )
    ? "retain"
    : "clear";
}

export function canStartSourceRefresh({
  silent = false,
  foregroundRequestCount = 0
} = {}) {
  return !(
    silent
    && Math.max(0, Number(foregroundRequestCount) || 0) > 0
  );
}

function youtubeVideoId(value) {
  const candidate = String(value || "").trim();
  return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : "";
}

function youtubeChannelIdFromUrls(values) {
  for (const value of values) {
    const url = parsedHttpsUrl(value);
    if (!url || !isYouTubeHostname(normalizedHostname(url))) {
      continue;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const channelIndex = parts.indexOf("channel");
    if (channelIndex >= 0 && parts[channelIndex + 1]) {
      return parts[channelIndex + 1].slice(0, 128);
    }
    const handle = parts.find((part) => part.startsWith("@"));
    if (handle) {
      return handle.slice(0, 128);
    }
  }
  return "";
}

function inferYouTubeIdentifiers(url, linkedUrls) {
  const hostname = normalizedHostname(url);
  const parts = url.pathname.split("/").filter(Boolean);
  let contentId = "";
  if (hostname === "youtu.be") {
    contentId = youtubeVideoId(parts[0]);
  } else if (url.pathname === "/watch") {
    contentId = youtubeVideoId(url.searchParams.get("v"));
  } else if (
    ["shorts", "embed", "live"].includes(parts[0])
  ) {
    contentId = youtubeVideoId(parts[1]);
  }
  return {
    platform: SOURCE_PLATFORM_YOUTUBE,
    channelId: youtubeChannelIdFromUrls(linkedUrls),
    contentId,
    contentType: contentId ? "vod" : "unknown"
  };
}

function inferChzzkIdentifiers(url, linkedUrls) {
  const parts = url.pathname.split("/").filter(Boolean);
  const linkedChannelId = linkedUrls
    .flatMap((value) => {
      const linkedUrl = parsedHttpsUrl(value);
      if (
        !linkedUrl
        || normalizedHostname(linkedUrl) !== "chzzk.naver.com"
      ) {
        return [];
      }
      return linkedUrl.pathname.split("/").filter(Boolean);
    })
    .find((part) => CHZZK_CHANNEL_ID_PATTERN.test(part));
  const channelId = parts.find(
    (part) => CHZZK_CHANNEL_ID_PATTERN.test(part)
  ) || linkedChannelId || "";
  const videoIndex = parts.indexOf("video");
  const liveIndex = parts.indexOf("live");
  const clipsIndex = parts.indexOf("clips");

  if (videoIndex >= 0) {
    return {
      platform: SOURCE_PLATFORM_CHZZK,
      channelId,
      contentId: parts[videoIndex + 1] || "",
      contentType: "vod"
    };
  }
  if (clipsIndex >= 0) {
    return {
      platform: SOURCE_PLATFORM_CHZZK,
      channelId,
      contentId: parts[clipsIndex + 1] || "",
      contentType: "clip"
    };
  }
  return {
    platform: SOURCE_PLATFORM_CHZZK,
    channelId,
    contentId: "",
    contentType: liveIndex >= 0
      ? "live"
      : channelId
        ? "channel"
        : "unknown"
  };
}

export function inferSourceIdentifiers(
  value,
  { linkedUrls = [] } = {}
) {
  const url = parsedHttpsUrl(value);
  const platform = sourcePlatformFromUrl(value);
  const normalizedLinkedUrls = Array.isArray(linkedUrls)
    ? linkedUrls
    : [];
  if (!url || !platform) {
    return {
      platform: "",
      channelId: "",
      contentId: "",
      contentType: "unknown"
    };
  }
  return platform === SOURCE_PLATFORM_YOUTUBE
    ? inferYouTubeIdentifiers(url, normalizedLinkedUrls)
    : inferChzzkIdentifiers(url, normalizedLinkedUrls);
}

export function canonicalSourceUrl(value, identifiers = null) {
  const url = parsedHttpsUrl(value);
  const resolved = identifiers || inferSourceIdentifiers(value);
  if (!url || !resolved?.platform) {
    return "";
  }
  if (
    resolved.platform === SOURCE_PLATFORM_YOUTUBE
    && resolved.contentId
  ) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(resolved.contentId)}`;
  }
  if (resolved.platform === SOURCE_PLATFORM_CHZZK) {
    const contentType = String(resolved.contentType || "").toLowerCase();
    if (contentType === "live" && resolved.channelId) {
      return `https://chzzk.naver.com/live/${encodeURIComponent(resolved.channelId)}`;
    }
    if (contentType === "vod" && resolved.contentId) {
      return `https://chzzk.naver.com/video/${encodeURIComponent(resolved.contentId)}`;
    }
    if (contentType === "clip" && resolved.contentId) {
      return `https://chzzk.naver.com/clips/${encodeURIComponent(resolved.contentId)}`;
    }
  }
  url.hash = "";
  return url.toString();
}

export function sourcePlatformLabel(platform) {
  return platform === SOURCE_PLATFORM_YOUTUBE ? "YouTube" : "치지직";
}

export function sourcePlayerStatusText(context) {
  const player = context?.player || {};
  if (!player.found) {
    return "영상 플레이어 미검출";
  }
  if (player.adActive) {
    return "YouTube 광고 재생 중 · 스탬프 일시 중지";
  }
  const parts = [player.paused ? "일시정지" : "재생 중"];
  if (
    context?.contentType === "live"
    && Number.isFinite(player.liveEdgeOffsetSeconds)
  ) {
    parts.push(`라이브 지연 ${player.liveEdgeOffsetSeconds.toFixed(1)}초`);
  }
  if (typeof context?.clipActive === "boolean") {
    parts.push(`클립 ${context.clipActive ? "허용" : "미허용"}`);
  }
  return parts.join(" · ");
}
