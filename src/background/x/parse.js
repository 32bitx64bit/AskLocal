import { api } from "../api.js";
import {
  expandXShortUrls,
  normalizePlainText
} from "../../lib/text.js";
import {
  extractStatusIdFromUrl,
  normalizePotentialHttpUrl,
  normalizeSourceUrl,
  normalizeTweetImageUrlForBackground
} from "../../lib/url.js";
import {
  clampNumber,
  formatCompactNumber,
  uniqueBy
} from "../../lib/utils.js";
import {
  extractTweetVideoMediaId,
  normalizePlayableTweetAudioUrl,
  normalizePlayableTweetVideoUrl
} from "../media/video.js";

export function buildTweetDetailVariables(statusId, cursor = "") {
  const variables = {
    focalTweetId: String(statusId),
    with_rux_injections: false,
    rankingMode: "Relevance",
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true
  };
  if (cursor) variables.cursor = cursor;
  return variables;
}
export function collectTweetsFromTweetDetail(data, meta = {}) {
  const tweets = [];
  const entries = extractXTimelineEntries(data);
  entries.forEach((entry, entryIndex) => {
    const content = entry.content ?? {};
    const sourceRole = inferXEntrySourceRole(entry, meta.focalStatusId);
    const itemContents = [];
    if (content.itemContent) itemContents.push(content.itemContent);
    if (Array.isArray(content.items)) {
      content.items.forEach((item) => {
        if (item?.item?.itemContent) itemContents.push(item.item.itemContent);
      });
    }

    itemContents.forEach((itemContent, itemIndex) => {
      collectXTweetResult(itemContent.tweet_results?.result, {
        ...meta,
        entryIndex,
        itemIndex,
        entryId: entry.entryId || "",
        sourceRole
      }, tweets);
    });
  });
  return tweets;
}
export function collectTweetsFromXObject(data, meta = {}) {
  const tweets = [];
  const seen = new WeakSet();
  const walk = (node, path = "") => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    const result = unwrapXTweetResult(node.tweet_results?.result || node);
    if (result?.legacy && (result.rest_id || result.legacy.id_str)) {
      collectXTweetResult(result, {
        ...meta,
        entryId: path,
        entryIndex: tweets.length
      }, tweets);
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") walk(value, path ? `${path}.${key}` : key);
    }
  };
  walk(data);
  return tweets;
}
export function buildPostFromXSearchFallback(result, index = 0) {
  const url = normalizePotentialHttpUrl(result?.url || "");
  const statusId = extractStatusIdFromUrl(url);
  if (!statusId) return null;
  const authorHandle = new URL(url).pathname.split("/").filter(Boolean)[0] || "";
  const text = normalizePlainText([result.title, result.snippet].filter(Boolean).join("\n")).slice(0, 900);
  return {
    contextId: `post:${statusId}`,
    statusId,
    authorHandle,
    displayName: "",
    url,
    text,
    postedAt: "",
    engagement: "",
    socialContext: "",
    textTruncated: false,
    links: [],
    card: null,
    videoSubtitles: [],
    media: [],
    searchRole: "x_search_result",
    sequenceIndex: index
  };
}
export function extractXTimelineEntries(data) {
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions.flatMap((instruction) => Array.isArray(instruction.entries) ? instruction.entries : []);
}
export function extractXBottomCursor(data) {
  const entries = extractXTimelineEntries(data);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (/cursor-bottom/i.test(entry?.entryId || "") || entry?.content?.cursorType === "Bottom") {
      return String(entry?.content?.value || "");
    }
  }
  return "";
}
export function inferXEntrySourceRole(entry, focalStatusId) {
  const entryId = String(entry?.entryId || "");
  if (entryId === `tweet-${focalStatusId}`) return "root_post";
  if (entryId.startsWith("conversationthread-")) return "reply_or_comment";
  return "";
}
export function collectXTweetResult(result, meta, output) {
  const tweetResult = unwrapXTweetResult(result);
  const tweet = normalizeXTweetResult(tweetResult, meta);
  if (!tweet) return;
  output.push(tweet);

  const quotedResult = unwrapXTweetResult(tweetResult?.quoted_status_result?.result);
  const quoted = normalizeXTweetResult(quotedResult, {
    ...meta,
    sourceRole: "quoted_post",
    quotedByStatusId: tweet.statusId
  });
  if (quoted) output.push(quoted);
}
export function unwrapXTweetResult(result) {
  let node = result;
  for (let index = 0; index < 6; index += 1) {
    if (!node || typeof node !== "object") return null;
    if (node.legacy || node.rest_id) return node;
    if (node.tweet_results?.result) {
      node = node.tweet_results.result;
      continue;
    }
    if (node.result) {
      node = node.result;
      continue;
    }
    if (node.tweet) {
      node = node.tweet;
      continue;
    }
    return node;
  }
  return node;
}
export function normalizeXTweetResult(result, meta = {}) {
  if (!result || typeof result !== "object") return null;
  const legacy = result.legacy ?? {};
  const statusId = String(legacy.id_str || result.rest_id || "");
  if (!statusId) return null;
  if (!legacy.full_text && !legacy.conversation_id_str && !result.note_tweet?.note_tweet_results?.result?.text && !result.note_tweet_results?.result?.text) return null;

  const user = extractXTweetUser(result);
  const rawLinks = extractXTweetLinks(result);
  const noteText = result.note_tweet?.note_tweet_results?.result?.text
    || result.note_tweet_results?.result?.text
    || "";
  const rawText = noteText || legacy.full_text || "";
  const text = expandXShortUrls(normalizePlainText(rawText), rawLinks);
  const metrics = {
    replies: Number(legacy.reply_count || 0),
    reposts: Number(legacy.retweet_count || 0),
    quotes: Number(legacy.quote_count || 0),
    likes: Number(legacy.favorite_count || 0),
    bookmarks: Number(legacy.bookmark_count || 0),
    views: Number(result.views?.count || 0)
  };
  const contextId = `post:${statusId}`;

  return {
    contextId,
    statusId,
    conversationId: String(legacy.conversation_id_str || ""),
    authorHandle: user.handle,
    displayName: user.displayName,
    url: user.handle ? `https://x.com/${user.handle}/status/${statusId}` : `https://x.com/i/web/status/${statusId}`,
    text,
    postedAt: parseXCreatedAt(legacy.created_at),
    engagement: formatXEngagement(metrics),
    metrics,
    socialContext: "",
    textTruncated: Boolean(legacy.truncated),
    links: rawLinks.map((link) => ({
      url: link.expandedUrl || link.url,
      displayUrl: link.displayUrl || link.expandedUrl || link.url
    })),
    card: extractXTweetCard(result),
    videoSubtitles: [],
    media: extractXTweetMedia(result, { contextId, statusId }),
    sourceRole: meta.sourceRole || "",
    quotedByStatusId: meta.quotedByStatusId || "",
    sequenceIndex: meta.entryIndex ?? 0
  };
}
export function extractXTweetUser(result) {
  const userResult = result?.core?.user_results?.result;
  const legacy = userResult?.legacy ?? {};
  return {
    handle: String(legacy.screen_name || "").replace(/^@/, ""),
    displayName: String(legacy.name || "")
  };
}
export function extractXTweetLinks(result) {
  const legacy = result?.legacy ?? {};
  const note = result?.note_tweet?.note_tweet_results?.result ?? result?.note_tweet_results?.result ?? {};
  const urls = [
    ...(legacy.entities?.urls ?? []),
    ...(note.entity_set?.urls ?? [])
  ];
  return uniqueBy(urls.map((item) => {
    const expandedUrl = normalizePotentialHttpUrl(item.expanded_url || item.expandedUrl || item.url);
    const url = normalizePotentialHttpUrl(item.url || expandedUrl);
    if (!expandedUrl && !url) return null;
    return {
      url: url || expandedUrl,
      expandedUrl: expandedUrl || url,
      displayUrl: String(item.display_url || item.displayUrl || expandedUrl || url || "").replace(/\s+/g, "").slice(0, 180)
    };
  }).filter(Boolean), (link) => link.expandedUrl || link.url).slice(0, 8);
}
export function extractXTweetCard(result) {
  const values = result?.card?.legacy?.binding_values;
  if (!Array.isArray(values)) return null;
  const map = new Map(values.map((item) => [item?.key, item?.value]));
  const cardUrl = normalizePotentialHttpUrl(
    map.get("card_url")?.string_value
    || map.get("website_url")?.string_value
    || ""
  );
  if (!cardUrl) return null;
  const title = map.get("title")?.string_value
    || map.get("site")?.string_value
    || map.get("domain")?.string_value
    || "";
  return { url: cardUrl, title: String(title).slice(0, 240) };
}
export function extractXTweetMedia(result, meta) {
  const legacy = result?.legacy ?? {};
  const mediaItems = [
    ...(legacy.extended_entities?.media ?? []),
    ...(legacy.entities?.media ?? [])
  ];

  return uniqueBy(mediaItems.map((item, index) => normalizeXMediaEntity(item, meta, index)).filter(Boolean), (item) => `${item.mediaType}:${item.url || item.srcUrl || item.id}`).slice(0, 8);
}
export function normalizeXMediaEntity(item, meta, index) {
  const xType = String(item?.type || "").toLowerCase();
  const isVideo = xType === "video" || xType === "animated_gif";
  const imageUrl = normalizeTweetImageUrlForBackground(item?.media_url_https || item?.media_url || "");
  const rawVideoUrls = isVideo
    ? uniqueBy((item.video_info?.variants ?? [])
      .map((variant) => ({
        url: normalizePlayableTweetVideoUrl(variant?.url),
        bitrate: Number(variant?.bitrate || 0)
      }))
      .filter((variant) => variant.url)
      .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
      .map((variant) => variant.url), (url) => normalizeSourceUrl(url))
    : [];
  const rawAudioUrls = isVideo
    ? uniqueBy((item.video_info?.variants ?? [])
      .map((variant) => ({
        url: normalizePlayableTweetAudioUrl(variant?.url),
        bitrate: Number(variant?.bitrate || 0)
      }))
      .filter((variant) => variant.url)
      .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
      .map((variant) => variant.url), (url) => normalizeSourceUrl(url))
    : [];

  if (!imageUrl && !rawVideoUrls.length) return null;
  const mediaType = isVideo ? "video" : "image";
  const id = `media:${meta.contextId}:${mediaType}:${index + 1}`;
  return {
    id,
    type: mediaType,
    mediaType,
    url: imageUrl || rawVideoUrls[0] || "",
    imageUrl: mediaType === "image" ? imageUrl : "",
    posterUrl: mediaType === "video" ? imageUrl : "",
    srcUrl: mediaType === "video" ? rawVideoUrls[0] || "" : "",
    rawVideoUrls,
    rawAudioUrls,
    mediaId: String(item.id_str || item.id || extractTweetVideoMediaId(imageUrl || rawVideoUrls[0]) || ""),
    altText: String(item.ext_alt_text || "").slice(0, 500),
    label: "",
    width: Number(item.original_info?.width || item.sizes?.large?.w || 0) || null,
    height: Number(item.original_info?.height || item.sizes?.large?.h || 0) || null,
    sequenceIndex: index
  };
}
export function compareTweetsByContextValue(left, right) {
  const leftMetrics = left.metrics ?? {};
  const rightMetrics = right.metrics ?? {};
  return Number(rightMetrics.likes || 0) - Number(leftMetrics.likes || 0)
    || Number(rightMetrics.replies || 0) - Number(leftMetrics.replies || 0)
    || Number(rightMetrics.reposts || 0) - Number(leftMetrics.reposts || 0);
}
export function formatCompiledTweet(tweet, options = {}) {
  if (!tweet) return "";
  const longId = tweet.contextId || (tweet.statusId ? `post:${tweet.statusId}` : "");
  const id = options.aliasOf?.(tweet) || longId;
  const author = tweet.authorHandle ? `@${tweet.authorHandle}` : tweet.displayName || "unknown author";
  const role = formatThreadRoleLabel(tweet.threadRole || tweet.visibleRole || tweet.searchRole);
  const meta = [tweet.postedAt, tweet.engagement].filter(Boolean).join(", ");
  const maxChars = clampNumber(options.maxChars, 100, 4000, 900);
  const text = normalizePlainText(tweet.text || "").slice(0, maxChars) || "[no readable text]";
  const flags = [];
  (Array.isArray(tweet.media) ? tweet.media : []).forEach((item) => {
    const mediaType = item?.type || item?.mediaType;
    const mediaAuthor = item?.authorHandle
      ? `@${String(item.authorHandle).replace(/^@/, "")}`
      : author;
    if (mediaType === "video") {
      const hasSubtitles = Boolean(item.videoSubtitles?.length || tweet.videoSubtitles?.length);
      flags.push(
        `[video from ${mediaAuthor}${hasSubtitles ? " with subtitles" : ""}]`
      );
    } else if (mediaType === "image") {
      const alt = String(item.altText || "").trim().slice(0, 140);
      flags.push(
        `[image from ${mediaAuthor}${alt ? `: ${alt}` : ""}]`
      );
    }
  });
  if (tweet.card?.url) {
    flags.push(`[link card: ${[tweet.card.title, tweet.card.url].filter(Boolean).join(" ")}]`.slice(0, 220));
  }
  if (tweet.textTruncated) flags.push(id ? `[truncated: get ${id} for full text]` : "[truncated]");
  const head = [id ? `[${id}]` : "", role ? `(${role})` : "", author].filter(Boolean).join(" ");
  return `${head}${meta ? ` (${meta})` : ""}: ${text}${flags.length ? ` ${flags.join(" ")}` : ""}`;
}
export function formatThreadRoleLabel(role) {
  const key = String(role || "").trim().toLowerCase();
  if (!key) return "";
  if (key === "root_post" || key === "conversation_root") return "thread root";
  if (key === "selected_post") return "selected";
  if (key === "parent_context") return "ancestor";
  if (key === "quoted_post") return "quoted";
  if (key === "top_liked_reply") return "top reply";
  if (key === "x_ranked_reply") return "ranked reply";
  if (key === "thread_comment") return "root comment";
  return key.replace(/_/g, " ");
}
export function formatCompiledSubtitles(tweet, maxChars) {
  const cap = clampNumber(maxChars, 100, 12000, 2400);
  const groups = Array.isArray(tweet?.videoSubtitles) ? tweet.videoSubtitles : [];
  const lines = [];
  let remaining = cap;
  for (const group of groups) {
    if (remaining <= 0) break;
    const text = (group.cues ?? []).map((cue) => cue?.text).filter(Boolean).join(" ");
    if (!text) continue;
    const label = [group.source || "Video subtitles", group.language].filter(Boolean).join(", ");
    const full = `${label}: ${text}`;
    const line = full.slice(0, remaining);
    lines.push(line.length < full.length ? `${line}…` : line);
    remaining -= line.length;
  }
  return lines.join("\n");
}
export function formatXEngagement(metrics = {}) {
  return [
    ["replies", metrics.replies],
    ["reposts", metrics.reposts],
    ["quotes", metrics.quotes],
    ["likes", metrics.likes],
    ["bookmarks", metrics.bookmarks],
    ["views", metrics.views]
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${formatCompactNumber(value)} ${label}`)
    .join(", ");
}
export function parseXCreatedAt(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw.slice(0, 80) : date.toISOString();
}

