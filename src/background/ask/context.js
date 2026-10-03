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
  loadImageForAnalysis
} from "../media/image.js";
import {
  mediaCacheIdentity
} from "../media/identity.js";
import {
  analyzeMediaShared
} from "../media/jobs.js";
import {
  extractTweetVideoMediaId
} from "../media/video.js";
import {
  resolvePerformance
} from "../orchestrator/profile.js";
import {
  runTask,
  withLane
} from "../orchestrator/tasks.js";
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
/**
 * Automatic media analysis for one ask, run in parallel (within the lane limits).
 *
 * `add()` can be called again as more of the thread arrives: the clicked post's media
 * starts from the page data straight away, and the thread root's / ancestors' media
 * joins once the X thread is loaded. Each item is a shared task (media/jobs.js), so
 * media a prefetch already started is joined, not restarted.
 */
export function createAutomaticMediaRun(context, settings, progress) {
  const started = new Map();
  const perf = resolvePerformance(settings);
  const caps = { video: perf.autoMediaMaxVideos, image: perf.autoMediaMaxImages };
  const counts = { video: 0, image: 0 };
  let finished = 0;

  const report = (message) => void progress?.(message);
  const statusLine = () => {
    const total = started.size;
    return total > 1 ? `Analyzing media (${finished} of ${total} done)...` : "";
  };

  const runOne = async (item, label) => {
    const automatic = item.mediaType === "video"
      ? { automatic: true, prompt: AUTOMATIC_VIDEO_PROMPT }
      : { automatic: true, prompt: AUTOMATIC_IMAGE_PROMPT };
    // Several items in flight: prefix their progress so lines stay readable.
    const itemContext = {
      ...context,
      reportProgress: (message) => report(started.size > 1 ? `${label}: ${message}` : message)
    };
    try {
      const result = await analyzeMediaShared(item, automatic, itemContext, settings);
      if (result?.ok) {
        if (item.mediaType === "video") {
          context.automaticMedia.analyzedVideoCount += 1;
          if (result.audioMergedIntoAnalysis || result.audioAnalysis) context.automaticMedia.analyzedAudioCount += 1;
          else if (result.audioError) context.automaticMedia.errors.push({ type: "audio", id: item.id, error: result.audioError });
        } else {
          context.automaticMedia.analyzedImageCount += 1;
        }
        if (result.cached) context.automaticMedia.cachedAnalysisCount += 1;
      } else {
        context.automaticMedia.errors.push({ type: item.mediaType, id: item.id, error: result?.error || `${label} analysis failed.` });
      }
    } catch (error) {
      if (context.abortSignal?.aborted || error?.name === "AbortError") throw error;
      context.automaticMedia.errors.push({ type: item.mediaType, id: item.id, error: error.message });
      context.mediaAnalyses.push({
        ok: false,
        tool: `automatic_${item.mediaType}_analysis`,
        type: item.mediaType,
        target: summarizeMediaTarget(item),
        error: error.message
      });
    } finally {
      finished += 1;
      const line = statusLine();
      if (line) report(line);
    }
  };

  const attachments = [];
  return {
    /** Start analysis for selected media not started yet. */
    add() {
      const media = getSelectedAutomaticMedia(context);
      for (const item of media) {
        const type = item.mediaType;
        if (type === "image" && !settings.allowImageAnalysis) continue;
        if (type === "video" && !settings.allowVideoAnalysis) continue;
        if (type !== "image" && type !== "video") continue;
        const key = mediaCacheIdentity(item);
        if (started.has(key) || counts[type] >= caps[type]) continue;
        counts[type] += 1;
        const label = `${type === "video" ? "Video" : "Image"} ${counts[type]}`;
        const running = runOne(item, label);
        // Awaited in done(); until then an abort must not surface as unhandled.
        running.catch(() => {});
        started.set(key, running);
        if (type === "image" && shouldAttachImagesToMainProvider(settings)) {
          const attaching = attachAutomaticImages(context, [item]);
          attaching.catch(() => {});
          attachments.push(attaching);
        }
      }
      context.automaticMedia.selectedCount = started.size;
    },
    /** Resolves when every started analysis has settled (rejects only on abort). */
    async done() {
      let size = -1;
      // Analyses can be added while waiting; wait until the set stops growing.
      while (size !== started.size + attachments.length) {
        size = started.size + attachments.length;
        await Promise.all([...started.values(), ...attachments]);
      }
    },
    get size() {
      return started.size;
    }
  };
}
export async function prepareAutomaticMediaContext(context, settings, progress) {
  const run = createAutomaticMediaRun(context, settings, progress);
  run.add();
  await run.done();
}
const AUTOMATIC_IMAGE_PROMPT = "Automatic reusable image notes. Prioritize factual visual details, readable text, screenshot/UI/meme structure, notable people/objects/actions, and uncertainty. Do not invent missing text or off-image events. Do not answer the user directly.";
const AUTOMATIC_VIDEO_PROMPT = [
  "Produce compact change-based visual notes of this video for another model that cannot see the frames.",
  "Summarize the window, then list only meaningful visual changes and key moments with timestamps — not one detailed bullet per sample.",
  "Prefer provided subtitle/caption cues for speech-like text; OCR only distinct burned-in text that is missing or differs.",
  "Do not invent spoken audio. Be concrete and uncertainty-aware. Do not answer the user directly."
].join(" ");
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

  // Keep it fast: at most 2 links for the current post, read side by side.
  const toFetch = candidates.slice(0, 2);
  if (toFetch.length) await progress?.(`Reading ${toFetch.length === 1 ? "linked article" : `${toFetch.length} linked articles`}...`);
  await Promise.all(toFetch.map(async (candidate) => {
    throwIfAborted(context.abortSignal);
    try {
      const maxChars = 8000;
      const page = await withLane("web", () => collectWebPageInBackground(candidate.url, maxChars), context.abortSignal);
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
  }));
}
export async function prepareXPostContext(context, settings, progress) {
  const statusId = context.currentTweet?.statusId || extractStatusIdFromUrl(context.currentTweet?.url) || extractStatusIdFromUrl(context.sourcePage?.url);
  if (!statusId) return;
  if (!settings.includeCurrentTweet && !settings.includeVisibleThread && !settings.includeQuotedTweet) return;

  try {
    await progress?.("Reading X post context...");
    const target = {
      statusId,
      url: context.currentTweet?.url || context.sourcePage?.url,
      authorHandle: context.currentTweet?.authorHandle || ""
    };
    // Shared task: a prefetch for this post (or another tab) may already be reading it.
    const xContext = await runTask(`thread:${statusId}`, {
      signal: context.abortSignal,
      background: true,
      run: ({ signal }) => collectXPostContextInBackground(target, {
        maxReplies: 12,
        maxRankedReplies: 8,
        maxPages: 2
      }, { sourceTabId: context.sourceTabId, abortSignal: signal })
    });

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
/**
 * Combine the page's copy of a post (`existing`) with X's API copy (`fresh`). The API
 * copy wins field by field, but only where it actually has a value: an empty author
 * from the API must never erase the handle read from the page.
 */
export function mergeContextTweet(existing, fresh) {
  if (!existing) return fresh;
  if (!fresh) return existing;
  const pick = (key) => (hasValue(fresh[key]) ? fresh[key] : existing[key]);
  const merged = { ...existing };
  for (const key of Object.keys(fresh)) {
    if (hasValue(fresh[key])) merged[key] = fresh[key];
  }
  return pruneEmptyValues({
    ...merged,
    authorHandle: pick("authorHandle"),
    displayName: pick("displayName"),
    url: fresh.authorHandle ? fresh.url : existing.url || fresh.url,
    text: pick("text"),
    links: fresh.links?.length ? fresh.links : existing.links,
    card: fresh.card || existing.card,
    media: fresh.media?.length ? fresh.media : existing.media,
    videoSubtitles: fresh.videoSubtitles?.length ? fresh.videoSubtitles : existing.videoSubtitles,
    engagement: pick("engagement"),
    postedAt: pick("postedAt"),
    textTruncated: Boolean(existing.textTruncated && fresh.textTruncated)
  });
}
function hasValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
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

  // 4) The reply chain between the root and the selected post, nearest first: what the
  //    selected post is answering often lives in an ancestor's image or clip.
  const parents = [...(context.xPostContext?.parents ?? [])].reverse();
  for (const parent of parents) push(byStatus(String(parent?.statusId || "")));

  // Videos first (slowest), then images; the run applies the profile's caps.
  return [
    ...selected.filter((item) => item.mediaType === "video"),
    ...selected.filter((item) => item.mediaType === "image")
  ];
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
    mediaId: String(item.mediaId || (mediaType === "video" ? extractTweetVideoMediaId(srcUrl || posterUrl || url) : "") || ""),
    mediaKey: String(item.mediaKey || ""),
    sourceStatusId: String(item.sourceStatusId || ""),
    sourceHandle: String(item.sourceHandle || "").replace(/^@/, ""),
    durationMs: Number(item.durationMs) > 0 ? Number(item.durationMs) : null,
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

