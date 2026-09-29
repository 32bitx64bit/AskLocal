(function installAskLocalXMediaSniffer() {
  if (window.__ASKLOCAL_X_MEDIA_SNIFFER__) return;
  window.__ASKLOCAL_X_MEDIA_SNIFFER__ = true;

  const candidates = [];

  const postCandidates = () => {
    if (!candidates.length) return;
    window.postMessage({
      source: "asklocal:x-media",
      type: "video-variants",
      candidates: candidates.slice(-300)
    }, "*");
  };

  const normalizeUrl = (value) => {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  };

  const isPlayableTweetVideoUrl = (value) => {
    try {
      const url = new URL(value);
      const pathname = url.pathname;
      return /(^|\.)video\.twimg\.com$/i.test(url.hostname)
        && /\.(mp4|m4v|webm)$/i.test(pathname)
        && !/\/aud\//i.test(pathname)
        && !/\/vid\/[^/]+\/0\/0\//i.test(pathname);
    } catch {
      return false;
    }
  };

  const isPlayableTweetAudioUrl = (value) => {
    try {
      const url = new URL(value);
      const pathname = url.pathname;
      return /(^|\.)video\.twimg\.com$/i.test(url.hostname)
        && /\/aud\//i.test(pathname)
        && /\.(mp4|m4a|m4v|aac|mp3|webm)$/i.test(pathname);
    } catch {
      return false;
    }
  };

  const extractMediaId = (value) => {
    try {
      const url = new URL(value);
      return url.pathname.match(/\/(?:amplify_video|ext_tw_video|tweet_video|tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\/([^/]+)/)?.[1] || "";
    } catch {
      return "";
    }
  };

  const dimensionsFromUrl = (value) => {
    try {
      const match = new URL(value).pathname.match(/(\d{3,4})x(\d{3,4})/);
      return {
        width: Number(match?.[1] || 0),
        height: Number(match?.[2] || 0)
      };
    } catch {
      return { width: 0, height: 0 };
    }
  };

  const addCandidate = (urlValue, context = {}) => {
    const url = normalizeUrl(urlValue);
    const isAudio = isPlayableTweetAudioUrl(url);
    if (!isAudio && !isPlayableTweetVideoUrl(url)) return;
    const key = url.replace(/[?#].*$/, "");
    if (candidates.some((candidate) => candidate.key === key)) return;
    const dimensions = dimensionsFromUrl(url);
    candidates.push({
      key,
      url,
      kind: isAudio ? "audio" : "video",
      statusId: String(context.statusId || ""),
      mediaId: String(context.mediaId || extractMediaId(url) || ""),
      bitrate: Number(context.bitrate || 0) || 0,
      width: Number(context.width || 0) || dimensions.width,
      height: Number(context.height || 0) || dimensions.height,
      source: String(context.source || "x_api")
    });
  };

  const isTweetLikeObject = (node) => {
    return Boolean(node && typeof node === "object" && (
      node.legacy?.extended_entities
      || node.extended_entities
      || node.legacy?.full_text
      || node.full_text
      || node.tweet?.legacy
      || node.tweet_results
    ));
  };

  const walkJson = (node, context = {}, seen = new WeakSet()) => {
    if (!node) return;

    if (typeof node === "string") {
      addCandidate(node, context);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => walkJson(item, context, seen));
      return;
    }

    if (typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    let next = context;
    const statusId = String(
      (isTweetLikeObject(node) && (node.rest_id || node.id_str || node.id))
      || context.statusId
      || ""
    );
    const mediaId = String(
      extractMediaId(node.media_url_https)
      || extractMediaId(node.media_url)
      || extractMediaId(node.thumbnail_url)
      || extractMediaId(node.thumbnailUrl)
      || (node.video_info || node.media_url_https || node.media_url ? (node.id_str || node.id || "") : "")
      || context.mediaId
      || ""
    );
    if (statusId !== context.statusId || mediaId !== context.mediaId) {
      next = { ...context, statusId, mediaId };
    }

    const variants = node.video_info?.variants || node.videoInfo?.variants || node.variants;
    if (Array.isArray(variants)) {
      variants.forEach((variant) => {
        addCandidate(variant?.url, {
          ...next,
          bitrate: variant?.bitrate || variant?.bit_rate || 0,
          source: "x_video_info"
        });
      });
    }

    if (node.url) addCandidate(node.url, next);
    if (node.media_url_https) addCandidate(node.media_url_https, next);

    Object.values(node).forEach((child) => walkJson(child, next, seen));
  };

  const inspectJsonText = (text) => {
    if (!text || text.length < 2) return;
    try {
      walkJson(JSON.parse(text));
      postCandidates();
    } catch {
      // Ignore non-JSON responses.
    }
  };

  const shouldInspectUrl = (value) => {
    const url = String(value || "");
    return /\/i\/api\//.test(url)
      || /\/graphql\//.test(url)
      || /TweetDetail|HomeTimeline|UserTweets|SearchTimeline|Adaptive/i.test(url)
      || /video\.twimg\.com/i.test(url);
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function askLocalFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      return originalFetch.apply(this, arguments).then((response) => {
        if (shouldInspectUrl(url || response.url)) {
          addCandidate(url || response.url, { source: "resource" });
          response.clone().text().then(inspectJsonText).catch(() => {});
        }
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function askLocalOpen(method, url) {
    this.__asklocalUrl = String(url || "");
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function askLocalSend() {
    if (shouldInspectUrl(this.__asklocalUrl)) {
      this.addEventListener("loadend", () => {
        addCandidate(this.__asklocalUrl, { source: "resource" });
        inspectJsonText(this.responseText);
      });
    }
    return originalSend.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source === "asklocal:content" && event.data?.type === "request-video-cache") {
      postCandidates();
    }
  });
})();
