(() => {
  if (globalThis.__chzzkKirinukiBridgeLoaded) {
    return;
  }
  globalThis.__chzzkKirinukiBridgeLoaded = true;

  let liveMetadataCache = null;

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  const choosePrimaryVideo = () => {
    const videos = [...document.querySelectorAll("video")].filter(isVisible);
    return videos.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftScore = leftRect.width * leftRect.height + (left.readyState >= 2 ? 1_000_000 : 0);
      const rightScore = rightRect.width * rightRect.height + (right.readyState >= 2 ? 1_000_000 : 0);
      return rightScore - leftScore;
    })[0] ?? null;
  };

  const readMeta = (...selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) {
        return value;
      }
    }
    return "";
  };

  const cleanTitle = (title) => String(title ?? "")
    .replace(/\s*[-|:]\s*CHZZK\s*$/i, "")
    .replace(/\s*[-|:]\s*치지직\s*$/i, "")
    .trim();

  const inferIdentifiers = () => {
    const parts = location.pathname.split("/").filter(Boolean);
    const uuidLike = parts.find((part) => /^[a-f0-9]{32}$/i.test(part));
    const videoIndex = parts.indexOf("video");
    const liveIndex = parts.indexOf("live");
    const clipsIndex = parts.indexOf("clips");

    let contentType = "unknown";
    let contentId = "";
    if (videoIndex >= 0) {
      contentType = "vod";
      contentId = parts[videoIndex + 1] ?? "";
    } else if (clipsIndex >= 0) {
      contentType = "clip";
      contentId = parts[clipsIndex + 1] ?? "";
    } else if (liveIndex >= 0) {
      contentType = "live";
    } else if (uuidLike) {
      contentType = "channel";
    }

    return {
      channelId: uuidLike ?? "",
      contentId,
      contentType
    };
  };

  const readPlayer = () => {
    const video = choosePrimaryVideo();
    if (!video) {
      return {
        found: false,
        positionSeconds: null,
        positionSource: "unavailable",
        confidence: "none"
      };
    }

    const currentTime = video.readyState >= 1 && Number.isFinite(video.currentTime) ? video.currentTime : null;
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const seekableStart = video.seekable.length > 0 ? video.seekable.start(0) : null;
    const seekableEnd = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : null;
    const liveEdgeOffsetSeconds = currentTime !== null && seekableEnd !== null
      ? Math.max(0, seekableEnd - currentTime)
      : null;

    return {
      found: true,
      positionSeconds: currentTime,
      positionSource: "html-video-currentTime",
      confidence: duration !== null ? "high" : "medium",
      durationSeconds: duration,
      seekableStartSeconds: seekableStart,
      seekableEndSeconds: seekableEnd,
      liveEdgeOffsetSeconds,
      paused: video.paused,
      playbackRate: video.playbackRate,
      readyState: video.readyState
    };
  };

  const fetchLiveMetadata = async (channelId) => {
    if (!channelId) {
      return null;
    }
    if (
      liveMetadataCache?.channelId === channelId &&
      Date.now() - liveMetadataCache.fetchedAt < 15_000
    ) {
      return liveMetadataCache.value;
    }

    try {
      const endpoint = `https://api.chzzk.naver.com/polling/v3.1/channels/${encodeURIComponent(channelId)}/live-status?includePlayerRecommendContent=false`;
      const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      const value = payload?.code === 200 && payload?.content ? payload.content : null;
      liveMetadataCache = { channelId, fetchedAt: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  };

  const parseChzzkOpenDate = (value) => {
    if (!value) {
      return null;
    }
    const text = String(value).trim();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(" ", "T")}+09:00`
      : text;
    const milliseconds = Date.parse(normalized);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  };

  const normalizeLivePlayerPosition = (player, liveMetadata, capturedAt) => {
    const openDateMilliseconds = parseChzzkOpenDate(liveMetadata?.openDate);
    if (
      !player.found ||
      !Number.isFinite(player.positionSeconds) ||
      openDateMilliseconds === null
    ) {
      return player;
    }

    const capturedMilliseconds = Date.parse(capturedAt);
    if (!Number.isFinite(capturedMilliseconds) || capturedMilliseconds < openDateMilliseconds) {
      return player;
    }

    const elapsedAtLiveEdge = (capturedMilliseconds - openDateMilliseconds) / 1000;
    const liveEdgeOffset = Number.isFinite(player.liveEdgeOffsetSeconds) ? player.liveEdgeOffsetSeconds : 0;
    return {
      ...player,
      rawMediaPositionSeconds: player.positionSeconds,
      positionSeconds: Math.max(0, elapsedAtLiveEdge - liveEdgeOffset),
      positionSource: "chzzk-openDate+wallclock-liveEdge",
      confidence: Number.isFinite(player.liveEdgeOffsetSeconds) ? "high" : "medium",
      elapsedAtLiveEdgeSeconds: elapsedAtLiveEdge
    };
  };

  const getContext = async () => {
    const identifiers = inferIdentifiers();
    const pageTitle = cleanTitle(readMeta("meta[property='og:title']", "meta[name='twitter:title']") || document.title);
    const titleParts = pageTitle.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    const liveMetadata = identifiers.contentType === "live"
      ? await fetchLiveMetadata(identifiers.channelId)
      : null;
    const hasCreatorTitlePair = ["live", "vod", "clip"].includes(identifiers.contentType) && titleParts.length >= 2;
    const streamerName = hasCreatorTitlePair ? titleParts[0] : "";
    const broadcastTitle = liveMetadata?.liveTitle || (hasCreatorTitlePair ? titleParts.slice(1).join(" - ") : pageTitle);
    const description = readMeta("meta[property='og:description']", "meta[name='description']");
    const imageUrl = readMeta("meta[property='og:image']", "meta[name='twitter:image']");
    const capturedAt = new Date().toISOString();
    const player = identifiers.contentType === "live"
      ? normalizeLivePlayerPosition(readPlayer(), liveMetadata, capturedAt)
      : readPlayer();

    return {
      platform: "CHZZK",
      url: location.href,
      canonicalUrl: document.querySelector("link[rel='canonical']")?.href || location.href,
      pageTitle,
      streamerName,
      broadcastTitle,
      description,
      imageUrl,
      channelId: identifiers.channelId,
      contentId: identifiers.contentId,
      contentType: identifiers.contentType,
      broadcastStartedAt: liveMetadata?.openDate || "",
      clipActive: typeof liveMetadata?.clipActive === "boolean" ? liveMetadata.clipActive : null,
      timeMachineActive: typeof liveMetadata?.timeMachineActive === "boolean" ? liveMetadata.timeMachineActive : null,
      category: liveMetadata?.liveCategoryValue || "",
      capturedAt,
      player
    };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "KIRINUKI_GET_CONTEXT") {
      return false;
    }

    void getContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
})();
