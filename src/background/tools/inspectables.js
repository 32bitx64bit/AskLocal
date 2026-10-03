import {
  mediaIdentity
} from "../media/identity.js";
import { api } from "../api.js";
import {
  normalizeMediaSubtitleGroups
} from "../ask/context.js";
import {
  extractStatusIdFromUrl,
  inferMediaTypeFromUrl,
  isAllowedHttpUrl,
  isAllowedXStatusUrl,
  isRawTweetAudioFileUrl,
  isRawTweetVideoFileUrl,
  normalizeMediaUrl,
  normalizeRawAudioUrls,
  normalizeRawVideoUrls,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  normalizeSearchQuery,
  stableHash,
  uniqueBy
} from "../../lib/utils.js";
import {
  extractTweetVideoMediaId
} from "../media/video.js";
import {
  pruneEmptyValues
} from "../prompt/build.js";

export function assignItemAlias(context, prefix, key) {
  if (!key) return "";
  context.itemAliases ??= new Map();
  const mapKey = `${prefix}:${key}`;
  const existing = context.itemAliases.get(mapKey);
  if (existing) return existing;
  context.aliasCounts ??= { p: 0, l: 0, m: 0 };
  context.aliasCounts[prefix] = (context.aliasCounts[prefix] ?? 0) + 1;
  const alias = `${prefix}${context.aliasCounts[prefix]}`;
  context.itemAliases.set(mapKey, alias);
  return alias;
}
export function lookupItemAlias(context, prefix, key) {
  return key ? context?.itemAliases?.get(`${prefix}:${key}`) ?? "" : "";
}

const MAX_ALIAS_REFS = 300;
const ALIAS_RE = /^([plm])(\d+)$/;

/** Models sometimes wrap ids the way the prompt prints them: [p3], (m1). */
export function normalizeRequestedId(value) {
  return String(value || "").trim().replace(/^[[(]\s*/, "").replace(/\s*[\])]$/, "");
}

/**
 * Restore the short ids (p3, m1, l2) an earlier turn of this chat handed out, so the
 * ids in replayed history keep pointing at the same items. `refs` also let tools
 * resolve ids for items that are not in this ask's freshly gathered context.
 */
export function seedItemAliases(context, state) {
  const refs = state?.refs && typeof state.refs === "object" ? state.refs : null;
  if (!refs) return;
  context.itemAliases ??= new Map();
  context.aliasCounts ??= { p: 0, l: 0, m: 0 };
  context.itemRefs ??= {};
  for (const [alias, ref] of Object.entries(refs)) {
    const match = ALIAS_RE.exec(alias);
    if (!match || !ref || typeof ref.k !== "string" || !ref.k.startsWith(`${match[1]}:`)) continue;
    const [, prefix, number] = match;
    if (!context.itemAliases.has(ref.k)) context.itemAliases.set(ref.k, alias);
    context.itemRefs[alias] = ref;
    context.aliasCounts[prefix] = Math.max(context.aliasCounts[prefix] ?? 0, Number(number));
  }
}

/** Serializable alias state for the next turn (stored on the assistant chat entry). */
export function exportItemAliases(context) {
  const available = buildInspectableItems(context);
  const refs = { ...(context.itemRefs ?? {}) };
  const isAlias = (id, prefix) => ALIAS_RE.exec(String(id || ""))?.[1] === prefix;

  for (const item of available.posts) {
    if (!isAlias(item.id, "p")) continue;
    refs[item.id] = pruneEmptyValues({
      k: `p:${item.longId || item.contextId}`,
      statusId: item.statusId,
      url: item.url,
      handle: item.authorHandle
    });
  }
  for (const item of available.links) {
    if (!isAlias(item.id, "l")) continue;
    refs[item.id] = pruneEmptyValues({
      k: `l:${item.url}`,
      url: item.url,
      title: String(item.title || "").slice(0, 120)
    });
  }
  for (const item of available.media) {
    if (!isAlias(item.id, "m")) continue;
    refs[item.id] = pruneEmptyValues({
      k: `m:${item.longId}`,
      type: item.mediaType,
      url: item.url,
      imageUrl: item.imageUrl,
      posterUrl: item.posterUrl,
      srcUrl: item.srcUrl,
      rawVideoUrls: item.rawVideoUrls,
      rawAudioUrls: item.rawAudioUrls,
      mediaId: item.mediaId,
      statusId: item.statusId,
      contextId: item.contextId,
      postUrl: item.postUrl,
      handle: item.authorHandle
    });
  }

  const kept = Object.entries(refs)
    .filter(([alias, ref]) => ALIAS_RE.test(alias) && ref?.k)
    .sort(([left], [right]) => Number(right.slice(1)) - Number(left.slice(1)))
    .slice(0, MAX_ALIAS_REFS);
  return { v: 1, refs: Object.fromEntries(kept) };
}

