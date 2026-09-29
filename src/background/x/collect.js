import { api } from "../api.js";
import {
  cleanReadableText
} from "../../lib/text.js";
import {
  extractStatusIdFromUrl
} from "../../lib/url.js";
import {
  clampNumber,
  cloneJson,
  throwIfAborted,
  uniqueBy
} from "../../lib/utils.js";
import {
  getSettings,
  normalizeProfile
} from "../settings.js";
import {
  fetchReadableUrl
} from "../web/readable.js";
import {
  requestXGraphQL
} from "../x/graphql-client.js";
import {
  buildTweetDetailVariables,
  collectTweetsFromTweetDetail,
  compareTweetsByContextValue,
  extractXBottomCursor
} from "../x/parse.js";

/** Recent thread reads, so follow-ups and repeated gets skip the network. */
const X_CONTEXT_CACHE = new Map();
const X_CONTEXT_CACHE_TTL_MS = 3 * 60 * 1000;
const X_CONTEXT_CACHE_LIMIT = 24;

export async function collectXPostContextInBackground(target, options = {}, context = {}) {
  const statusId = String(target?.statusId || extractStatusIdFromUrl(target?.url) || "").trim();
  if (!statusId) {
    return {
      ok: false,
      source: "x_graphql_tweet_detail",
      error: "The requested X post did not have a status ID.",
      posts: []
    };
  }

  const maxReplies = clampNumber(options.maxReplies ?? options.maxPosts ?? 16, 1, 30, 16);
  const maxRankedReplies = clampNumber(options.maxRankedReplies ?? Math.min(8, maxReplies), 0, 20, Math.min(8, maxReplies));
  const maxPages = clampNumber(options.maxPages ?? (maxReplies >= 24 ? 3 : 2), 1, 4, 2);
  const cacheKey = `${statusId}:${maxReplies}:${maxRankedReplies}:${maxPages}`;
  const cached = X_CONTEXT_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < X_CONTEXT_CACHE_TTL_MS) return cloneJson(cached.result);

  const result = await collectXPostContextUncached(target, statusId, { maxReplies, maxRankedReplies, maxPages }, context);
  if (result?.ok) {
    X_CONTEXT_CACHE.delete(cacheKey);
    X_CONTEXT_CACHE.set(cacheKey, { at: Date.now(), result: cloneJson(result) });
    while (X_CONTEXT_CACHE.size > X_CONTEXT_CACHE_LIMIT) {
      X_CONTEXT_CACHE.delete(X_CONTEXT_CACHE.keys().next().value);
    }
  }
  return result;
}

