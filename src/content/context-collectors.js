import { api } from "./api.js";
import {
  sleep,
  stableHash,
  uniqueBy
} from "./dom-utils.js";
import {
  sendMessage
} from "./runtime.js";
import {
  state
} from "./state.js";
import {
  extractTweet,
  waitForArticleContent
} from "./tweet-extract.js";
import {
  extractStatusIdFromUrl
} from "./tweet-media.js";
import {
  queryTweetArticles,
  shouldSkipArticle
} from "./tweet-mount.js";

export async function collectThreadContext(payload = {}) {
  const maxPosts = Math.max(1, Math.min(Number(payload.maxPosts ?? 16), 30));
  const scrollPasses = Math.max(0, Math.min(Number(payload.scrollPasses ?? 2), 5));
  const rootStatusId = String(payload.statusId || extractStatusIdFromUrl(location.href) || "");

  await waitForArticleContent(2500);
  for (let index = 0; index < scrollPasses; index += 1) {
    const posts = collectThreadArticles(rootStatusId);
    if (posts.length >= maxPosts) break;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.85), left: 0, behavior: "instant" });
    await sleep(700);
  }

  const posts = collectThreadArticles(rootStatusId).slice(0, maxPosts);
  return {
    source: "background_thread_read",
    url: location.href,
    rootStatusId,
    collectedAt: new Date().toISOString(),
    posts
  };
}
export async function collectSearchContext(payload = {}) {
  const maxPosts = Math.max(1, Math.min(Number(payload.maxPosts ?? 8), 20));
  const scrollPasses = Math.max(0, Math.min(Number(payload.scrollPasses ?? 1), 4));
  const query = String(payload.query || "");

  await waitForArticleContent(3000);
  for (let index = 0; index < scrollPasses; index += 1) {
    const posts = collectSearchArticles();
    if (posts.length >= maxPosts) break;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.85), left: 0, behavior: "instant" });
    await sleep(700);
  }

  return {
    source: "x_search",
    query,
    url: location.href,
    collectedAt: new Date().toISOString(),
    posts: collectSearchArticles().slice(0, maxPosts)
  };
}
export function collectSearchArticles() {
  const tweets = queryTweetArticles()
    .filter((article) => !shouldSkipArticle(article))
    .map((article, index) => ({
      ...extractTweet(article),
      searchRole: "x_search_result",
      sequenceIndex: index
    }))
    .filter((tweet) => tweet.text || tweet.videoSubtitles?.length);

  return uniqueBy(tweets, (tweet) => tweet.statusId || tweet.contextId);
}
export function collectThreadArticles(rootStatusId) {
  const tweets = queryTweetArticles()
    .filter((article) => !shouldSkipArticle(article))
    .map((article, index) => {
      const tweet = extractTweet(article);
      const isRoot = rootStatusId && tweet.statusId === rootStatusId;
      return {
        ...tweet,
        threadRole: isRoot ? "root_post" : index === 0 ? "thread_context_or_parent" : "reply_or_comment"
      };
    })
    .filter((tweet) => tweet.text || tweet.videoSubtitles?.length);

  return uniqueBy(tweets, (tweet) => tweet.statusId || tweet.contextId);
}
export function cacheVisibleProfile() {
  if (!/^\/[^/?#]+\/?$/.test(location.pathname)) return;
  const now = Date.now();
  if (now - (state.lastProfileCacheAt ?? 0) < 4000) return;
  const profile = collectProfileContext(5);
  if (!profile.handle || (!profile.bio && profile.recentPosts.length === 0)) return;
  const cacheKey = stableHash(JSON.stringify([profile.handle, profile.bio, profile.recentPosts]));
  if (cacheKey === state.lastProfileCacheKey) return;
  state.lastProfileCacheAt = now;
  state.lastProfileCacheKey = cacheKey;
  sendMessage({ type: "CACHE_PROFILE_CONTEXT", payload: { profile } });
}
export function collectProfileContext(maxPosts) {
  const handle = location.pathname.split("/").filter(Boolean)[0] ?? "";
  const articles = queryTweetArticles();
  const recentPosts = articles
    .map((article) => article.innerText.replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .slice(0, maxPosts);

  const displayName = document.querySelector('[data-testid="UserName"]')?.innerText.split("\n")[0] ?? "";
  const bio = document.querySelector('[data-testid="UserDescription"]')?.innerText ?? "";

  return { handle, displayName, bio, recentPosts };
}