function targetFromAliasRef(context, alias) {
  const ref = context?.itemRefs?.[alias];
  if (!ref) return null;
  if (alias.startsWith("p")) {
    const statusId = String(ref.statusId || "");
    const url = ref.url || (statusId ? `https://x.com/i/web/status/${statusId}` : "");
    if (!url) return null;
    return {
      id: alias,
      type: "post",
      source: "earlier_turn",
      contextId: ref.k.slice(2),
      statusId,
      url,
      authorHandle: ref.handle || "",
      text: ""
    };
  }
  if (alias.startsWith("l") && isAllowedHttpUrl(ref.url)) {
    return { id: alias, type: "link", source: "earlier_turn", title: ref.title || "", url: ref.url, snippet: "" };
  }
  return null;
}

function mediaTargetFromAliasRef(context, alias, requestedType) {
  const ref = context?.itemRefs?.[alias];
  if (!ref || !alias.startsWith("m")) return null;
  const mediaType = normalizeMediaType(ref.type);
  if (!mediaType || (requestedType && mediaType !== requestedType)) return null;
  const item = normalizeMediaItemForInspection({ ...ref, id: ref.k.slice(2) }, {
    source: "earlier_turn",
    mediaIndex: 0,
    contextId: ref.contextId || "",
    statusId: ref.statusId || "",
    postUrl: ref.postUrl || "",
    authorHandle: ref.handle || ""
  });
  if (!item) return null;
  item.longId = item.id;
  item.id = alias;
  return item;
}

