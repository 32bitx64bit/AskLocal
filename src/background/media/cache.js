import { api } from "../api.js";
import {
  MEDIA_ANALYSIS_CACHE_LIMIT,
  MEDIA_ANALYSIS_STORAGE_KEY,
  MEDIA_CACHE_PREFIX,
  POST_MEDIA_ANALYSIS_CACHE_LIMIT,
  POST_MEDIA_ANALYSIS_STORAGE_KEY
} from "../constants.js";
import {
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  cloneJson,
  stableHash
} from "../../lib/utils.js";

export const MEDIA_ANALYSIS_CACHE = new Map();
export const POST_MEDIA_ANALYSIS_CACHE = new Map();
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
export function buildImageDataCacheKey(target, context) {
  return `${MEDIA_CACHE_PREFIX}image-data:${stableHash(JSON.stringify({
    sessionId: context.mediaSessionId || "",
    media: mediaCacheFingerprint(target)
  }))}`;
}
export function buildMediaAnalysisCacheKey(kind, target, context, args, providerSettings, extra = {}) {
  const automatic = Boolean(args?.automatic);
  const payload = {
    version: 2,
    sessionId: context.mediaSessionId || "",
    kind,
    mode: automatic ? "automatic" : "tool",
    media: mediaCacheFingerprint(target),
    provider: {
      provider: providerSettings.provider,
      endpoint: providerSettings.endpoint,
      model: providerSettings.model
    },
    prompt: String(args?.prompt || "").replace(/\s+/g, " ").trim(),
    question: automatic ? "" : String(context.originalQuestion || "").replace(/\s+/g, " ").trim(),
    extra
  };
  return `${MEDIA_CACHE_PREFIX}analysis:${stableHash(JSON.stringify(payload))}`;
}
/**
 * Cross-chat key for processed video/audio. Same media + analysis profile hits
 * across sessions/chats; ownership (sourceChatId) is stored on the entry, not
 * in the key, so replies and new chats can reuse until the owning chat is deleted.
 */
export function buildPostMediaAnalysisCacheKey(kind, target, context, args, providerSettings, extra = {}) {
  const automatic = Boolean(args?.automatic);
  const payload = {
    version: 1,
    kind,
    mode: automatic ? "automatic" : "tool",
    media: mediaCacheFingerprint(target),
    provider: {
      provider: providerSettings.provider,
      endpoint: providerSettings.endpoint,
      model: providerSettings.model
    },
    prompt: String(args?.prompt || "").replace(/\s+/g, " ").trim(),
    question: automatic ? "" : String(context.originalQuestion || "").replace(/\s+/g, " ").trim(),
    extra
  };
  return `${MEDIA_CACHE_PREFIX}post-analysis:${stableHash(JSON.stringify(payload))}`;
}
export function canPersistPostMediaAnalysis(target) {
  if (!target) return false;
  return Boolean(
    target.statusId
    || target.mediaId
    || target.contextId
    || target.id
  );
}
export function mediaCacheFingerprint(target) {
  // Deliberately identity-only (no url/posterUrl/srcUrl/duration): those reflect transient
  // DOM/player state that can differ between the first Ask and a same-session follow-up
  // (e.g. duration is unknown until the player buffers, or X regenerates a poster URL with
  // a new cache-busting query param). Keying the cache on them caused the exact same video
  // to hash to a different key turn to turn, so it got re-captured/re-analyzed on every
  // follow-up instead of being reused for the life of the session.
  return {
    id: target.id || "",
    type: target.mediaType || target.type || "",
    contextId: target.contextId || "",
    statusId: target.statusId || "",
    mediaId: target.mediaId || "",
    sequenceIndex: Number.isFinite(Number(target.sequenceIndex)) ? Number(target.sequenceIndex) : ""
  };
}
export let mediaAnalysisCacheHydration = null;
export function ensureMediaAnalysisCacheHydrated() {
  if (!api.storage?.session) return Promise.resolve();
  if (!mediaAnalysisCacheHydration) {
    mediaAnalysisCacheHydration = (async () => {
      try {
        const stored = await api.storage.session.get(MEDIA_ANALYSIS_STORAGE_KEY);
        const entries = stored?.[MEDIA_ANALYSIS_STORAGE_KEY];
        if (Array.isArray(entries)) {
          for (const [key, value] of entries) MEDIA_ANALYSIS_CACHE.set(key, value);
        }
      } catch {
        // storage.session unavailable or unreadable; continue with an empty in-memory cache.
      }
    })();
  }
  return mediaAnalysisCacheHydration;
}
export async function persistMediaAnalysisCache() {
  if (!api.storage?.session) return;
  try {
    await api.storage.session.set({ [MEDIA_ANALYSIS_STORAGE_KEY]: [...MEDIA_ANALYSIS_CACHE.entries()] });
  } catch {
    // Best-effort; an in-memory-only cache for the rest of this worker's lifetime is fine.
  }
}
export async function readCachedMediaAnalysis(cacheKey) {
  await ensureMediaAnalysisCacheHydrated();
  const cached = MEDIA_ANALYSIS_CACHE.get(cacheKey);
  const result = cached?.result;
  if (!result?.ok) return null;
  rememberLimitedCache(MEDIA_ANALYSIS_CACHE, cacheKey, cached, MEDIA_ANALYSIS_CACHE_LIMIT, cached.sessionId);
  return {
    ...cloneJson(result),
    cached: true,
    cachedAt: cached.cachedAt || ""
  };
}
export async function writeCachedMediaAnalysis(cacheKey, result, mediaSessionId = "") {
  if (!result?.ok) return;
  await ensureMediaAnalysisCacheHydrated();
  const value = {
    sessionId: String(mediaSessionId || "").trim(),
    cachedAt: new Date().toISOString(),
    result: {
      ...cloneJson(result),
      cached: false,
      reusedFromContext: false
    }
  };
  rememberLimitedCache(MEDIA_ANALYSIS_CACHE, cacheKey, value, MEDIA_ANALYSIS_CACHE_LIMIT, value.sessionId);
  await persistMediaAnalysisCache();
}

