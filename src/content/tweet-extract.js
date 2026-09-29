import { api } from "./api.js";
import {
  sleep,
  stableHash,
  uniqueBy
} from "./dom-utils.js";
import {
  main
} from "./index.js";
import {
  isVisibleRect
} from "./panel-controller.js";
import {
  extractStatusIdFromUrl,
  extractTweetMedia,
  extractVideoSubtitles,
  normalizeMediaUrlForContext,
  normalizeTweetImageUrl
} from "./tweet-media.js";
import {
  queryTweetArticles,
  shouldSkipArticle
} from "./tweet-mount.js";

export function extractTweet(article) {
  // Quoted posts on current X live in a div[role="link"] inside the same <article> (no
  // nested article anymore, verified live), so quoted text/media must be excluded here or
  // it gets attributed to the outer post.
  const quotedContainer = findQuotedContainer(article);
  const tweetText = findOwnedElement(article, '[data-testid="tweetText"]', quotedContainer)?.innerText
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = tweetText || cleanFallbackTweetText(article);
  const authorBlock = findOwnedElement(article, '[data-testid="User-Name"], [data-testid="UserName"]', quotedContainer);
  const authorLines = (authorBlock?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const statusLink = findStatusLink(article, quotedContainer);
  const statusHref = statusLink?.getAttribute("href") ?? "";
  const profileHref = findOwnedElements(article, 'a[href^="/"]', quotedContainer)
    .map((link) => link.getAttribute("href") ?? "")
    .find((href) => /^\/[^/?#]+$/.test(href));
  const url = statusLink ? new URL(statusHref, location.origin).href : location.href;
  const statusId = extractStatusIdFromUrl(url);
  const authorHandle = authorLines.find((line) => line.startsWith("@"))?.replace(/^@/, "")
    || statusHref.split("/").filter(Boolean)[0]
    || profileHref?.split("/").filter(Boolean)[0]
    || "";
  const displayName = authorLines.find((line) => !line.startsWith("@") && !line.includes("·")) ?? "";
  const videoSubtitles = extractVideoSubtitles(article, quotedContainer);
  const contextId = statusId ? `post:${statusId}` : `post:${stableHash(`${authorHandle}\n${text}\n${url}`)}`;
  const media = extractTweetMedia(article, {
    contextId,
    statusId,
    tweetUrl: url,
    videoSubtitles,
    exclude: quotedContainer
  });

  return {
    contextId,
    statusId,
    authorHandle,
    displayName,
    url,
    text,
    postedAt: extractPostedAt(article, quotedContainer),
    engagement: extractEngagement(article, quotedContainer),
    socialContext: findOwnedElement(article, '[data-testid="socialContext"]')?.innerText.replace(/\s+/g, " ").trim() ?? "",
    textTruncated: findOwnedElements(article, '[data-testid="tweet-text-show-more-link"]', quotedContainer).length > 0,
    links: extractTweetTextLinks(article, quotedContainer),
    card: extractTweetCard(article, quotedContainer),
    videoSubtitles,
    media
  };
}
export function cleanFallbackTweetText(article) {
  const junkLine = (line) => {
    if (!line) return true;
    if (line.length <= 2 && !/[a-z0-9]/i.test(line)) return true;
    if (/^@[\w]+$/.test(line)) return true;
    if (/^[\d,.]+[KM]?$/i.test(line)) return true;
    if (/^\d+(?:s|m|h|d)$/i.test(line)) return true;
    if (/^\d{1,2}:\d{2}(?:\s*\/\s*\d{1,2}:\d{2})?$/.test(line)) return true;
    if (/^(ask|grok|more|follow|promoted|ad|show more|replying to .*)$/i.test(line)) return true;
    return false;
  };
  return article.innerText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !junkLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function extractPostedAt(article, exclude) {
  return findOwnedElements(article, 'a[href*="/status/"] time[datetime]', exclude)[0]
    ?.getAttribute("datetime") ?? "";
}
export function extractEngagement(article, exclude) {
  return findOwnedElements(article, '[role="group"][aria-label]', exclude)
    .map((group) => group.getAttribute("aria-label")?.trim() ?? "")
    .find((label) => /\d/.test(label)) ?? "";
}
export function extractTweetTextLinks(article, exclude) {
  const links = findOwnedElements(article, '[data-testid="tweetText"] a[href]', exclude)
    .map((anchor) => {
      const url = normalizeMediaUrlForContext(anchor.href);
      if (!url) return null;
      const host = new URL(url).hostname.replace(/^www\./, "");
      // Hashtags/mentions/cashtags resolve to x.com paths; external links go through t.co
      // with the (possibly ellipsized) destination as display text.
      if (/(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host)) return null;
      return {
        url,
        displayUrl: anchor.innerText.replace(/\s+/g, "").trim().slice(0, 160)
      };
    })
    .filter(Boolean);
  return uniqueBy(links, (link) => link.url).slice(0, 6);
}
export function extractTweetCard(article, exclude) {
  const card = findOwnedElements(article, '[data-testid="card.wrapper"]', exclude)[0];
  if (!card) return null;
  const anchor = card.querySelector("a[href]");
  const url = normalizeMediaUrlForContext(anchor?.href);
  if (!url) return null;
  const title = (anchor?.getAttribute("aria-label") || card.innerText.replace(/\s+/g, " ")).trim();
  return { url, title: title.slice(0, 240) };
}
export function findQuotedContainer(article) {
  return findOwnedElements(article, 'div[role="link"]')
    .find((element) => element.querySelector('[data-testid="User-Name"], [data-testid="UserName"], article')) ?? null;
}
export function findOwnedElement(article, selector, exclude = null) {
  return findOwnedElements(article, selector, exclude)[0] ?? null;
}
export function findOwnedElements(article, selector, exclude = null) {
  return [...article.querySelectorAll(selector)]
    .filter((element) => element.closest("article") === article
      && (!exclude || (element !== exclude && !exclude.contains(element))));
}
export function findStatusLink(article, exclude = null) {
  const links = findOwnedElements(article, 'a[href*="/status/"]', exclude)
    .filter((link) => extractStatusIdFromUrl(link.getAttribute("href")));
  return links.find((link) => link.querySelector("time")) ?? links.at(-1) ?? null;
}
export function collectVisibleThread(currentArticle) {
  const currentTweet = extractTweet(currentArticle);
  if (!shouldCollectVisibleThreadForArticle(currentTweet)) return [];

  const currentRect = currentArticle.getBoundingClientRect();
  const currentMain = currentArticle.closest("main");
  const currentCenter = currentRect.top + currentRect.height / 2;
  const tweets = queryTweetArticles()
    .filter((article) => {
      if (article === currentArticle || shouldSkipArticle(article)) return false;
      if (currentMain && article.closest("main") !== currentMain) return false;
      return true;
    })
    .map((article, sequenceIndex) => {
      const rect = article.getBoundingClientRect();
      const tweet = extractTweet(article);
      const articleCenter = rect.top + rect.height / 2;
      const isRoot = tweet.statusId && tweet.statusId === extractStatusIdFromUrl(location.href);
      const isBeforeCurrent = articleCenter < currentCenter;
      const isAfterCurrent = articleCenter > currentCenter;
      return {
        ...tweet,
        distanceFromSelected: Math.abs(articleCenter - currentCenter),
        sequenceIndex,
        visibleRole: isRoot
          ? "original_post"
          : isBeforeCurrent
            ? "prior_reply_or_parent_context"
            : isAfterCurrent
              ? "later_reply_or_comment"
              : "visible_thread_context"
      };
    })
    .filter((tweet) => tweet.text || tweet.videoSubtitles?.length);

  const rootAndPrior = tweets
    .filter((tweet) => tweet.visibleRole === "original_post" || tweet.visibleRole === "prior_reply_or_parent_context");
  const laterContext = tweets
    .filter((tweet) => tweet.visibleRole === "later_reply_or_comment")
    .sort((a, b) => a.distanceFromSelected - b.distanceFromSelected)
    .slice(0, 12);

  return uniqueBy([...rootAndPrior, ...laterContext], (tweet) => tweet.statusId || tweet.contextId)
    .sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0))
    .slice(0, 24);
}
export function shouldCollectVisibleThreadForArticle(currentTweet) {
  const pageStatusId = extractStatusIdFromUrl(location.href);
  if (!pageStatusId) return false;
  return true;
}
export function extractQuotedTweet(article) {
  const container = findQuotedContainer(article);
  if (!container) return null;

  // Older X markup nested a full <article> for the quote; handle it if it comes back.
  const innerArticle = container.querySelector("article");
  if (innerArticle) return extractTweet(innerArticle);

  return extractTweetFromQuotedContainer(container);
}
export function extractTweetFromQuotedContainer(container) {
  const text = container.querySelector('[data-testid="tweetText"]')?.innerText
    .replace(/\n{3,}/g, "\n\n")
    .trim() ?? "";
  const authorLines = (container.querySelector('[data-testid="User-Name"], [data-testid="UserName"]')?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const authorHandle = authorLines.find((line) => line.startsWith("@"))?.replace(/^@/, "") ?? "";
  const displayName = authorLines.find((line) => !line.startsWith("@") && !line.includes("·")) ?? "";
  const statusHref = [...container.querySelectorAll('a[href*="/status/"]')]
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .find((href) => extractStatusIdFromUrl(href)) ?? "";
  const statusId = extractStatusIdFromUrl(statusHref);
  const url = statusId ? new URL(statusHref, location.origin).href.replace(/\/(photo|video)\/\d+.*$/, "") : "";
  const contextId = statusId ? `post:${statusId}` : `post:${stableHash(`quoted:${authorHandle}\n${text}`)}`;

  const media = [...container.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="twimg.com/media"]')]
    .filter((image) => isVisibleRect(image.getBoundingClientRect()))
    .map((image, index) => {
      const imageUrl = normalizeTweetImageUrl(image.currentSrc || image.src);
      if (!imageUrl) return null;
      return {
        id: `media:${contextId}:image:${index + 1}`,
        type: "image",
        mediaType: "image",
        url: imageUrl,
        imageUrl,
        altText: image.alt || image.getAttribute("aria-label") || "",
        label: image.closest("[aria-label]")?.getAttribute("aria-label") || "",
        width: image.naturalWidth || Math.round(image.getBoundingClientRect().width),
        height: image.naturalHeight || Math.round(image.getBoundingClientRect().height),
        sequenceIndex: index
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  if (!text && !authorHandle && !media.length) return null;

  return {
    contextId,
    statusId,
    authorHandle,
    displayName,
    url,
    text,
    postedAt: container.querySelector("time[datetime]")?.getAttribute("datetime") ?? "",
    engagement: "",
    socialContext: "",
    textTruncated: Boolean(container.querySelector('[data-testid="tweet-text-show-more-link"]')),
    links: [],
    card: null,
    videoSubtitles: [],
    media
  };
}
export async function waitForArticleContent(timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (document.querySelector("article")) return;
    await sleep(100);
  }
}