/** Short media id (m1) for an analysis target, matched by media identity rather than a stored alias. */
export function mediaAliasForTarget(context, target) {
  if (!target) return "";
  const same = (left, right) => Boolean(left && right && normalizeSourceUrl(left) === normalizeSourceUrl(right));
  const items = buildInspectableItems(context).media;
  // Prefer the item on the same post: the same file can sit on several posts (reposts, quotes).
  const identity = mediaIdentity(target);
  const byIdentity = identity ? items.filter((item) => mediaIdentity(item) === identity) : [];
  const onSamePost = byIdentity.find((item) => target.contextId && item.contextId === target.contextId);
  if (onSamePost || byIdentity.length) return (onSamePost ?? byIdentity[0]).id || "";
  const match = items.find((item) => (
    (target.mediaId && item.mediaId === target.mediaId)
    || same(target.url, item.url)
    || same(target.srcUrl, item.srcUrl)
    || same(target.posterUrl, item.posterUrl)
  ));
  return match?.id || "";
}
export function aliasPostItem(context, item) {
  if (!item) return null;
  item.longId = item.contextId || item.id;
  item.id = assignItemAlias(context, "p", item.longId) || item.id;
  return item;
}
export function aliasLinkItem(context, item) {
  if (!item) return null;
  item.longId = item.id;
  item.id = assignItemAlias(context, "l", item.url) || item.id;
  return item;
}
export function aliasMediaItem(context, item) {
  if (!item) return null;
  item.longId = item.id;
  item.id = assignItemAlias(context, "m", item.longId) || item.id;
  item.postRef = lookupItemAlias(context, "p", item.contextId);
  return item;
}
export function buildInspectableItems(context) {
  const posts = [];
  const links = [];
  const media = [];

  const addPost = (tweet, source, index = 0) => {
    const item = aliasPostItem(context, buildInspectablePostItem(tweet, source, index));
    if (item) posts.push(item);
    media.push(...buildInspectableMediaItems(tweet, source, index).map((mediaItem) => aliasMediaItem(context, mediaItem)));

    // External links written in the post and its link-preview card are prime get targets.
    (tweet?.links ?? []).forEach((link, linkIndex) => {
      const linkItem = buildInspectableLinkItem({
        url: link.url,
        title: link.displayUrl || link.title || "",
        snippet: tweet.text ? `Linked from post: ${String(tweet.text).slice(0, 200)}` : ""
      }, `${source}_link`, linkIndex);
      if (linkItem) links.push(aliasLinkItem(context, linkItem));
    });
    if (tweet?.card?.url) {
      const cardItem = buildInspectableLinkItem({
        url: tweet.card.url,
        title: tweet.card.title || "",
        snippet: "Link preview card on the post."
      }, `${source}_card`, 0);
      if (cardItem) links.push(aliasLinkItem(context, cardItem));
    }
  };

  const addLink = (link, source, index = 0) => {
    const item = buildInspectableLinkItem(link, source, index);
    if (item) links.push(aliasLinkItem(context, item));
  };

  (context.xPostContext?.posts ?? []).forEach((tweet, index) => addPost(tweet, "x_post_context", index));
  addPost(context.currentTweet, "current_post");
  addPost(context.quotedTweet, "quoted_post");
  (context.visibleThread ?? []).forEach((tweet, index) => addPost(tweet, "visible_thread", index));

  (context.deepThreads ?? []).forEach((read, readIndex) => {
    (read.thread?.posts ?? []).forEach((tweet, index) => addPost(tweet, `thread_read_${readIndex + 1}`, index));
  });

  (context.searchResults ?? []).forEach((read, readIndex) => {
    (read.results ?? []).forEach((item, index) => {
      if (item.type === "post") addPost(item, `search_result_${readIndex + 1}`, index);
      if (item.type === "link") addLink(item, `search_result_${readIndex + 1}`, index);
    });

    (read.search?.searches ?? []).forEach((search, searchIndex) => {
      (search.posts ?? []).forEach((tweet, index) => addPost(tweet, `${search.source || "x_search"}_${searchIndex + 1}`, index));
      (search.results ?? []).forEach((link, index) => addLink(link, `${search.source || "web_search"}_${searchIndex + 1}`, index));
    });
  });

  (context.webReads ?? []).forEach((read, readIndex) => {
    (read.page?.links ?? []).forEach((link, index) => addLink(link, `page_read_${readIndex + 1}`, index));
  });

  return {
    posts: uniqueBy(posts, (item) => item.id || item.statusId || item.url),
    links: uniqueBy(links, (item) => item.id || item.url),
    media: uniqueBy(media, (item) => item.id || item.url || item.posterUrl)
  };
}
export function buildInspectablePostItem(tweet, source, index = 0) {
  if (!tweet) return null;
  const statusId = String(tweet.statusId || extractStatusIdFromUrl(tweet.url) || "");
  const url = tweet.url || (statusId ? `https://x.com/i/web/status/${statusId}` : "");
  const contextId = tweet.contextId || (statusId ? `post:${statusId}` : `post:${stableHash(`${source}:${index}:${tweet.authorHandle || ""}:${tweet.text || ""}`)}`);
  const text = String(tweet.text || "").trim();
  if (!contextId && !url && !text) return null;

  return {
    id: contextId,
    type: "post",
    source,
    contextId,
    statusId,
    url,
    authorHandle: tweet.authorHandle || "",
    displayName: tweet.displayName || "",
    role: tweet.visibleRole || tweet.threadRole || tweet.searchRole || "",
    postedAt: tweet.postedAt || "",
    engagement: tweet.engagement || "",
    textTruncated: Boolean(tweet.textTruncated),
    text: text.slice(0, 900)
  };
}
export function buildInspectableLinkItem(link, source, index = 0) {
  if (!link?.url || !isAllowedHttpUrl(link.url)) return null;
  const url = link.url;
  return {
    id: link.id || `link:${stableHash(url)}`,
    type: "link",
    source,
    title: String(link.title || "").trim().slice(0, 240),
    url,
    snippet: String(link.snippet || link.text || "").trim().slice(0, 900),
    sequenceIndex: Number.isFinite(link.sequenceIndex) ? link.sequenceIndex : index
  };
}
export function buildInspectableMediaItems(tweet, source, tweetIndex = 0) {
  if (!tweet || !Array.isArray(tweet.media)) return [];
  const statusId = String(tweet.statusId || extractStatusIdFromUrl(tweet.url) || "");
  const postUrl = tweet.url || (statusId ? `https://x.com/i/web/status/${statusId}` : "");
  const contextId = tweet.contextId || (statusId ? `post:${statusId}` : `post:${stableHash(`${source}:${tweetIndex}:${postUrl}`)}`);

  return tweet.media
    .map((media, mediaIndex) => normalizeMediaItemForInspection(media, {
      source,
      tweetIndex,
      mediaIndex,
      contextId,
      statusId,
      postUrl,
      authorHandle: tweet.authorHandle || "",
      displayName: tweet.displayName || "",
      postText: tweet.text || "",
      role: tweet.threadRole || tweet.visibleRole || tweet.searchRole || "",
      postedAt: tweet.postedAt || "",
      engagement: tweet.engagement || "",
      videoSubtitles: tweet.videoSubtitles || []
    }))
    .filter(Boolean);
}
export function normalizeMediaItemForInspection(media, meta) {
  if (!media || typeof media !== "object") return null;
  const mediaType = normalizeMediaType(media.type || media.mediaType || media.kind);
  if (!mediaType) return null;
  const rawVideoUrls = mediaType === "video" ? normalizeRawVideoUrls(media.rawVideoUrls || media.rawUrls || media.videoUrls) : [];
  const rawAudioUrls = mediaType === "video" ? normalizeRawAudioUrls(media.rawAudioUrls || media.audioUrls) : [];
  const url = normalizeMediaUrl(media.url || media.src || media.imageUrl || "");
  const posterUrl = normalizeMediaUrl(media.posterUrl || media.poster || media.thumbnailUrl || "");
  const srcUrl = normalizeMediaUrl(media.srcUrl || media.currentSrc || media.videoUrl || rawVideoUrls[0] || "");
  if (!url && !posterUrl && !srcUrl) return null;

  const id = String(media.id || `media:${meta.contextId}:${mediaType}:${meta.mediaIndex + 1}`);
  return {
    id,
    type: mediaType,
    mediaType,
    source: meta.source,
    contextId: meta.contextId,
    statusId: meta.statusId,
    postUrl: meta.postUrl,
    url: mediaType === "image" ? url || posterUrl || srcUrl : url || posterUrl || srcUrl,
    imageUrl: mediaType === "image" ? url || posterUrl || srcUrl : "",
    posterUrl: mediaType === "video" ? posterUrl || (inferMediaTypeFromUrl(url) === "image" ? url : "") : "",
    srcUrl: mediaType === "video" ? srcUrl : "",
    rawVideoUrls,
    rawAudioUrls,
    mediaId: String(media.mediaId || (mediaType === "video" ? extractTweetVideoMediaId(srcUrl || posterUrl || url) : "") || ""),
    mediaKey: String(media.mediaKey || ""),
    sourceStatusId: String(media.sourceStatusId || ""),
    sourceHandle: String(media.sourceHandle || "").replace(/^@/, ""),
    durationMs: Number(media.durationMs) > 0 ? Number(media.durationMs) : null,
    altText: String(media.altText || media.alt || "").trim().slice(0, 500),
    label: String(media.label || media.ariaLabel || "").trim().slice(0, 240),
    authorHandle: String(meta.authorHandle || "").replace(/^@/, ""),
    displayName: String(meta.displayName || "").trim(),
    postText: String(meta.postText || "").trim().slice(0, 700),
    role: String(meta.role || "").trim(),
    postedAt: String(meta.postedAt || "").trim(),
    engagement: String(meta.engagement || "").trim(),
    videoSubtitles: mediaType === "video" ? normalizeMediaSubtitleGroups(media.videoSubtitles || meta.videoSubtitles).slice(0, 4) : [],
    width: Number.isFinite(Number(media.width)) ? Number(media.width) : null,
    height: Number.isFinite(Number(media.height)) ? Number(media.height) : null,
    sequenceIndex: Number.isFinite(Number(media.sequenceIndex)) ? Number(media.sequenceIndex) : meta.mediaIndex
  };
}
export function normalizeMediaType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["image", "photo", "gif"].includes(type)) return "image";
  if (["video", "movie"].includes(type)) return "video";
  return "";
}
export function filterInspectableItems(items, query) {
  if (!query) return items;
  const needle = query.toLowerCase();
  return items.filter((item) => [
    item.id,
    item.contextId,
    item.statusId,
    item.url,
    item.authorHandle,
    item.displayName,
    item.title,
    item.text,
    item.snippet,
    item.altText,
    item.label,
    item.postText,
    item.mediaType
  ].filter(Boolean).join(" ").toLowerCase().includes(needle));
}
export function editDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left.length || !right.length) return Math.max(left.length, right.length);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}
export function findClosestPostIds(requested, posts, maxResults = 3) {
  const digits = String(requested || "").replace(/\D/g, "");
  if (!digits) return [];
  return (posts ?? [])
    .filter((item) => item.statusId)
    .map((item) => ({ item, distance: editDistance(digits, item.statusId) }))
    .filter(({ distance }) => distance <= 6)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults)
    .map(({ item }) => compactPostRef(item));
}
export function compactPostRef(item) {
  return pruneEmptyValues({
    id: item.id || item.contextId,
    role: item.role || "",
    author: item.authorHandle ? `@${item.authorHandle}` : "",
    text: String(item.text || "").slice(0, 100)
  });
}
export function resolveLookupItems(ids, context) {
  const available = buildInspectableItems(context);
  const catalog = [
    ...available.posts,
    ...available.links,
    ...available.media
  ];
  const items = [];
  const missing = [];
  const seen = new Set();

  for (const requested of ids) {
    const match = catalog.find((item) => itemMatchesLookupId(item, requested));
    if (!match) {
      missing.push(requested);
      continue;
    }
    const key = match.id || match.longId || match.url || requested;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(formatLookupItem(match, requested));
  }

  return { items, missing };
}
export function itemMatchesLookupId(item, requested) {
  const id = String(requested || "").trim();
  if (!id || !item) return false;
  return item.id === id
    || item.longId === id
    || item.contextId === id
    || item.statusId === id
    || item.url === id
    || item.mediaId === id
    || item.postRef === id;
}
export function formatLookupItem(item, requestedId = "") {
  if (!item) return null;
  const mediaType = item.mediaType || (item.type === "image" || item.type === "video" ? item.type : "");
  if (mediaType === "image" || mediaType === "video") {
    const handle = String(item.authorHandle || "").replace(/^@/, "");
    const author = handle ? `@${handle}` : String(item.displayName || "").trim();
    const roleLabel = formatLookupRole(item.role);
    const citeAs = author
      ? `${mediaType} from ${author}`
      : `${mediaType} on the post`;
    const example = author
      ? `the ${mediaType} from ${author}`
      : `the ${mediaType} on that post`;
    return pruneEmptyValues({
      id: item.id,
      requestedId: requestedId || item.id,
      type: mediaType,
      citeAs,
      exampleCite: example,
      authorHandle: handle,
      displayName: String(item.displayName || "").trim(),
      role: item.role || "",
      roleLabel,
      postedAt: item.postedAt || "",
      engagement: item.engagement || "",
      postRef: item.postRef || "",
      postText: String(item.postText || "").slice(0, 700),
      label: String(item.altText || item.label || "").slice(0, 240),
      url: item.url || item.imageUrl || item.srcUrl || item.posterUrl || "",
      postUrl: item.postUrl || "",
      howToCite: `In the user-facing answer write "${example}" (or "${citeAs}"). Never write ${item.id}, [${item.id}], (${item.id}), or other internal ids.`
    });
  }

  if (item.type === "link" || (!item.authorHandle && item.url && !item.statusId)) {
    const title = String(item.title || "").trim();
    const citeAs = title || getHostnameSafe(item.url) || item.url;
    return pruneEmptyValues({
      id: item.id,
      requestedId: requestedId || item.id,
      type: "link",
      citeAs,
      exampleCite: citeAs,
      title,
      url: item.url || "",
      snippet: String(item.snippet || "").slice(0, 900),
      howToCite: `Cite as "${citeAs}" or the page URL. Never write ${item.id}, [${item.id}], or other internal ids.`
    });
  }

  const handle = String(item.authorHandle || "").replace(/^@/, "");
  const displayName = String(item.displayName || "").trim();
  const citeAs = handle ? `@${handle}` : (displayName || "Unknown author");
  const roleLabel = formatLookupRole(item.role);
  return pruneEmptyValues({
    id: item.id,
    requestedId: requestedId || item.id,
    type: "post",
    citeAs,
    exampleCite: citeAs,
    authorHandle: handle,
    displayName,
    role: item.role || "",
    roleLabel,
    postedAt: item.postedAt || "",
    engagement: item.engagement || "",
    text: String(item.text || "").slice(0, 900),
    textTruncated: Boolean(item.textTruncated),
    url: item.url || "",
    statusId: item.statusId || "",
    howToCite: `Cite as ${citeAs}${roleLabel ? ` (${roleLabel})` : ""}. Never write ${item.id}, [${item.id}], (${item.id}), or other internal ids.`
  });
}
function formatLookupRole(role) {
  const key = String(role || "").trim().toLowerCase();
  if (!key) return "";
  if (key === "root_post" || key === "conversation_root") return "thread root";
  if (key === "selected_post") return "selected post";
  if (key === "parent_context") return "ancestor post";
  if (key === "quoted_post") return "quoted post";
  if (key === "top_liked_reply") return "top reply";
  if (key === "x_ranked_reply") return "ranked reply";
  if (key === "thread_comment") return "root comment";
  return key.replace(/_/g, " ");
}
function getHostnameSafe(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function compactLinkRef(item) {
  return pruneEmptyValues({
    id: item.id,
    title: String(item.title || "").slice(0, 80),
    url: item.url
  });
}
export function compactMediaRef(item) {
  const handle = String(item.authorHandle || "").replace(/^@/, "");
  const author = handle ? `@${handle}` : "";
  const type = item.mediaType || item.type || "";
  return pruneEmptyValues({
    id: item.id,
    type,
    citeAs: author && type ? `${type} from ${author}` : (author || type || ""),
    author: author,
    role: item.role || "",
    post: item.postRef || item.contextId || "",
    label: String(item.altText || item.label || item.postText || "").slice(0, 120)
  });
}
export function resolveInspectableTarget(args, context) {
  const available = buildInspectableItems(context);
  const requestedId = normalizeRequestedId(args.id || args.context_id || args.contextId || args.post_id || args.postId || "");
  const requestedStatusId = String(args.status_id || args.statusId || "").trim()
    || requestedId.match(/^post:(\d+)$/)?.[1]
    || (requestedId.match(/^\d+$/) ? requestedId : "");
  const requestedUrl = String(args.url || "").trim();

  if (requestedId) {
    const match = [...available.posts, ...available.links].find((item) => {
      return item.id === requestedId
        || item.longId === requestedId
        || item.contextId === requestedId
        || item.statusId === requestedId
        || item.url === requestedId;
    });
    if (match) return match;
    const fromEarlierTurn = targetFromAliasRef(context, requestedId);
    if (fromEarlierTurn) return fromEarlierTurn;
  }

  if (requestedStatusId) {
    const match = available.posts.find((item) => item.statusId === requestedStatusId);
    if (match) return match;
    return {
      id: `post:${requestedStatusId}`,
      type: "post",
      source: "status_id",
      contextId: `post:${requestedStatusId}`,
      statusId: requestedStatusId,
      url: `https://x.com/i/web/status/${requestedStatusId}`
    };
  }

  if (requestedUrl && isAllowedXStatusUrl(requestedUrl)) {
    const statusId = extractStatusIdFromUrl(requestedUrl);
    return {
      id: statusId ? `post:${statusId}` : `post:${stableHash(requestedUrl)}`,
      type: "post",
      source: "url",
      contextId: statusId ? `post:${statusId}` : "",
      statusId,
      url: requestedUrl
    };
  }

  if (requestedUrl && isAllowedHttpUrl(requestedUrl)) {
    const match = available.links.find((item) => item.url === requestedUrl);
    return match ?? {
      id: `link:${stableHash(requestedUrl)}`,
      type: "link",
      source: "url",
      title: "",
      url: requestedUrl,
      snippet: ""
    };
  }

  return null;
}
export function resolveInspectableMediaTarget(args, context, requestedType = "") {
  const available = buildInspectableItems(context);
  const mediaItems = available.media.filter((item) => !requestedType || item.mediaType === requestedType);
  const requestedId = normalizeRequestedId(args.id || args.media_id || args.mediaId || "");
  const requestedContextId = normalizeRequestedId(args.context_id || args.contextId || "");
  const requestedUrl = String(args.url || "").trim();

  if (requestedId) {
    const match = mediaItems.find((item) => item.id === requestedId || item.longId === requestedId || item.mediaId === requestedId);
    if (match) return match;
    // A post id (p3) names the media attached to that post.
    const onPost = mediaItems.find((item) => item.postRef === requestedId || item.contextId === requestedId);
    if (onPost) return onPost;
    const fromEarlierTurn = mediaTargetFromAliasRef(context, requestedId, requestedType);
    if (fromEarlierTurn) return fromEarlierTurn;
  }

  if (requestedUrl) {
    const normalizedUrl = normalizeMediaUrl(requestedUrl);
    const match = mediaItems.find((item) => {
      return [item.url, item.imageUrl, item.posterUrl, item.srcUrl, ...(Array.isArray(item.rawVideoUrls) ? item.rawVideoUrls : [])]
        .filter(Boolean)
        .some((candidate) => normalizeSourceUrl(candidate) === normalizeSourceUrl(normalizedUrl));
    });
    if (match) return match;
    if (normalizedUrl) {
      const mediaType = requestedType || inferMediaTypeFromUrl(normalizedUrl);
      if (mediaType) {
        return {
          id: `media:${stableHash(normalizedUrl)}`,
          type: mediaType,
          mediaType,
          source: "url",
          contextId: "",
          statusId: "",
          postUrl: "",
          url: normalizedUrl,
          imageUrl: mediaType === "image" ? normalizedUrl : "",
          posterUrl: "",
          srcUrl: mediaType === "video" && isRawTweetVideoFileUrl(normalizedUrl) ? normalizedUrl : "",
          rawVideoUrls: mediaType === "video" && isRawTweetVideoFileUrl(normalizedUrl) ? [normalizedUrl] : [],
          rawAudioUrls: mediaType === "video" && isRawTweetAudioFileUrl(normalizedUrl) ? [normalizedUrl] : [],
          mediaId: mediaType === "video" ? extractTweetVideoMediaId(normalizedUrl) : "",
          altText: "",
          label: "",
          postText: "",
          videoSubtitles: []
        };
      }
    }
  }

  if (requestedContextId) {
    const match = mediaItems.find((item) => item.contextId === requestedContextId || item.postRef === requestedContextId);
    if (match) return match;
  }

  // Only default to the first media item when the call named no target at all. An
  // unmatched id must fail loudly: silently analyzing a different image made the
  // model describe the wrong media as if it were the one it asked for.
  if (requestedId || requestedUrl || requestedContextId) return null;
  return mediaItems[0] ?? null;
}
export function summarizeMediaTarget(target) {
  return {
    id: target.id,
    type: target.mediaType,
    contextId: target.contextId,
    statusId: target.statusId,
    postUrl: target.postUrl,
    url: target.url,
    posterUrl: target.posterUrl,
    srcUrl: target.srcUrl,
    mediaId: target.mediaId,
    mediaKey: target.mediaKey,
    sourceStatusId: target.sourceStatusId,
    sourceHandle: target.sourceHandle,
    sequenceIndex: target.sequenceIndex,
    altText: target.altText,
    label: target.label,
    authorHandle: target.authorHandle,
    displayName: target.displayName,
    role: target.role,
    postedAt: target.postedAt,
    engagement: target.engagement,
    postText: target.postText
  };
}
export function threadTargetFromInspectableItem(item) {
  const statusId = item.statusId || extractStatusIdFromUrl(item.url);
  return {
    source: item.source || "get",
    contextId: item.contextId || item.id || (statusId ? `post:${statusId}` : ""),
    statusId,
    url: item.url || (statusId ? `https://x.com/i/web/status/${statusId}` : ""),
    authorHandle: item.authorHandle || ""
  };
}
export function buildContextSearchQuery(question, context) {
  const tweet = context.currentTweet ?? {};
  const postText = normalizeSearchQuery(tweet.text || "");
  const handle = normalizeSearchQuery(tweet.authorHandle ? `@${tweet.authorHandle.replace(/^@/, "")}` : "");
  const questionText = normalizeSearchQuery(question || "");

  if (postText) {
    return normalizeSearchQuery([handle, postText].filter(Boolean).join(" ")).slice(0, 240);
  }

  return questionText.slice(0, 240);
}

