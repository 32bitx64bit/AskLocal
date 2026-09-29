import { api } from "./api.js";
import {
  MAX_VIDEO_CAPTURE_MS,
  MIN_VIDEO_FRAME_INTERVAL_SECONDS
} from "./constants.js";
import {
  uniqueBy
} from "./dom-utils.js";
import {
  isVisibleRect
} from "./panel-controller.js";
import {
  state
} from "./state.js";
import {
  extractTweet,
  findOwnedElements
} from "./tweet-extract.js";
import {
  extractTweetVideoMediaId,
  findRawTweetAudioUrls,
  findRawTweetVideoUrls,
  normalizeMediaUrlForContext,
  urlsMatch
} from "./tweet-media.js";
import {
  queryTweetArticles,
  shouldSkipArticle
} from "./tweet-mount.js";

export async function collectMediaCapture(payload = {}) {
  const mediaType = String(payload.mediaType || "").toLowerCase();
  if (mediaType && mediaType !== "video") {
    return { source: "active_tab_media_capture", frames: [], error: "Only video frame capture is supported from the active tab." };
  }

  const target = findVideoCaptureTarget(payload);
  if (!target) {
    return { source: "active_tab_video_capture", frames: [], error: "Could not find the requested visible video in the active tab." };
  }

  if (payload.metadataOnly) {
    const mediaId = extractTweetVideoMediaId(target.video.poster);
    const rawVideoUrls = findRawTweetVideoUrls(target.video, target.article, target.index, {
      statusId: target.tweet.statusId,
      mediaId
    });
    const rawAudioUrls = findRawTweetAudioUrls(target.video, target.article, target.index, {
      statusId: target.tweet.statusId,
      mediaId
    });
    return {
      source: "active_tab_video_capture_metadata",
      id: target.id,
      contextId: target.tweet.contextId,
      statusId: target.tweet.statusId,
      url: target.tweet.url,
      srcUrl: rawVideoUrls[0] || normalizeMediaUrlForContext(target.video.currentSrc || target.video.src),
      rawVideoUrl: rawVideoUrls[0] || "",
      rawVideoUrls,
      rawAudioUrls,
      mediaId: mediaId || extractTweetVideoMediaId(rawVideoUrls[0] || target.video.currentSrc || target.video.src),
      frames: []
    };
  }

  const maxFrames = Math.floor(clampNumeric(payload.maxFrames, 0, Infinity, 36));
  const frameIntervalSeconds = clampNumeric(payload.frameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, 1);
  const framesPerMinute = Math.floor(clampNumeric(payload.framesPerMinute, 0, Infinity, 12));
  const capture = await captureVideoFrames(target.video, {
    maxFrames,
    framesPerMinute,
    frameIntervalSeconds
  });

  return {
    source: "active_tab_video_capture",
    id: target.id,
    contextId: target.tweet.contextId,
    statusId: target.tweet.statusId,
    url: target.tweet.url,
    frameIntervalSeconds,
    ...capture
  };
}
export function findVideoCaptureTarget(payload = {}) {
  const requestedId = String(payload.id || "").trim();
  const requestedContextId = String(payload.contextId || payload.context_id || "").trim();
  const requestedStatusId = String(payload.statusId || payload.status_id || "").trim();
  const requestedUrl = String(payload.url || "").trim();

  for (const article of queryTweetArticles()) {
    if (shouldSkipArticle(article)) continue;
    const tweet = extractTweet(article);
    if (requestedContextId && tweet.contextId !== requestedContextId) continue;
    if (requestedStatusId && tweet.statusId !== requestedStatusId) continue;

    const videos = findOwnedElements(article, "video")
      .filter((video) => isVisibleRect(video.getBoundingClientRect()));

    for (const [index, video] of videos.entries()) {
      const id = `media:${tweet.contextId}:video:${index + 1}`;
      const urls = [
        normalizeMediaUrlForContext(video.poster),
        normalizeMediaUrlForContext(video.currentSrc || video.src),
        tweet.url
      ].filter(Boolean);
      const matches = (!requestedId && !requestedContextId && !requestedStatusId && !requestedUrl)
        || requestedId === id
        || requestedContextId === tweet.contextId
        || requestedStatusId === tweet.statusId
        || urls.some((url) => urlsMatch(url, requestedUrl));
      if (matches) return { article, tweet, video, id, index };
    }
  }

  return null;
}
export async function captureVideoFrames(video, options) {
  const maxFrames = Math.floor(clampNumeric(options.maxFrames, 0, Infinity, 36));
  const frameIntervalSeconds = clampNumeric(options.frameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, 1);
  const framesPerMinute = Math.floor(clampNumeric(options.framesPerMinute, 0, Infinity, 12));
  const frames = [];
  const errors = [];

  await waitForVideoMetadata(video, 3500);
  const wasPaused = video.paused;
  const startTime = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;

  // Deliberately never pause, seek, or mute this element: it's the video the user is
  // actually watching, and doing so is what caused playback to visibly jump around
  // during analysis. Instead we ride along with whatever it naturally plays next.
  const times = buildForwardVideoFrameTimes(video, startTime, maxFrames, frameIntervalSeconds, framesPerMinute);
  const captureBudgetMs = Math.min(
    MAX_VIDEO_CAPTURE_MS,
    Math.max(1000, (Math.max(...times, startTime) - startTime) * 1000 + 4000)
  );
  const deadline = performance.now() + captureBudgetMs;

  try {
    if (wasPaused) {
      try {
        await video.play();
      } catch {
        errors.push("Could not resume playback to sample frames; capturing the current frame only.");
        const frame = drawVideoFrame(video, video.currentTime);
        if (frame) frames.push(frame);
        else errors.push("The current video frame could not be read from the active tab.");
        return { frames, frameCount: frames.length, errors };
      }
    }

    for (const targetTime of times) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        errors.push(`Stopped after ${formatTimestamp((captureBudgetMs / 1000))} of playback; later frames were skipped.`);
        break;
      }
      const reached = await waitForPlaybackTime(video, targetTime, remainingMs);
      if (!reached) {
        errors.push(`Ran out of time waiting to reach ${formatTimestamp(targetTime)}.`);
        break;
      }
      const frame = drawVideoFrame(video, video.currentTime);
      if (frame) frames.push(frame);
      else errors.push(`Could not read the video frame at ${formatTimestamp(video.currentTime)}.`);
    }
  } finally {
    if (wasPaused && !video.paused) {
      try {
        video.pause();
      } catch {
        // Best-effort restoration of the original paused state.
      }
    }
  }

  return {
    frames,
    frameCount: frames.length,
    errors
  };
}
export function buildForwardVideoFrameTimes(video, startTime, maxFrames, frameIntervalSeconds, framesPerMinute) {
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  if (!duration || duration <= startTime) return [startTime];

  const frameLimit = resolveEffectiveFrameCount(maxFrames, framesPerMinute, duration);
  const fpm = Math.max(0, Number(framesPerMinute) || 0);
  const interval = fpm > 0
    ? clampNumeric(60 / fpm, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, frameIntervalSeconds)
    : clampNumeric(frameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, 1);
  const times = [];
  for (let time = startTime; time <= duration + 0.05; time += interval) {
    times.push(Math.min(duration, Number(time.toFixed(3))));
    if (frameLimit > 0 && times.length >= frameLimit) break;
    if (times.length >= 1000) break;
  }
  if (!times.length) times.push(startTime);
  return uniqueBy(times, (time) => Number(time).toFixed(3));
}
export function waitForPlaybackTime(video, targetTime, timeoutMs) {
  return new Promise((resolve) => {
    if (video.ended || video.currentTime >= targetTime - 0.05) {
      resolve(true);
      return;
    }

    let settled = false;
    const cleanup = () => {
      video.removeEventListener("timeupdate", check);
      video.removeEventListener("ended", onEnded);
      window.clearTimeout(timeout);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const check = () => {
      if (video.currentTime >= targetTime - 0.05) finish(true);
    };
    const onEnded = () => finish(true);
    const timeout = window.setTimeout(() => finish(false), Math.max(0, timeoutMs));

    video.addEventListener("timeupdate", check);
    video.addEventListener("ended", onEnded);
  });
}
export function resolveEffectiveFrameCount(maxFrames, framesPerMinute, durationSeconds) {
  const hardLimit = Math.max(0, Math.floor(Number(maxFrames) || 0));
  const fpm = Math.max(0, Number(framesPerMinute) || 0);
  if (fpm <= 0) return hardLimit;
  const fpmCount = Math.max(1, Math.round((fpm * durationSeconds) / 60));
  return hardLimit === 0 ? fpmCount : Math.min(fpmCount, hardLimit);
}
export async function waitForVideoMetadata(video, timeoutMs) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && (video.videoWidth || video.videoHeight)) return;
  await waitForMediaEvent(video, ["loadedmetadata", "loadeddata", "canplay"], timeoutMs);
}
export function waitForMediaEvent(media, eventNames, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      eventNames.forEach((eventName) => media.removeEventListener(eventName, done));
      window.clearTimeout(timeout);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timeout = window.setTimeout(done, timeoutMs);
    eventNames.forEach((eventName) => media.addEventListener(eventName, done, { once: true }));
  });
}
export function drawVideoFrame(video, timestampSeconds) {
  try {
    const rect = video.getBoundingClientRect();
    const sourceWidth = video.videoWidth || Math.round(rect.width) || 640;
    const sourceHeight = video.videoHeight || Math.round(rect.height) || 360;
    const { width, height } = fitFrameDimensions(sourceWidth, sourceHeight, 720);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    const seconds = Number.isFinite(Number(timestampSeconds)) ? Number(timestampSeconds) : 0;
    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.72),
      mimeType: "image/jpeg",
      label: `video frame ${formatTimestamp(seconds)}`,
      timestampSeconds: Number(seconds.toFixed(3)),
      timestamp: formatTimestamp(seconds),
      width,
      height
    };
  } catch {
    // Cross-origin/blob-backed X videos can taint the canvas in the active tab.
    // Background raw-URL capture is the primary path; active-tab capture is fallback only.
    return null;
  }
}
export function fitFrameDimensions(width, height, maxSide) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maxSide / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  };
}
export function formatTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const totalTenths = Math.round(value * 10);
  const whole = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}${tenths ? `.${tenths}` : ""}`;
}
export function clampNumeric(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

