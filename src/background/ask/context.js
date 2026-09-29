import { api } from "../api.js";
import {
  extractStatusIdFromUrl,
  inferMediaTypeFromUrl,
  isAllowedHttpUrl,
  normalizeMediaUrl,
  normalizeRawAudioUrls,
  normalizeRawVideoUrls
} from "../../lib/url.js";
import {
  throwIfAborted,
  uniqueBy
} from "../../lib/utils.js";
import {
  analyzeImageTool,
  loadImageForAnalysis
} from "../media/image.js";
import {
  analyzeVideoTool,
  extractTweetVideoMediaId
} from "../media/video.js";
import {
  inferPromptPresetFromQuestion,
  normalizePromptPreset,
  pruneEmptyValues
} from "../prompt/build.js";
import {
  normalizeConversationHistory
} from "../prompt/history.js";
import {
  buildInspectableItems,
  normalizeMediaType,
  summarizeMediaTarget
} from "../tools/inspectables.js";
import {
  collectWebPageInBackground
} from "../web/readable.js";
import {
  collectProfileInBackground,
  collectXPostContextInBackground
} from "../x/collect.js";

export async function buildContext(payload, settings) {
  const context = {
    sourceTabId: payload.sourceTabId ?? null,
    mediaSessionId: String(payload.mediaSessionId || payload.requestId || "").trim(),
    chatId: String(payload.chatId || "").trim(),
    sourcePage: payload.page ?? null,
    originalQuestion: String(payload.question || "").trim(),
    promptPreset: normalizePromptPreset(payload.promptPreset) || inferPromptPresetFromQuestion(payload.question),
    conversationHistory: normalizeConversationHistory(payload.conversationHistory),
    currentTweet: settings.includeCurrentTweet ? payload.tweet ?? null : null,
    visibleThread: settings.includeVisibleThread && shouldUseVisibleThread(payload) ? payload.visibleThread ?? [] : [],
    quotedTweet: settings.includeQuotedTweet ? payload.quotedTweet ?? null : null,
    xPostContext: null,
    cachedProfiles: null,
    backgroundProfiles: null,
    deepThreads: [],
    searchResults: [],
    webReads: [],
    mediaAnalyses: [],
    inlineImages: [],
    automaticMedia: {
      enabled: true,
      selectedCount: 0,
      attachedImageCount: 0,
      analyzedImageCount: 0,
      analyzedVideoCount: 0,
      analyzedAudioCount: 0,
      cachedImageCount: 0,
      cachedAnalysisCount: 0,
      errors: []
    },
    toolDiagnostics: {
      offered: [],
      toolChoiceRejected: false,
      calls: [],
      responseTurns: []
    },
    toolResultCache: new Map(),
    toolEvidence: [],
    maxMultiLinks: settings.maxMultiLinks
  };

  // Author profiles (cached visits and optional background scans) load in
  // hydrateThreadAuthorProfiles, only on turns that attach full post context.
  normalizeContextTweets(context);
  return context;
}
export async function prepareAutomaticMediaContext(context, settings, progress) {
  const media = getSelectedAutomaticMedia(context);
  context.automaticMedia.selectedCount = media.length;
  if (!media.length) return;

  const images = media.filter((item) => item.mediaType === "image");
  const videos = media.filter((item) => item.mediaType === "video");

  if (images.length && settings.allowImageAnalysis) {
    // Always run an explicit analysis (mirroring automatic video handling below) so every
    // selected image ends up with a readable description in context, not just raw bytes
    // that a non-vision base model would silently ignore.
    await analyzeAutomaticImages(context, settings, images, progress);
    if (shouldAttachImagesToMainProvider(settings)) {
      await progress?.(`Loading ${images.length} selected image${images.length === 1 ? "" : "s"}...`);
      await attachAutomaticImages(context, images);
    }
  }

  if (videos.length && settings.allowVideoAnalysis) {
    await analyzeAutomaticVideos(context, settings, videos, progress);
  }
}
export async function prepareAutomaticLinkContext(context, settings, progress) {
  if (!settings.autoReadLinks) return;
  if (!context.currentTweet) return;

  const seen = new Set();
  const candidates = [];

  const add = (url, title) => {
    if (!url || !isAllowedHttpUrl(url)) return;
    try {
      const parsed = new URL(url);
      if (/(^|\.)x\.com$/.test(parsed.hostname) || /(^|\.)twitter\.com$/.test(parsed.hostname)) return;
    } catch { return; }
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, title: String(title || "").slice(0, 160) });
  };

  (context.currentTweet.links ?? []).forEach((link) => add(link.url, link.displayUrl));
  if (context.currentTweet.card?.url) add(context.currentTweet.card.url, context.currentTweet.card.title);

  // Keep it fast: at most 2 links for the current post.
  const toFetch = candidates.slice(0, 2);
  for (const [index, candidate] of toFetch.entries()) {
    throwIfAborted(context.abortSignal);
    try {
      await progress?.(`Reading linked article ${index + 1} of ${toFetch.length}...`);
      const maxChars = 8000;
      const page = await collectWebPageInBackground(candidate.url, maxChars);
      const result = {
        ok: page.ok,
        tool: "automatic_link_read",
        type: "link",
        target: { url: candidate.url, title: candidate.title },
        page
      };
      context.webReads.push(result);
    } catch (error) {
      context.webReads.push({
        ok: false,
        tool: "automatic_link_read",
        type: "link",
        target: { url: candidate.url, title: candidate.title },
        page: { url: candidate.url, error: error.message || "Failed to read article." },
        error: error.message || "Failed to read article."
      });
    }
  }
}
export async function prepareXPostContext(context, settings, progress) {
  const statusId = context.currentTweet?.statusId || extractStatusIdFromUrl(context.currentTweet?.url) || extractStatusIdFromUrl(context.sourcePage?.url);
  if (!statusId) return;
  if (!settings.includeCurrentTweet && !settings.includeVisibleThread && !settings.includeQuotedTweet) return;

  try {
    await progress?.("Reading X post context...");
    const xContext = await collectXPostContextInBackground({
      statusId,
      url: context.currentTweet?.url || context.sourcePage?.url,
      authorHandle: context.currentTweet?.authorHandle || ""
    }, {
      maxReplies: 12,
      maxRankedReplies: 8,
      maxPages: 2
    }, context);

    context.xPostContext = xContext;
    if (xContext?.ok) {
      mergeXPostContextIntoAskContext(context, xContext, settings);
    }
  } catch (error) {
    context.xPostContext = {
      ok: false,
      source: "x_graphql_tweet_detail",
      rootStatusId: statusId,
      url: context.currentTweet?.url || context.sourcePage?.url || "",
      collectedAt: new Date().toISOString(),
      error: error.message || "Could not read X post context."
    };
  }
}
/**
 * Hydrate profiles for every thread author, not just the selected post's author:
 * cached profiles load unconditionally; fresh background scans only when enabled.
 */
