import { api } from "../api.js";
import {
  MEDIA_ANALYSIS_STORAGE_KEY,
  MEDIA_CACHE_PREFIX,
  POST_MEDIA_ANALYSIS_STORAGE_KEY
} from "../constants.js";
import {
  mediaCacheIdentity
} from "./identity.js";
import {
  clearMediaStore,
  forgetChatsInMediaStore,
  getMediaEntry,
  putMediaEntry,
  touchMediaEntryForChat
} from "./store.js";

// Analyses used to live in two storage blobs rewritten whole on every write; they are in
// IndexedDB now (media/store.js). Free the old blobs once.
try {
  void api.storage?.local?.remove?.(POST_MEDIA_ANALYSIS_STORAGE_KEY)?.catch?.(() => {});
  void api.storage?.session?.remove?.(MEDIA_ANALYSIS_STORAGE_KEY)?.catch?.(() => {});
} catch {
  // Ignore.
}
import {
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  cloneJson,
  stableHash
} from "../../lib/utils.js";

export const MEDIA_IMAGE_CACHE = new Map();
export const MEDIA_FRAME_CACHE = new Map();
export const MEDIA_SESSION_KEYS = new Map();
export const CLOSED_MEDIA_SESSIONS = new Set();
export const VIDEO_CAPTURE_PROGRESS_HANDLERS = new Map();
export function findExistingMediaAnalysis(context, target, mediaType) {
  const existing = (context.mediaAnalyses ?? []).find((analysis) => {
    return analysis?.ok
      && analysis.type === mediaType
      && mediaTargetsMatch(analysis.target, target);
  });
  if (!existing) return null;
  return {
    ...cloneJson(existing),
    cached: true,
    reusedFromContext: true
  };
}
export function mediaTargetsMatch(left, right) {
  if (!left || !right) return false;
  const leftValues = buildMediaIdentityValues(left);
  const rightValues = buildMediaIdentityValues(right);
  return leftValues.some((value) => rightValues.includes(value));
}
export function buildMediaIdentityValues(target) {
  return [
    target.id,
    target.url ? normalizeSourceUrl(target.url) : "",
    target.imageUrl ? normalizeSourceUrl(target.imageUrl) : "",
    target.posterUrl ? normalizeSourceUrl(target.posterUrl) : "",
    target.srcUrl ? normalizeSourceUrl(target.srcUrl) : "",
    target.mediaId ? `media:${target.mediaId}` : "",
    ...(Array.isArray(target.rawVideoUrls) ? target.rawVideoUrls.map(normalizeSourceUrl) : [])
  ].filter(Boolean);
}
/** Identity-only fingerprint (no transient player/DOM state, no post or session). */
export function mediaCacheFingerprint(target) {
  return mediaCacheIdentity(target);
}
export function buildImageDataCacheKey(target) {
  return `${MEDIA_CACHE_PREFIX}image-data:${mediaCacheFingerprint(target)}`;
}
/**
 * Analysis cache key: the media's own identity (shared across reposts, quotes and
 * re-uploads; see media/identity.js) plus everything that changes the analysis output.
 * Deliberately no session, chat or post id. Focused (tool) analyses include the focus
 * prompt and question, so they never replace the reusable automatic analysis.
 */
export function buildMediaAnalysisCacheKey(kind, target, context, args, providerSettings, extra = {}) {
  const automatic = Boolean(args?.automatic);
  const profile = {
    version: 3,
    kind,
    mode: automatic ? "automatic" : "tool",
    provider: {
      provider: providerSettings.provider,
      endpoint: providerSettings.endpoint,
      model: providerSettings.model
    },
    prompt: automatic ? "" : String(args?.prompt || "").replace(/\s+/g, " ").trim(),
    question: automatic ? "" : String(context?.originalQuestion || "").replace(/\s+/g, " ").trim(),
    extra
  };
  return `${MEDIA_CACHE_PREFIX}analysis:${mediaCacheIdentity(target)}|${stableHash(JSON.stringify(profile))}`;
}
/**
 * A cached analysis for `cacheKey`, re-pointed at `target` (the post it is being used
 * for now) so attribution follows the post in front of the user, not the one the media
 * was first analyzed on.
 */
export async function readCachedMediaAnalysis(cacheKey, target = null, context = null) {
  const entry = await getMediaEntry(cacheKey);
  const result = entry?.result;
  if (!result?.ok) return null;
  if (context?.chatId) void touchMediaEntryForChat(cacheKey, context.chatId);
  return {
    ...cloneJson(result),
    ...(target ? { target: summarizeCachedTarget(target, result.target) } : {}),
    cached: true,
    cachedAt: new Date(entry.createdAt || Date.now()).toISOString()
  };
}
export async function writeCachedMediaAnalysis(cacheKey, result, context = null, target = null) {
  if (!result?.ok) return;
  const stored = cloneJson(result);
  delete stored.cached;
  delete stored.reusedFromContext;
  delete stored.reusedFromPost;
  await putMediaEntry(cacheKey, {
    identity: mediaCacheIdentity(target ?? result.target),
    result: stored,
    chatId: String(context?.chatId || "")
  });
}
function summarizeCachedTarget(target, previous = {}) {
  return {
    ...(previous ?? {}),
    id: target.id,
    type: target.mediaType || target.type || previous?.type,
    contextId: target.contextId,
    statusId: target.statusId,
    postUrl: target.postUrl,
    url: target.url || previous?.url,
    posterUrl: target.posterUrl || previous?.posterUrl,
    srcUrl: target.srcUrl || previous?.srcUrl,
    mediaId: target.mediaId || previous?.mediaId,
    mediaKey: target.mediaKey || previous?.mediaKey,
    sourceStatusId: target.sourceStatusId || "",
    sourceHandle: target.sourceHandle || "",
    sequenceIndex: target.sequenceIndex,
    altText: target.altText,
    authorHandle: target.authorHandle,
    displayName: target.displayName,
    role: target.role,
    postedAt: target.postedAt,
    engagement: target.engagement,
    postText: target.postText
  };
}
/** Deleting chats forgets them on shared entries and drops entries only they used. */
export async function deletePostMediaAnalysisForChats(chatIds) {
  return forgetChatsInMediaStore(chatIds);
}
export async function clearPostMediaAnalysisCache() {
  return clearMediaStore();
}
export function rememberLimitedCache(cache, key, value, limit, mediaSessionId = "") {
  const sessionId = String(mediaSessionId || "").trim();
  if (sessionId && CLOSED_MEDIA_SESSIONS.has(sessionId)) return;

  if (cache.has(key)) {
    cache.delete(key);
    forgetMediaCacheKey(key);
  }
  cache.set(key, value);
  trackMediaCacheKey(sessionId, key);
  while (cache.size > limit) {
    const evictedKey = cache.keys().next().value;
    cache.delete(evictedKey);
    forgetMediaCacheKey(evictedKey);
  }
}
export function trackMediaCacheKey(mediaSessionId, key) {
  const id = String(mediaSessionId || "").trim();
  if (!id || !key) return;
  let keys = MEDIA_SESSION_KEYS.get(id);
  if (!keys) {
    keys = new Set();
    MEDIA_SESSION_KEYS.set(id, keys);
  }
  keys.add(key);
}
export function forgetMediaCacheKey(key) {
  if (!key) return;
  for (const [mediaSessionId, keys] of MEDIA_SESSION_KEYS) {
    keys.delete(key);
    if (!keys.size) MEDIA_SESSION_KEYS.delete(mediaSessionId);
  }
}

