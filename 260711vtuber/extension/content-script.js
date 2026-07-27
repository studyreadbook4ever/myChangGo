(() => {
  if (globalThis.__chzzkKirinukiBridgeLoaded) {
    return;
  }
  globalThis.__chzzkKirinukiBridgeLoaded = true;

  let liveMetadataCache = null;
  let vodMetadataCache = null;

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
    const linkedChannelId = [...document.querySelectorAll("a[href]")]
      .map((anchor) => {
        try {
          return new URL(anchor.href, location.origin).pathname.split("/").filter(Boolean)
            .find((part) => /^[a-f0-9]{32}$/i.test(part));
        } catch {
          return "";
        }
      })
      .find(Boolean);
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
      channelId: uuidLike ?? linkedChannelId ?? "",
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

  const fetchVodMetadata = async (videoId) => {
    if (!videoId) {
      return null;
    }
    if (
      vodMetadataCache?.videoId === videoId &&
      Date.now() - vodMetadataCache.fetchedAt < 60_000
    ) {
      return vodMetadataCache.value;
    }

    try {
      const endpoint = `https://api.chzzk.naver.com/service/v3/videos/${encodeURIComponent(videoId)}`;
      const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      const value = payload?.code === 200 && payload?.content ? payload.content : null;
      vodMetadataCache = { videoId, fetchedAt: Date.now(), value };
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
    const [liveMetadata, vodMetadata] = await Promise.all([
      identifiers.contentType === "live"
        ? fetchLiveMetadata(identifiers.channelId)
        : null,
      identifiers.contentType === "vod"
        ? fetchVodMetadata(identifiers.contentId)
        : null
    ]);
    const metadataChannel = liveMetadata?.channel || vodMetadata?.channel || null;
    const channelId = metadataChannel?.channelId || identifiers.channelId;
    const hasCreatorTitlePair = ["live", "vod", "clip"].includes(identifiers.contentType) && titleParts.length >= 2;
    const streamerName = metadataChannel?.channelName || (hasCreatorTitlePair ? titleParts[0] : "");
    const broadcastTitle = liveMetadata?.liveTitle
      || vodMetadata?.videoTitle
      || (hasCreatorTitlePair ? titleParts.slice(1).join(" - ") : pageTitle);
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
      channelId,
      contentId: identifiers.contentId,
      contentType: identifiers.contentType,
      broadcastStartedAt: liveMetadata?.openDate || vodMetadata?.liveOpenDate || "",
      clipActive: typeof (liveMetadata?.clipActive ?? vodMetadata?.clipActive) === "boolean"
        ? (liveMetadata?.clipActive ?? vodMetadata?.clipActive)
        : null,
      timeMachineActive: typeof liveMetadata?.timeMachineActive === "boolean" ? liveMetadata.timeMachineActive : null,
      category: liveMetadata?.liveCategoryValue || vodMetadata?.videoCategoryValue || "",
      capturedAt,
      player
    };
  };

  const applyPlayerCommand = async (message) => {
    const video = choosePrimaryVideo();
    if (!video) {
      throw new Error("치지직 영상 플레이어를 찾지 못했습니다.");
    }
    if (message.action === "play") {
      await video.play();
    } else if (message.action === "pause") {
      video.pause();
    } else if (message.action === "seek") {
      if (!Number.isFinite(message.positionSeconds) || message.positionSeconds < 0) {
        throw new Error("이동할 영상 시각이 올바르지 않습니다.");
      }
      const identifiers = inferIdentifiers();
      let target = message.positionSeconds;
      if (identifiers.contentType === "live") {
        const context = await getContext();
        const normalizedPosition = context.player?.positionSeconds;
        if (Number.isFinite(normalizedPosition)) {
          target = video.currentTime + message.positionSeconds - normalizedPosition;
        }
      }
      if (video.seekable.length > 0) {
        const start = video.seekable.start(0);
        const end = video.seekable.end(video.seekable.length - 1);
        target = Math.min(end, Math.max(start, target));
      }
      video.currentTime = target;
    } else {
      throw new Error(`지원하지 않는 플레이어 명령입니다: ${message.action}`);
    }
    return {
      paused: video.paused,
      currentTime: video.currentTime
    };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KIRINUKI_GET_CONTEXT") {
      void getContext()
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (message?.type === "KIRINUKI_PLAYER_COMMAND") {
      void applyPlayerCommand(message)
        .then((player) => sendResponse({ ok: true, player }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });
})();