export async function hydrateThreadAuthorProfiles(context, settings) {
  const clean = (handle) => String(handle || "").replace(/^@/, "").trim();
  const handles = uniqueBy([
    clean(context.currentTweet?.authorHandle),
    clean(context.xPostContext?.conversationRoot?.authorHandle),
    ...(context.xPostContext?.topLikedReplies ?? []).map((tweet) => clean(tweet?.authorHandle))
  ].filter(Boolean), (handle) => handle.toLowerCase()).slice(0, 8);
  if (!handles.length) return;

  const keys = handles.map((handle) => `profile:${handle.toLowerCase()}`);
  const stored = await api.storage.local.get(keys).catch(() => ({}));
  const cachedProfiles = {};
  for (const handle of handles) {
    const profile = stored?.[`profile:${handle.toLowerCase()}`];
    if (profile?.handle) cachedProfiles[handle.toLowerCase()] = profile;
  }
  if (Object.keys(cachedProfiles).length) context.cachedProfiles = cachedProfiles;

  if (!settings.allowBackgroundProfileScan) return;
  const scanHandles = uniqueBy([
    clean(context.currentTweet?.authorHandle),
    clean(context.xPostContext?.conversationRoot?.authorHandle)
  ].filter(Boolean), (handle) => handle.toLowerCase());
  for (const handle of scanHandles) {
    throwIfAborted(context.abortSignal);
    try {
      const profile = await collectProfileInBackground(handle, settings.maxRecentProfilePosts);
      if (profile && !profile.error) {
        context.backgroundProfiles ??= {};
        context.backgroundProfiles[handle.toLowerCase()] = profile;
      }
    } catch {
      // Profile scans are best-effort; cached profiles above still apply.
    }
  }
}
export function mergeXPostContextIntoAskContext(context, xContext, settings) {
  if (xContext.root && settings.includeCurrentTweet) {
    context.currentTweet = mergeContextTweet(context.currentTweet, xContext.root);
  }

  if (xContext.quoted && settings.includeQuotedTweet) {
    context.quotedTweet = mergeContextTweet(context.quotedTweet, xContext.quoted);
  }

  if (settings.includeVisibleThread) {
    const apiThread = [
      ...(xContext.conversationRoot ? [xContext.conversationRoot] : []),
      ...(xContext.parents ?? []),
      ...(xContext.rankedReplies ?? []),
      ...(xContext.topLikedReplies ?? []),
      ...(xContext.rootReplies ?? [])
    ];
    context.visibleThread = uniqueBy([
      ...apiThread,
      ...(context.visibleThread ?? [])
    ], (tweet) => tweet.statusId || tweet.contextId);
  }
}
export function mergeContextTweet(existing, fresh) {
  if (!existing) return fresh;
  if (!fresh) return existing;
  return pruneEmptyValues({
    ...existing,
    ...fresh,
    text: fresh.text || existing.text,
    links: fresh.links?.length ? fresh.links : existing.links,
    card: fresh.card || existing.card,
    media: fresh.media?.length ? fresh.media : existing.media,
    videoSubtitles: fresh.videoSubtitles?.length ? fresh.videoSubtitles : existing.videoSubtitles,
    engagement: fresh.engagement || existing.engagement,
    postedAt: fresh.postedAt || existing.postedAt,
    textTruncated: Boolean(existing.textTruncated || fresh.textTruncated)
  });
}
/**
 * Media to analyze automatically before the main model answers.
 * Always include the selected post's media; when the user clicked a reply/comment,
 * also include the conversation-root (and quoted) media so parent videos are not ignored.
 */