async function collectXPostContextUncached(target, statusId, { maxReplies, maxRankedReplies, maxPages }, context) {
  const pages = [];
  const cursors = new Set();
  let cursor = "";

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    throwIfAborted(context.abortSignal);
    const page = await requestXGraphQL(context, "TweetDetail", buildTweetDetailVariables(statusId, cursor));
    pages.push(page);

    const nextCursor = extractXBottomCursor(page);
    if (!nextCursor || cursors.has(nextCursor)) break;
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  const tweets = uniqueBy(
    pages.flatMap((page, pageIndex) => collectTweetsFromTweetDetail(page, {
      focalStatusId: statusId,
      pageIndex
    })),
    (tweet) => tweet.statusId || tweet.contextId
  );

  const selected = tweets.find((tweet) => tweet.statusId === statusId) ?? null;
  const rootStatusId = selected?.conversationId || statusId;
  const root = selected
    ? {
      ...selected,
      threadRole: selected.statusId === rootStatusId ? "root_post" : "selected_post",
      visibleRole: selected.statusId === rootStatusId ? "root_post" : "selected_post"
    }
    : null;

  const quoted = tweets.find((tweet) => tweet.sourceRole === "quoted_post" && tweet.quotedByStatusId === statusId)
    ?? tweets.find((tweet) => tweet.sourceRole === "quoted_post")
    ?? null;

  const parents = tweets
    .filter((tweet) => tweet.statusId && tweet.statusId !== statusId && tweet.statusId !== quoted?.statusId)
    .filter((tweet) => tweet.statusId === rootStatusId || tweet.sourceRole === "parent_context")
    .map((tweet, index) => ({
      ...tweet,
      threadRole: tweet.statusId === rootStatusId ? "conversation_root" : "parent_context",
      visibleRole: tweet.statusId === rootStatusId ? "conversation_root" : "parent_context",
      sequenceIndex: index
    }));

  const replyCandidates = tweets
    .filter((tweet) => tweet.statusId && tweet.statusId !== statusId && tweet.statusId !== rootStatusId && tweet.statusId !== quoted?.statusId)
    .filter((tweet) => tweet.conversationId === rootStatusId || tweet.sourceRole === "reply_or_comment")
    .filter((tweet) => tweet.text || tweet.media?.length);

  const rankedReplies = uniqueBy(replyCandidates, (tweet) => tweet.statusId)
    .slice(0, maxRankedReplies)
    .map((tweet, index) => ({
      ...tweet,
      threadRole: "x_ranked_reply",
      visibleRole: "x_ranked_reply",
      sequenceIndex: index
    }));

  const topLikedReplies = uniqueBy(
    [...replyCandidates].sort(compareTweetsByContextValue),
    (tweet) => tweet.statusId
  )
    .slice(0, maxReplies)
    .map((tweet, index) => ({
      ...tweet,
      threadRole: "top_liked_reply",
      visibleRole: "top_liked_reply",
      sequenceIndex: index
    }));

  // When the selected post is a comment, the TweetDetail above is focused on that
  // comment: it returns the ancestor chain and replies *to the comment*, but not the
  // original post's own comment section. Fetch one page focused on the conversation
  // root so the model sees the whole thread it is reasoning about.
  let conversationRoot = null;
  let rootReplies = [];
  if (root && rootStatusId && rootStatusId !== statusId) {
    try {
      const rootPage = await requestXGraphQL(context, "TweetDetail", buildTweetDetailVariables(rootStatusId));
      const rootTweets = uniqueBy(collectTweetsFromTweetDetail(rootPage, {
        focalStatusId: rootStatusId,
        pageIndex: 0
      }), (tweet) => tweet.statusId || tweet.contextId);
      const knownIds = new Set(tweets.map((tweet) => tweet.statusId).filter(Boolean));
      knownIds.add(statusId);

      const foundRoot = rootTweets.find((tweet) => tweet.statusId === rootStatusId) ?? null;
      conversationRoot = foundRoot
        ? { ...foundRoot, threadRole: "conversation_root", visibleRole: "conversation_root" }
        : null;

      rootReplies = uniqueBy(
        rootTweets
          .filter((tweet) => tweet.statusId && tweet.statusId !== rootStatusId && !knownIds.has(tweet.statusId))
          .filter((tweet) => tweet.sourceRole !== "quoted_post")
          .filter((tweet) => tweet.conversationId === rootStatusId || tweet.sourceRole === "reply_or_comment")
          .filter((tweet) => tweet.text || tweet.media?.length)
          .sort(compareTweetsByContextValue),
        (tweet) => tweet.statusId
      )
        .slice(0, maxReplies)
        .map((tweet, index) => ({
          ...tweet,
          threadRole: "thread_comment",
          visibleRole: "thread_comment",
          sequenceIndex: index
        }));
    } catch {
      // Root-thread expansion is best-effort; the comment-focused context above still stands.
    }
  }

  const posts = uniqueBy([
    root,
    conversationRoot,
    ...parents,
    quoted ? { ...quoted, threadRole: "quoted_post", visibleRole: "quoted_post" } : null,
    ...topLikedReplies,
    ...rankedReplies,
    ...rootReplies
  ].filter(Boolean), (tweet) => tweet.statusId || tweet.contextId);

  const result = {
    ok: Boolean(root),
    source: "x_graphql_tweet_detail",
    rootStatusId,
    focalStatusId: statusId,
    url: root?.url || target?.url || (statusId ? `https://x.com/i/web/status/${statusId}` : ""),
    collectedAt: new Date().toISOString(),
    sampledPostCount: tweets.length + rootReplies.length,
    pageCount: pages.length,
    root,
    conversationRoot,
    parents,
    quoted,
    rankedReplies,
    topLikedReplies,
    rootReplies,
    posts,
    error: root ? "" : "X returned timeline data, but the selected post was not found."
  };
  return result;
}
export async function collectProfileInBackground(handle, maxPosts) {
  const cleanHandle = String(handle || "").replace(/^@/, "");
  const url = `https://x.com/${cleanHandle}`;
  try {
    const page = await fetchReadableUrl(url, 8000);
    const lines = cleanReadableText(page.text || "")
      .split("\n")
      .filter(Boolean);
    const maxRecent = clampNumber(maxPosts, 1, 10, 5);
    const recentPosts = uniqueBy(
      lines.slice(4, 4 + maxRecent * 2)
        .map((line) => String(line || "").trim().slice(0, 240))
        .filter(Boolean)
        .map((text) => ({ text })),
      (post) => post.text.toLowerCase()
    ).slice(0, maxRecent);
    return {
      handle: cleanHandle,
      displayName: page.title?.replace(/\s*\(@[^)]+\)\s*\/\s*X$/i, "").trim() || "",
      bio: lines.slice(0, 4).join(" ").slice(0, 500),
      recentPosts,
      fetchedAt: new Date().toISOString(),
      source: page.source,
      url,
      error: page.ok ? "" : page.error
    };
  } catch (error) {
    return { handle: cleanHandle, url, error: error.message, recentPosts: [] };
  }
}
export async function cacheProfileContext(payload) {
  const profile = normalizeProfile(payload.profile);
  if (!profile?.handle) return { ok: false, error: "Profile handle missing." };

  const settings = await getSettings();
  if (!settings.cacheVisitedProfiles) return { ok: true, skipped: true };

  await api.storage.local.set({
    [`profile:${profile.handle.toLowerCase()}`]: {
      ...profile,
      cachedAt: new Date().toISOString()
    }
  });
  return { ok: true };
}
export async function collectThreadInBackground(target, maxPosts, context = {}) {
  try {
    return await collectXPostContextInBackground(target, {
      maxReplies: maxPosts,
      maxRankedReplies: Math.min(10, maxPosts),
      maxPages: maxPosts >= 24 ? 3 : 2
    }, context);
  } catch (error) {
    return {
      ok: false,
      source: "x_graphql_tweet_detail",
      rootStatusId: target?.statusId || extractStatusIdFromUrl(target?.url) || "",
      url: target?.url || "",
      error: error.message || "Could not read X post context.",
      posts: []
    };
  }
}

