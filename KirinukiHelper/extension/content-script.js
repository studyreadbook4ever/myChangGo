(() => {
  // extension/lib/source-platform.js
  var SOURCE_PLATFORM_CHZZK = "CHZZK";
  var SOURCE_PLATFORM_YOUTUBE = "YOUTUBE";
  var YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
  var CHZZK_CHANNEL_ID_PATTERN = /^[a-f0-9]{32}$/iu;
  function parsedHttpsUrl(value) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    return url;
  }
  function normalizedHostname(url) {
    return url.hostname.toLowerCase().replace(/\.$/u, "");
  }
  function isYouTubeHostname(hostname) {
    return hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "m.youtube.com" || hostname === "youtu.be";
  }
  function sourcePlatformFromUrl(value) {
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
    } else if (["shorts", "embed", "live"].includes(parts[0])) {
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
    const linkedChannelId = linkedUrls.flatMap((value) => {
      const linkedUrl = parsedHttpsUrl(value);
      if (!linkedUrl || normalizedHostname(linkedUrl) !== "chzzk.naver.com") {
        return [];
      }
      return linkedUrl.pathname.split("/").filter(Boolean);
    }).find((part) => CHZZK_CHANNEL_ID_PATTERN.test(part));
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
      contentType: liveIndex >= 0 ? "live" : channelId ? "channel" : "unknown"
    };
  }
  function inferSourceIdentifiers(value, { linkedUrls = [] } = {}) {
    const url = parsedHttpsUrl(value);
    const platform = sourcePlatformFromUrl(value);
    const normalizedLinkedUrls = Array.isArray(linkedUrls) ? linkedUrls : [];
    if (!url || !platform) {
      return {
        platform: "",
        channelId: "",
        contentId: "",
        contentType: "unknown"
      };
    }
    return platform === SOURCE_PLATFORM_YOUTUBE ? inferYouTubeIdentifiers(url, normalizedLinkedUrls) : inferChzzkIdentifiers(url, normalizedLinkedUrls);
  }
  function canonicalSourceUrl(value, identifiers = null) {
    const url = parsedHttpsUrl(value);
    const resolved = identifiers || inferSourceIdentifiers(value);
    if (!url || !resolved?.platform) {
      return "";
    }
    if (resolved.platform === SOURCE_PLATFORM_YOUTUBE && resolved.contentId) {
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

  // src/content-script.js
  if (!globalThis.__kirinukiSourceBridgeLoaded) {
    globalThis.__kirinukiSourceBridgeLoaded = true;
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
        const leftScore = leftRect.width * leftRect.height + (left.readyState >= 2 ? 1e6 : 0);
        const rightScore = rightRect.width * rightRect.height + (right.readyState >= 2 ? 1e6 : 0);
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
    const readText = (...selectors) => {
      for (const selector of selectors) {
        const value = document.querySelector(selector)?.textContent?.trim();
        if (value) {
          return value;
        }
      }
      return "";
    };
    const linkedUrls = () => [...document.querySelectorAll("a[href], link[href]")].map((element) => {
      try {
        return new URL(
          element.getAttribute("href"),
          location.href
        ).toString();
      } catch {
        return "";
      }
    }).filter(Boolean);
    const currentYouTubeChannelUrls = () => [
      ...document.querySelectorAll(
        "#owner #channel-name a[href], ytd-watch-metadata ytd-channel-name a[href], ytd-reel-video-renderer a[href*='/@']"
      )
    ].map((element) => {
      try {
        return new URL(element.getAttribute("href"), location.href).toString();
      } catch {
        return "";
      }
    }).filter(Boolean);
    const cleanPageTitle = (title, platform) => {
      const text = String(title ?? "");
      if (platform === SOURCE_PLATFORM_YOUTUBE) {
        return text.replace(/\s*[-|]\s*YouTube\s*$/iu, "").trim();
      }
      return text.replace(/\s*[-|:]\s*CHZZK\s*$/iu, "").replace(/\s*[-|:]\s*치지직\s*$/iu, "").trim();
    };
    const youtubeAdActive = () => Boolean(
      document.querySelector("#movie_player.ad-showing") || document.querySelector(".html5-video-player.ad-showing")
    );
    const youtubeLiveInProgress = (video, { metadataFresh = false } = {}) => {
      const player = document.querySelector(
        "#movie_player, .html5-video-player"
      );
      const metadataSaysLive = metadataFresh && /^(?:true|1)$/iu.test(
        readMeta("meta[itemprop='isLiveBroadcast']")
      );
      const hasBroadcastEnd = Boolean(
        readMeta("meta[itemprop='endDate']")
      );
      return Boolean(
        video?.duration === Number.POSITIVE_INFINITY || player?.classList.contains("ytp-live") || metadataSaysLive && !hasBroadcastEnd
      );
    };
    const youtubeVideoIdFromCandidate = (value) => {
      const candidate = String(value || "").trim();
      if (!candidate) {
        return "";
      }
      try {
        const absoluteUrl = new URL(candidate, location.href).toString();
        const fromUrl = inferSourceIdentifiers(absoluteUrl).contentId;
        if (fromUrl) {
          return fromUrl;
        }
      } catch {
      }
      return inferSourceIdentifiers(
        `https://www.youtube.com/watch?v=${encodeURIComponent(candidate)}`
      ).contentId;
    };
    const readActiveYouTubeVideoId = () => {
      const watchFlexy = document.querySelector(
        "ytd-watch-flexy[video-id]"
      );
      const watchVideoId = youtubeVideoIdFromCandidate(
        watchFlexy?.getAttribute("video-id")
      );
      if (watchVideoId) {
        return watchVideoId;
      }
      const primaryVideo = choosePrimaryVideo();
      const primaryShortRenderer = primaryVideo?.closest?.(
        "ytd-reel-video-renderer"
      );
      const shortsRenderers = [
        ...document.querySelectorAll("ytd-reel-video-renderer")
      ];
      const activeShort = primaryShortRenderer || shortsRenderers.find((renderer) => isVisible(renderer) && (renderer.hasAttribute("is-active") || renderer.hasAttribute("active") || renderer.getAttribute("aria-hidden") === "false")) || shortsRenderers.find(isVisible);
      if (!activeShort) {
        return "";
      }
      const nestedVideoId = activeShort.querySelector("[video-id]")?.getAttribute("video-id");
      const activeShortLink = activeShort.querySelector(
        "a.ytp-title-link[href], a[href*='/shorts/'], a[href*='/watch?']"
      )?.getAttribute("href");
      for (const candidate of [
        activeShort.getAttribute("video-id"),
        activeShort.getAttribute("data-video-id"),
        nestedVideoId,
        activeShortLink
      ]) {
        const videoId = youtubeVideoIdFromCandidate(candidate);
        if (videoId) {
          return videoId;
        }
      }
      return "";
    };
    const readPlayer = (platform, { youtubeMetadataFresh = false } = {}) => {
      const video = choosePrimaryVideo();
      if (!video) {
        return {
          found: false,
          positionSeconds: null,
          positionSource: "unavailable",
          confidence: "none",
          adActive: false
        };
      }
      const adActive = platform === SOURCE_PLATFORM_YOUTUBE && youtubeAdActive();
      const liveInProgress = platform === SOURCE_PLATFORM_YOUTUBE && youtubeLiveInProgress(video, {
        metadataFresh: youtubeMetadataFresh
      });
      const currentTime = !adActive && video.readyState >= 1 && Number.isFinite(video.currentTime) ? video.currentTime : null;
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      const seekableStart = video.seekable.length > 0 ? video.seekable.start(0) : null;
      const seekableEnd = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : null;
      const liveEdgeOffsetSeconds = currentTime !== null && seekableEnd !== null ? Math.max(0, seekableEnd - currentTime) : null;
      return {
        found: true,
        positionSeconds: currentTime,
        positionSource: adActive ? "youtube-ad-blocked" : liveInProgress ? "youtube-live-in-progress" : "html-video-currentTime",
        confidence: adActive ? "none" : duration !== null ? "high" : "medium",
        durationSeconds: duration,
        durationIsInfinite: video.duration === Number.POSITIVE_INFINITY,
        liveInProgress,
        seekableStartSeconds: seekableStart,
        seekableEndSeconds: seekableEnd,
        liveEdgeOffsetSeconds,
        paused: video.paused,
        playbackRate: video.playbackRate,
        readyState: video.readyState,
        adActive
      };
    };
    const fetchLiveMetadata = async (channelId) => {
      if (!channelId) {
        return null;
      }
      if (liveMetadataCache?.channelId === channelId && Date.now() - liveMetadataCache.fetchedAt < 15e3) {
        return liveMetadataCache.value;
      }
      try {
        const endpoint = `https://api.chzzk.naver.com/polling/v3.1/channels/${encodeURIComponent(channelId)}/live-status?includePlayerRecommendContent=false`;
        const response = await fetch(endpoint, {
          credentials: "include",
          cache: "no-store"
        });
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        const value = payload?.code === 200 && payload?.content ? payload.content : null;
        liveMetadataCache = {
          channelId,
          fetchedAt: Date.now(),
          value
        };
        return value;
      } catch {
        return null;
      }
    };
    const fetchVodMetadata = async (videoId) => {
      if (!videoId) {
        return null;
      }
      if (vodMetadataCache?.videoId === videoId && Date.now() - vodMetadataCache.fetchedAt < 6e4) {
        return vodMetadataCache.value;
      }
      try {
        const endpoint = "https://api.chzzk.naver.com/service/v3/videos/" + encodeURIComponent(videoId);
        const response = await fetch(endpoint, {
          credentials: "include",
          cache: "no-store"
        });
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        const value = payload?.code === 200 && payload?.content ? payload.content : null;
        vodMetadataCache = {
          videoId,
          fetchedAt: Date.now(),
          value
        };
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
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text) ? `${text.replace(" ", "T")}+09:00` : text;
      const milliseconds = Date.parse(normalized);
      return Number.isFinite(milliseconds) ? milliseconds : null;
    };
    const normalizeLivePlayerPosition = (player, liveMetadata, capturedAt) => {
      const openDateMilliseconds = parseChzzkOpenDate(
        liveMetadata?.openDate
      );
      if (!player.found || !Number.isFinite(player.positionSeconds) || openDateMilliseconds === null) {
        return player;
      }
      const capturedMilliseconds = Date.parse(capturedAt);
      if (!Number.isFinite(capturedMilliseconds) || capturedMilliseconds < openDateMilliseconds) {
        return player;
      }
      const elapsedAtLiveEdge = (capturedMilliseconds - openDateMilliseconds) / 1e3;
      const liveEdgeOffset = Number.isFinite(player.liveEdgeOffsetSeconds) ? player.liveEdgeOffsetSeconds : 0;
      return {
        ...player,
        rawMediaPositionSeconds: player.positionSeconds,
        positionSeconds: Math.max(
          0,
          elapsedAtLiveEdge - liveEdgeOffset
        ),
        positionSource: "chzzk-openDate+wallclock-liveEdge",
        confidence: Number.isFinite(player.liveEdgeOffsetSeconds) ? "high" : "medium",
        elapsedAtLiveEdgeSeconds: elapsedAtLiveEdge
      };
    };
    const getContext = async () => {
      const requestedUrl = location.href;
      const platform = sourcePlatformFromUrl(requestedUrl);
      if (!platform) {
        throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uC601\uC0C1 \uD398\uC774\uC9C0\uC785\uB2C8\uB2E4.");
      }
      const identifiers = inferSourceIdentifiers(requestedUrl, {
        linkedUrls: platform === SOURCE_PLATFORM_YOUTUBE ? currentYouTubeChannelUrls() : linkedUrls()
      });
      if (platform === SOURCE_PLATFORM_YOUTUBE && !identifiers.contentId) {
        throw new Error(
          "YouTube \uC601\uC0C1 ID\uAC00 \uC788\uB294 watch\xB7shorts\xB7embed \uD398\uC774\uC9C0\uC5D0\uC11C \uC0AC\uC6A9\uD574 \uC8FC\uC138\uC694."
        );
      }
      const youtubeMetadataIdentifiers = platform === SOURCE_PLATFORM_YOUTUBE ? inferSourceIdentifiers(readMeta(
        "meta[property='og:url']",
        "meta[itemprop='url']"
      )) : null;
      const youtubeMetadataFresh = platform !== SOURCE_PLATFORM_YOUTUBE || youtubeMetadataIdentifiers?.contentId && youtubeMetadataIdentifiers.contentId === identifiers.contentId;
      const pageTitle = cleanPageTitle(
        (youtubeMetadataFresh ? readMeta(
          "meta[property='og:title']",
          "meta[name='twitter:title']"
        ) : "") || document.title,
        platform
      );
      const titleParts = pageTitle.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
      const [liveMetadata, vodMetadata] = platform === SOURCE_PLATFORM_CHZZK ? await Promise.all([
        identifiers.contentType === "live" ? fetchLiveMetadata(identifiers.channelId) : null,
        identifiers.contentType === "vod" ? fetchVodMetadata(identifiers.contentId) : null
      ]) : [null, null];
      if (location.href !== requestedUrl) {
        throw new Error(
          "\uC601\uC0C1 \uD398\uC774\uC9C0\uAC00 \uC804\uD658\uB418\uB294 \uC911\uC785\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694."
        );
      }
      const metadataChannel = liveMetadata?.channel || vodMetadata?.channel || null;
      const channelId = platform === SOURCE_PLATFORM_YOUTUBE ? (youtubeMetadataFresh ? readMeta(
        "meta[itemprop='channelId']",
        "meta[itemprop='identifier']"
      ) : "") || identifiers.channelId : metadataChannel?.channelId || identifiers.channelId;
      const hasCreatorTitlePair = platform === SOURCE_PLATFORM_CHZZK && ["live", "vod", "clip"].includes(identifiers.contentType) && titleParts.length >= 2;
      const streamerName = platform === SOURCE_PLATFORM_YOUTUBE ? readText(
        "#owner #channel-name a",
        "ytd-channel-name a",
        "#channel-name #text"
      ) || (youtubeMetadataFresh ? readMeta("meta[itemprop='author']", "meta[name='author']") : "") : metadataChannel?.channelName || (hasCreatorTitlePair ? titleParts[0] : "");
      const broadcastTitle = platform === SOURCE_PLATFORM_YOUTUBE ? pageTitle : liveMetadata?.liveTitle || vodMetadata?.videoTitle || (hasCreatorTitlePair ? titleParts.slice(1).join(" - ") : pageTitle);
      const description = platform === SOURCE_PLATFORM_YOUTUBE && !youtubeMetadataFresh ? "" : readMeta(
        "meta[property='og:description']",
        "meta[name='description']"
      );
      const imageUrl = platform === SOURCE_PLATFORM_YOUTUBE && !youtubeMetadataFresh ? "" : readMeta(
        "meta[property='og:image']",
        "meta[name='twitter:image']"
      );
      const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
      const rawPlayer = readPlayer(platform, {
        youtubeMetadataFresh
      });
      const normalizedPlayer = platform === SOURCE_PLATFORM_CHZZK && identifiers.contentType === "live" ? normalizeLivePlayerPosition(
        rawPlayer,
        liveMetadata,
        capturedAt
      ) : rawPlayer;
      const contentType = platform === SOURCE_PLATFORM_YOUTUBE && normalizedPlayer.liveInProgress ? "live" : identifiers.contentType;
      const player = contentType === "live" ? normalizedPlayer : {
        ...normalizedPlayer,
        liveEdgeOffsetSeconds: null
      };
      if (platform === SOURCE_PLATFORM_YOUTUBE) {
        const activeVideoId = readActiveYouTubeVideoId();
        if (activeVideoId && activeVideoId !== identifiers.contentId) {
          throw new Error(
            "YouTube \uC601\uC0C1\uC774 \uC804\uD658\uB418\uB294 \uC911\uC785\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694."
          );
        }
      }
      if (location.href !== requestedUrl) {
        throw new Error(
          "\uC601\uC0C1 \uD398\uC774\uC9C0\uAC00 \uC804\uD658\uB418\uB294 \uC911\uC785\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694."
        );
      }
      return {
        platform,
        url: requestedUrl,
        canonicalUrl: canonicalSourceUrl(requestedUrl, identifiers),
        pageTitle,
        streamerName,
        broadcastTitle,
        description,
        imageUrl,
        channelId,
        contentId: identifiers.contentId,
        contentType,
        broadcastStartedAt: liveMetadata?.openDate || vodMetadata?.liveOpenDate || "",
        clipActive: typeof (liveMetadata?.clipActive ?? vodMetadata?.clipActive) === "boolean" ? liveMetadata?.clipActive ?? vodMetadata?.clipActive : null,
        timeMachineActive: typeof liveMetadata?.timeMachineActive === "boolean" ? liveMetadata.timeMachineActive : null,
        category: liveMetadata?.liveCategoryValue || vodMetadata?.videoCategoryValue || "",
        capturedAt,
        player
      };
    };
    const applyPlayerCommand = async (message) => {
      const platform = sourcePlatformFromUrl(location.href);
      const video = choosePrimaryVideo();
      if (!video) {
        throw new Error("\uC601\uC0C1 \uD50C\uB808\uC774\uC5B4\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      }
      if (platform === SOURCE_PLATFORM_YOUTUBE && youtubeAdActive()) {
        throw new Error(
          "YouTube \uAD11\uACE0 \uC7AC\uC0DD \uC911\uC5D0\uB294 \uC6D0\uBCF8 \uC2DC\uAC01\uC744 \uC81C\uC5B4\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
        );
      }
      if (message.action === "play") {
        await video.play();
      } else if (message.action === "pause") {
        video.pause();
      } else if (message.action === "seek") {
        if (!Number.isFinite(message.positionSeconds) || message.positionSeconds < 0) {
          throw new Error("\uC774\uB3D9\uD560 \uC601\uC0C1 \uC2DC\uAC01\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        }
        const identifiers = inferSourceIdentifiers(location.href);
        let target = message.positionSeconds;
        if (platform === SOURCE_PLATFORM_CHZZK && identifiers.contentType === "live") {
          const context = await getContext();
          const normalizedPosition = context.player?.positionSeconds;
          if (Number.isFinite(normalizedPosition)) {
            target = video.currentTime + message.positionSeconds - normalizedPosition;
          }
        }
        if (video.seekable.length > 0) {
          const start = video.seekable.start(0);
          const end = video.seekable.end(
            video.seekable.length - 1
          );
          target = Math.min(end, Math.max(start, target));
        }
        video.currentTime = target;
      } else {
        throw new Error(
          `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD50C\uB808\uC774\uC5B4 \uBA85\uB839\uC785\uB2C8\uB2E4: ${message.action}`
        );
      }
      return {
        paused: video.paused,
        currentTime: video.currentTime
      };
    };
    chrome.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {
        if (message?.type === "KIRINUKI_GET_CONTEXT") {
          void getContext().then((context) => sendResponse({ ok: true, context })).catch((error) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }));
          return true;
        }
        if (message?.type === "KIRINUKI_PLAYER_COMMAND") {
          void applyPlayerCommand(message).then((player) => sendResponse({ ok: true, player })).catch((error) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }));
          return true;
        }
        return false;
      }
    );
  }
})();