export function getSelectedAutomaticMedia(context) {
  const available = buildInspectableItems(context).media;
  const selected = [];
  const seen = new Set();

  const push = (items) => {
    for (const item of items ?? []) {
      const key = item.id || item.url || item.posterUrl || item.srcUrl || "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
    }
  };

  const currentStatusId = String(context.currentTweet?.statusId
    || extractStatusIdFromUrl(context.currentTweet?.url)
    || context.xPostContext?.focalStatusId
    || "");
  const rootStatusId = String(context.xPostContext?.conversationRoot?.statusId
    || context.xPostContext?.rootStatusId
    || "");
  const quotedStatusId = String(context.quotedTweet?.statusId
    || extractStatusIdFromUrl(context.quotedTweet?.url)
    || context.xPostContext?.quoted?.statusId
    || "");

  const byStatus = (statusId) => statusId
    ? available.filter((item) => String(item.statusId || "") === statusId)
    : [];

  // 1) Selected / clicked post
  push(byStatus(currentStatusId));
  push(available.filter((item) => item.source === "current_post"));

  // 2) Conversation root when focusing a reply (this is the usual "main post has the video" case)
  if (rootStatusId && rootStatusId !== currentStatusId) {
    push(byStatus(rootStatusId));
  }

  // 3) Quoted post media
  push(byStatus(quotedStatusId));
  push(available.filter((item) => item.source === "quoted_post"));

  // Keep auto cost bounded: selected/root/quoted media only, prefer videos then images, cap total.
  const videos = selected.filter((item) => item.mediaType === "video");
  const images = selected.filter((item) => item.mediaType === "image");
  return [...videos.slice(0, 2), ...images.slice(0, 4)];
}
export function shouldAttachImagesToMainProvider(settings) {
  return Boolean(settings.allowImageAnalysis && settings.imageUseBaseProvider);
}
export async function attachAutomaticImages(context, images) {
  for (const image of images) {
    const loaded = await loadImageForAnalysis(image, context);
    if (!loaded.ok) {
      context.automaticMedia.errors.push({
        type: "image",
        id: image.id,
        error: loaded.error
      });
      context.mediaAnalyses.push({
        ok: false,
        tool: "automatic_image_attachment",
        type: "image",
        target: summarizeMediaTarget(image),
        error: loaded.error
      });
      continue;
    }

    context.inlineImages.push({
      ...loaded,
      target: summarizeMediaTarget(image),
      label: image.altText || image.label || loaded.label || "selected tweet image"
    });
    context.automaticMedia.attachedImageCount += 1;
    if (loaded.cached) context.automaticMedia.cachedImageCount += 1;
  }
}
export async function analyzeAutomaticImages(context, settings, images, progress) {
  for (const [index, image] of images.entries()) {
    throwIfAborted(context.abortSignal);
    try {
      await progress?.(`Checking image ${index + 1} of ${images.length}...`);
      const result = await analyzeImageTool({
        id: image.id,
        automatic: true,
        prompt: "Automatic reusable image notes. Prioritize factual visual details, readable text, screenshot/UI/meme structure, notable people/objects/actions, and uncertainty. Do not invent missing text or off-image events. Do not answer the user directly."
      }, context, settings);
      await progress?.(result.cached
        ? `Using cached image analysis ${index + 1} of ${images.length}...`
        : `Analyzing image ${index + 1} of ${images.length}...`);
      if (result.ok) {
        context.automaticMedia.analyzedImageCount += 1;
        if (result.cached) context.automaticMedia.cachedAnalysisCount += 1;
      }
      else context.automaticMedia.errors.push({ type: "image", id: image.id, error: result.error || "Image analysis failed." });
    } catch (error) {
      context.automaticMedia.errors.push({ type: "image", id: image.id, error: error.message });
      context.mediaAnalyses.push({
        ok: false,
        tool: "automatic_image_analysis",
        type: "image",
        target: summarizeMediaTarget(image),
        error: error.message
      });
    }
  }
}
export async function analyzeAutomaticVideos(context, settings, videos, progress) {
  for (const [index, video] of videos.entries()) {
    throwIfAborted(context.abortSignal);
    try {
      await progress?.(`Checking video ${index + 1} of ${videos.length}...`);
      const result = await analyzeVideoTool({
        id: video.id,
        automatic: true,
        prompt: [
          "Produce compact change-based visual notes of this video for another model that cannot see the frames.",
          "Summarize the window, then list only meaningful visual changes and key moments with timestamps — not one detailed bullet per sample.",
          "Prefer provided subtitle/caption cues for speech-like text; OCR only distinct burned-in text that is missing or differs.",
          "Do not invent spoken audio. Be concrete and uncertainty-aware. Do not answer the user directly."
        ].join(" ")
      }, context, settings);
      await progress?.(result.cached
        ? (result.reusedFromPost
          ? `Reusing saved video analysis ${index + 1} of ${videos.length}...`
          : `Using cached video analysis ${index + 1} of ${videos.length}...`)
        : `Processing video ${index + 1} of ${videos.length}...`);
      if (result.ok) {
        context.automaticMedia.analyzedVideoCount += 1;
        if (result.audioMergedIntoAnalysis || result.audioAnalysis) {
          context.automaticMedia.analyzedAudioCount += 1;
        } else if (result.audioError) {
          context.automaticMedia.errors.push({ type: "audio", id: video.id, error: result.audioError });
        }
        if (result.cached) context.automaticMedia.cachedAnalysisCount += 1;
      }
      else context.automaticMedia.errors.push({ type: "video", id: video.id, error: result.error || "Video analysis failed." });
    } catch (error) {
      context.automaticMedia.errors.push({ type: "video", id: video.id, error: error.message });
      context.mediaAnalyses.push({
        ok: false,
        tool: "automatic_video_analysis",
        type: "video",
        target: summarizeMediaTarget(video),
        error: error.message
      });
    }
  }
}
export function shouldUseVisibleThread(payload) {
  const pageStatusId = String(payload.page?.statusId || extractStatusIdFromUrl(payload.page?.url) || "");
  return Boolean(pageStatusId);
}
export function normalizeContextTweets(context) {
  context.currentTweet = normalizeContextTweet(context.currentTweet, "current", 0);
  context.visibleThread = Array.isArray(context.visibleThread)
    ? context.visibleThread.map((tweet, index) => normalizeContextTweet(tweet, "visible", index)).filter(Boolean)
    : [];
  context.quotedTweet = normalizeContextTweet(context.quotedTweet, "quoted", 0);
}
export function normalizeContextTweet(tweet, prefix, index) {
  if (!tweet) return null;
  const statusId = tweet.statusId || extractStatusIdFromUrl(tweet.url);
  const contextId = tweet.contextId || (statusId ? `post:${statusId}` : `${prefix}:${index + 1}`);
  const videoSubtitles = Array.isArray(tweet.videoSubtitles)
    ? tweet.videoSubtitles
      .map(normalizeSubtitleGroup)
      .filter(Boolean)
      .slice(0, 4)
    : [];
  const media = Array.isArray(tweet.media)
    ? tweet.media
      .map((item, mediaIndex) => normalizeTweetMediaItem(item, {
        contextId,
        statusId,
        tweetUrl: tweet.url || "",
        videoSubtitles,
        mediaIndex
      }))
      .filter(Boolean)
      .slice(0, 8)
    : [];

  const links = Array.isArray(tweet.links)
    ? tweet.links
      .filter((link) => isAllowedHttpUrl(link?.url))
      .slice(0, 6)
      .map((link) => ({
        url: link.url,
        displayUrl: String(link.displayUrl || "").slice(0, 160)
      }))
    : [];
  const card = tweet.card && isAllowedHttpUrl(tweet.card.url)
    ? { url: tweet.card.url, title: String(tweet.card.title || "").slice(0, 240) }
    : null;

  return {
    ...tweet,
    contextId,
    statusId,
    postedAt: String(tweet.postedAt || "").slice(0, 40),
    engagement: String(tweet.engagement || "").slice(0, 200),
    socialContext: String(tweet.socialContext || "").slice(0, 200),
    textTruncated: Boolean(tweet.textTruncated),
    links,
    card,
    videoSubtitles,
    media
  };
}
export function normalizeSubtitleGroup(group) {
  if (!group?.cues?.length) return null;
  return {
    source: group.source || "Video subtitles",
    videoIndex: group.videoIndex || 1,
    language: group.language || "",
    kind: group.kind || "subtitles",
    cues: group.cues
      .map((cue, index) => ({
        index: cue.index || index + 1,
        start: cue.start || "",
        end: cue.end || "",
        text: String(cue.text || "").trim()
      }))
      .filter((cue) => cue.text)
      .slice(0, 80)
  };
}
export function normalizeMediaSubtitleGroups(groups) {
  return Array.isArray(groups)
    ? groups.map(normalizeSubtitleGroup).filter(Boolean)
    : [];
}
export function normalizeTweetMediaItem(item, meta) {
  const mediaType = normalizeMediaType(item?.type || item?.mediaType || item?.kind);
  if (!mediaType) return null;
  const rawVideoUrls = mediaType === "video" ? normalizeRawVideoUrls(item.rawVideoUrls || item.rawUrls || item.videoUrls) : [];
  const rawAudioUrls = mediaType === "video" ? normalizeRawAudioUrls(item.rawAudioUrls || item.audioUrls) : [];
  const url = normalizeMediaUrl(item.url || item.src || item.imageUrl || "");
  const posterUrl = normalizeMediaUrl(item.posterUrl || item.poster || item.thumbnailUrl || "");
  const srcUrl = normalizeMediaUrl(item.srcUrl || item.currentSrc || item.videoUrl || rawVideoUrls[0] || "");
  if (!url && !posterUrl && !srcUrl) return null;

  return {
    id: String(item.id || `media:${meta.contextId}:${mediaType}:${meta.mediaIndex + 1}`),
    type: mediaType,
    mediaType,
    url,
    imageUrl: mediaType === "image" ? url || posterUrl || srcUrl : "",
    posterUrl: mediaType === "video" ? posterUrl || (inferMediaTypeFromUrl(url) === "image" ? url : "") : "",
    srcUrl: mediaType === "video" ? srcUrl : "",
    rawVideoUrls,
    rawAudioUrls,
    mediaId: mediaType === "video" ? String(item.mediaId || extractTweetVideoMediaId(srcUrl || posterUrl || url) || "") : "",
    altText: String(item.altText || item.alt || "").trim().slice(0, 500),
    label: String(item.label || item.ariaLabel || "").trim().slice(0, 240),
    width: Number.isFinite(Number(item.width)) ? Number(item.width) : null,
    height: Number.isFinite(Number(item.height)) ? Number(item.height) : null,
    sequenceIndex: Number.isFinite(Number(item.sequenceIndex)) ? Number(item.sequenceIndex) : meta.mediaIndex,
    videoSubtitles: mediaType === "video"
      ? normalizeMediaSubtitleGroups(item.videoSubtitles || meta.videoSubtitles).slice(0, 4)
      : []
  };
}
export function flattenContextPosts(context) {
  return [
    context.currentTweet,
    context.quotedTweet,
    ...(Array.isArray(context.xPostContext?.posts) ? context.xPostContext.posts : []),
    ...(Array.isArray(context.visibleThread) ? context.visibleThread : []),
    ...(Array.isArray(context.deepThreads)
      ? context.deepThreads.flatMap((read) => read.thread?.posts ?? [])
      : []),
    ...(Array.isArray(context.searchResults)
      ? context.searchResults.flatMap((read) => read.search?.searches?.flatMap((search) => search.posts ?? []) ?? [])
      : [])
  ].filter(Boolean);
}
export function countVideoSubtitleGroups(context) {
  return flattenContextPosts(context)
    .reduce((count, tweet) => count + (Array.isArray(tweet.videoSubtitles) ? tweet.videoSubtitles.length : 0), 0);
}
export function countMediaItems(context) {
  return flattenContextPosts(context)
    .reduce((count, tweet) => count + (Array.isArray(tweet.media) ? tweet.media.length : 0), 0);
}

