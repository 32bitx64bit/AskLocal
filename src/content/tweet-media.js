import { api } from "./api.js";
import {
  uniqueBy
} from "./dom-utils.js";
import {
  isVisibleRect
} from "./panel-controller.js";
import {
  findOwnedElement,
  findOwnedElements
} from "./tweet-extract.js";
import {
  getCachedTweetAudioUrls,
  getCachedTweetVideoUrls
} from "./x-video-cache.js";

export function extractTweetMedia(article, meta) {
  const media = [];
  const exclude = meta.exclude ?? null;

  findOwnedElements(article, 'img[src*="twimg.com/media"], img[src*="pbs.twimg.com/media"], [data-testid="tweetPhoto"] img', exclude)
    .filter((image) => isLikelyTweetImage(image, article))
    .forEach((image, index) => {
      const url = normalizeTweetImageUrl(image.currentSrc || image.src);
      if (!url) return;
      media.push({
        id: `media:${meta.contextId}:image:${index + 1}`,
        type: "image",
        mediaType: "image",
        url,
        imageUrl: url,
        altText: image.alt || image.getAttribute("aria-label") || "",
        label: image.closest('[aria-label]')?.getAttribute("aria-label") || "",
        width: image.naturalWidth || Math.round(image.getBoundingClientRect().width),
        height: image.naturalHeight || Math.round(image.getBoundingClientRect().height),
        sequenceIndex: index
      });
    });

  findOwnedElements(article, "video", exclude)
    .filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .forEach((video, index) => {
      const posterUrl = normalizeMediaUrlForContext(video.poster);
      const mediaId = extractTweetVideoMediaId(posterUrl);
      const rawVideoUrls = findRawTweetVideoUrls(video, article, index, {
        statusId: meta.statusId,
        mediaId
      });
      const rawAudioUrls = findRawTweetAudioUrls(video, article, index, {
        statusId: meta.statusId,
        mediaId
      });
      const srcUrl = rawVideoUrls[0] || normalizeMediaUrlForContext(video.currentSrc || video.src);
      media.push({
        id: `media:${meta.contextId}:video:${index + 1}`,
        type: "video",
        mediaType: "video",
        url: posterUrl || srcUrl,
        posterUrl,
        srcUrl,
        rawVideoUrls,
        rawAudioUrls,
        mediaId: mediaId || extractTweetVideoMediaId(srcUrl),
        altText: video.getAttribute("aria-label") || video.title || "",
        label: video.getAttribute("aria-label") || video.closest('[aria-label]')?.getAttribute("aria-label") || "",
        width: video.videoWidth || Math.round(video.getBoundingClientRect().width),
        height: video.videoHeight || Math.round(video.getBoundingClientRect().height),
        duration: Number.isFinite(video.duration) ? video.duration : null,
        videoSubtitles: meta.videoSubtitles || [],
        sequenceIndex: index
      });
    });

  return uniqueBy(media, (item) => `${item.mediaType}:${item.url || item.id}`).slice(0, 8);
}
export function isLikelyTweetImage(image, article) {
  if (!image.closest("article") || image.closest("article") !== article) return false;
  if (image.closest("button, [role='button']") && !image.closest('[data-testid="tweetPhoto"]')) return false;
  if (image.closest('[data-testid="UserAvatar-Container"], [data-testid="User-Name"], [data-testid="UserName"]')) return false;
  const rect = image.getBoundingClientRect();
  if (!isVisibleRect(rect)) return false;
  if (rect.width < 80 || rect.height < 80) return false;
  const src = image.currentSrc || image.src || "";
  return /(?:pbs|video)\.twimg\.com\/media|twimg\.com\/media/i.test(src) || Boolean(image.closest('[data-testid="tweetPhoto"]'));
}
export function normalizeTweetImageUrl(value) {
  const url = normalizeMediaUrlForContext(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("twimg.com")) {
      if (!parsed.searchParams.has("name")) parsed.searchParams.set("name", "large");
      if (parsed.searchParams.get("name") === "small") parsed.searchParams.set("name", "large");
    }
    return parsed.href;
  } catch {
    return url;
  }
}
export function normalizeMediaUrlForContext(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("blob:")) return "";
  try {
    const url = new URL(raw, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}
export function findRawTweetVideoUrls(video, article, index = 0, meta = {}) {
  const direct = normalizeMediaUrlForContext(video.currentSrc || video.src);
  const urls = [];
  const add = (url) => {
    if (!isPlayableTweetVideoUrl(url)) return;
    if (urls.some((existing) => normalizeResourceVideoIdentity(existing) === normalizeResourceVideoIdentity(url))) return;
    urls.push(url);
  };
  add(direct);
  getCachedTweetVideoUrls(meta).forEach(add);
  getMatchingRawTweetVideoResourceUrls(meta).forEach(add);
  return urls;
}
export function findRawTweetAudioUrls(video, article, index = 0, meta = {}) {
  const urls = [];
  const add = (url) => {
    if (!isPlayableTweetAudioUrl(url)) return;
    if (urls.some((existing) => normalizeResourceVideoIdentity(existing) === normalizeResourceVideoIdentity(url))) return;
    urls.push(url);
  };
  getCachedTweetAudioUrls(meta).forEach(add);
  getMatchingRawTweetAudioResourceUrls(meta).forEach(add);
  return urls;
}
export function getMatchingRawTweetVideoResourceUrls(meta = {}) {
  const mediaId = String(meta.mediaId || "");
  if (!mediaId) return [];
  return getRawTweetVideoResourceUrls()
    .filter((url) => extractTweetVideoMediaId(url) === mediaId);
}
export function getMatchingRawTweetAudioResourceUrls(meta = {}) {
  const mediaId = String(meta.mediaId || "");
  if (!mediaId) return [];
  return getRawTweetAudioResourceUrls()
    .filter((url) => extractTweetVideoMediaId(url) === mediaId);
}
export function getRawTweetVideoResourceUrls() {
  let entries = [];
  try {
    entries = performance.getEntriesByType("resource") || [];
  } catch {
    entries = [];
  }

  return uniqueBy(
    entries
      .map((entry) => normalizeMediaUrlForContext(entry?.name))
      .filter(isPlayableTweetVideoUrl)
      .sort((left, right) => scoreRawTweetVideoUrl(right) - scoreRawTweetVideoUrl(left)),
    (url) => normalizeResourceVideoIdentity(url)
  );
}
export function getRawTweetAudioResourceUrls() {
  let entries = [];
  try {
    entries = performance.getEntriesByType("resource") || [];
  } catch {
    entries = [];
  }

  return uniqueBy(
    entries
      .map((entry) => normalizeMediaUrlForContext(entry?.name))
      .filter(isPlayableTweetAudioUrl)
      .sort((left, right) => scoreRawTweetVideoUrl(right) - scoreRawTweetVideoUrl(left)),
    (url) => normalizeResourceVideoIdentity(url)
  );
}
export function isPlayableTweetVideoUrl(value) {
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
}
export function isPlayableTweetAudioUrl(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname;
    return /(^|\.)video\.twimg\.com$/i.test(url.hostname)
      && /\/aud\//i.test(pathname)
      && /\.(mp4|m4a|m4v|aac|mp3|webm)$/i.test(pathname);
  } catch {
    return false;
  }
}
export function extractTweetVideoMediaId(value) {
  try {
    const url = new URL(value);
    return url.pathname.match(/\/(?:amplify_video|ext_tw_video|tweet_video|tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\/([^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}
export function scoreRawTweetVideoUrl(value) {
  try {
    const url = new URL(value);
    const text = `${url.pathname} ${url.search}`.toLowerCase();
    const bitrate = Number(text.match(/(?:^|[_-])(\d{3,5})k(?:[_-]|\.)/)?.[1] || 0);
    const resolution = Number(text.match(/(\d{3,4})x(\d{3,4})/)?.[2] || 0);
    return bitrate || resolution || 1;
  } catch {
    return 0;
  }
}
export function scoreTweetVideoCandidate(candidate) {
  return Number(candidate.bitrate || 0)
    || (Number(candidate.width || 0) * Number(candidate.height || 0))
    || scoreRawTweetVideoUrl(candidate.url);
}
export function widthFromTweetVideoUrl(value) {
  try {
    return Number(new URL(value).pathname.match(/(\d{3,4})x(\d{3,4})/)?.[1] || 0);
  } catch {
    return 0;
  }
}
export function heightFromTweetVideoUrl(value) {
  try {
    return Number(new URL(value).pathname.match(/(\d{3,4})x(\d{3,4})/)?.[2] || 0);
  } catch {
    return 0;
  }
}
export function normalizeResourceVideoIdentity(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return String(value || "");
  }
}
export function extractStatusIdFromUrl(value) {
  return String(value || "").match(/\/status\/(\d+)/)?.[1] ?? "";
}
export function extractVideoSubtitles(article, exclude = null) {
  const subtitles = [];
  const videos = findOwnedElements(article, "video", exclude);

  videos.forEach((video, index) => {
    const trackGroups = extractTextTrackSubtitles(video);
    trackGroups.forEach((group) => {
      subtitles.push({
        source: "Video subtitles",
        videoIndex: index + 1,
        ...group
      });
    });

    const visibleOverlay = extractVisibleSubtitleOverlay(article, video);
    if (visibleOverlay.length > 0) {
      subtitles.push({
        source: "Visible video subtitle overlay",
        videoIndex: index + 1,
        cues: visibleOverlay.map((text, cueIndex) => ({
          index: cueIndex + 1,
          text
        }))
      });
    }
  });

  return dedupeSubtitleGroups(subtitles).slice(0, 4);
}
export function extractTextTrackSubtitles(video) {
  const groups = [];
  const tracks = [...(video.textTracks ?? [])];

  tracks.forEach((track) => {
    try {
      if (track.mode === "disabled") track.mode = "hidden";
    } catch {
      // Some browser-managed tracks cannot be toggled by content scripts.
    }

    let cues = [];
    try {
      cues = [...(track.cues ?? track.activeCues ?? [])];
    } catch {
      cues = [];
    }

    const normalizedCues = cues
      .map((cue, index) => ({
        index: index + 1,
        start: formatCueTime(cue.startTime),
        end: formatCueTime(cue.endTime),
        text: normalizeSubtitleText(cue.text)
      }))
      .filter((cue) => cue.text)
      .slice(0, 80);

    if (normalizedCues.length > 0) {
      groups.push({
        language: track.language || track.label || "",
        kind: track.kind || "subtitles",
        cues: normalizedCues
      });
    }
  });

  return groups;
}
export function extractVisibleSubtitleOverlay(article, video) {
  const videoRect = video.getBoundingClientRect();
  if (!isVisibleRect(videoRect)) return [];

  const tweetText = findOwnedElement(article, '[data-testid="tweetText"]')?.innerText ?? "";
  const texts = findOwnedElements(article, 'div, span, p')
    .filter((element) => {
      if (element.closest('[data-testid="tweetText"]')) return false;
      if (element.closest("button, a")) return false;
      if (element.children.length > 2) return false;

      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect)) return false;
      const overlapsVideo = rect.left >= videoRect.left - 8
        && rect.right <= videoRect.right + 8
        && rect.top >= videoRect.top - 8
        && rect.bottom <= videoRect.bottom + 48;
      if (!overlapsVideo) return false;

      const text = normalizeSubtitleText(element.innerText || element.textContent);
      if (text.length < 2 || text.length > 240) return false;
      if (tweetText.includes(text)) return false;
      return !isLikelyVideoControlText(text);
    })
    .map((element) => normalizeSubtitleText(element.innerText || element.textContent))
    .filter(Boolean);

  return uniqueBy(texts, (text) => text.toLowerCase()).slice(0, 12);
}
export function isLikelyVideoControlText(text) {
  const normalized = text.toLowerCase();
  return /^(play|pause|mute|unmute|settings|fullscreen|theater mode|captions|subtitles)$/i.test(text)
    || /^\d{1,2}:\d{2}(?:\s*\/\s*\d{1,2}:\d{2})?$/.test(normalized)
    || normalized.includes("views");
}
export function normalizeSubtitleText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function formatCueTime(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
export function dedupeSubtitleGroups(groups) {
  const seen = new Set();
  return groups.filter((group) => {
    const key = group.cues?.map((cue) => cue.text).join("\n").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function urlsMatch(left, right) {
  if (!right) return false;
  try {
    const leftUrl = new URL(left, location.href);
    const rightUrl = new URL(right, location.href);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