export let postMediaAnalysisCacheHydration = null;
export function ensurePostMediaAnalysisCacheHydrated() {
  if (!api.storage?.local) return Promise.resolve();
  if (!postMediaAnalysisCacheHydration) {
    postMediaAnalysisCacheHydration = (async () => {
      try {
        const stored = await api.storage.local.get(POST_MEDIA_ANALYSIS_STORAGE_KEY);
        const entries = stored?.[POST_MEDIA_ANALYSIS_STORAGE_KEY];
        if (Array.isArray(entries)) {
          for (const [key, value] of entries) POST_MEDIA_ANALYSIS_CACHE.set(key, value);
        }
      } catch {
        // local storage unavailable; continue with an empty in-memory cache.
      }
    })();
  }
  return postMediaAnalysisCacheHydration;
}
export async function persistPostMediaAnalysisCache() {
  if (!api.storage?.local) return;
  try {
    await api.storage.local.set({ [POST_MEDIA_ANALYSIS_STORAGE_KEY]: [...POST_MEDIA_ANALYSIS_CACHE.entries()] });
  } catch {
    // Best-effort persistence.
  }
}
export async function readPostMediaAnalysis(cacheKey) {
  await ensurePostMediaAnalysisCacheHydrated();
  const cached = POST_MEDIA_ANALYSIS_CACHE.get(cacheKey);
  const result = cached?.result;
  if (!result?.ok) return null;
  // Touch for LRU ordering.
  rememberPostMediaCache(cacheKey, cached);
  return {
    ...cloneJson(result),
    cached: true,
    reusedFromPost: true,
    cachedAt: cached.cachedAt || "",
    sourceChatId: String(cached.sourceChatId || "").trim()
  };
}
export async function writePostMediaAnalysis(cacheKey, result, {
  sourceChatId = "",
  target = null
} = {}) {
  if (!result?.ok || !cacheKey || !canPersistPostMediaAnalysis(target)) return;
  await ensurePostMediaAnalysisCacheHydrated();
  const existing = POST_MEDIA_ANALYSIS_CACHE.get(cacheKey);
  // First chat that processed this media keeps ownership so deleting that chat
  // can free the shared analysis. Later chats only reuse.
  const ownerChatId = String(existing?.sourceChatId || sourceChatId || "").trim();
  const value = {
    sourceChatId: ownerChatId,
    statusId: String(target?.statusId || existing?.statusId || "").trim(),
    mediaId: String(target?.mediaId || existing?.mediaId || "").trim(),
    contextId: String(target?.contextId || existing?.contextId || "").trim(),
    cachedAt: existing?.cachedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: {
      ...cloneJson(result),
      cached: false,
      reusedFromContext: false,
      reusedFromPost: false
    }
  };
  rememberPostMediaCache(cacheKey, value);
  await persistPostMediaAnalysisCache();
}
export function rememberPostMediaCache(key, value) {
  if (POST_MEDIA_ANALYSIS_CACHE.has(key)) POST_MEDIA_ANALYSIS_CACHE.delete(key);
  POST_MEDIA_ANALYSIS_CACHE.set(key, value);
  while (POST_MEDIA_ANALYSIS_CACHE.size > POST_MEDIA_ANALYSIS_CACHE_LIMIT) {
    const evictedKey = POST_MEDIA_ANALYSIS_CACHE.keys().next().value;
    POST_MEDIA_ANALYSIS_CACHE.delete(evictedKey);
  }
}
export async function deletePostMediaAnalysisForChats(chatIds) {
  const ids = new Set(
    (Array.isArray(chatIds) ? chatIds : [chatIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  if (!ids.size) return { removed: 0 };
  await ensurePostMediaAnalysisCacheHydrated();
  let removed = 0;
  for (const [key, value] of [...POST_MEDIA_ANALYSIS_CACHE.entries()]) {
    const owner = String(value?.sourceChatId || "").trim();
    if (!owner || !ids.has(owner)) continue;
    POST_MEDIA_ANALYSIS_CACHE.delete(key);
    removed += 1;
  }
  if (removed) await persistPostMediaAnalysisCache();
  return { removed };
}
export async function clearPostMediaAnalysisCache() {
  await ensurePostMediaAnalysisCacheHydrated();
  const removed = POST_MEDIA_ANALYSIS_CACHE.size;
  POST_MEDIA_ANALYSIS_CACHE.clear();
  if (removed) await persistPostMediaAnalysisCache();
  return { removed };
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

