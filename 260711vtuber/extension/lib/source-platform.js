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
  return Boolean(sourcePlatformFromUrl(value));
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
  url.hash = "";
  return url.toString();
}

export function sourcePlatformLabel(platform) {
  return platform === SOURCE_PLATFORM_YOUTUBE ? "YouTube" : "치지직";
}
