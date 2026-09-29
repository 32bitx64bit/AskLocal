import {
  getHostname
} from "../../lib/url.js";
import {
  normalizePlainText
} from "../../lib/text.js";
import {
  uniqueBy
} from "../../lib/utils.js";
import {
  trimStitchedAnalysis
} from "../media/video.js";
import {
  capText
} from "../prompt/budget.js";
import {
  buildInspectableItems,
  lookupItemAlias,
  mediaAliasForTarget
} from "./inspectables.js";
import {
  formatCompiledTweet
} from "../x/parse.js";

/**
 * Tool results go back to the model as compact text in the same shape as the
 * prompt's own context lines ("[p5] (reply) @user (date, engagement): text"),
 * not as the raw executor objects. The raw objects repeat every post (a thread's
 * `posts` is the union of its other arrays), carry media URLs, metrics, and
 * bookkeeping fields, and came out ~8x larger than the content they held.
 */
export function renderToolResultForModel(name, result, context, { maxChars = 4000 } = {}) {
  if (!result || typeof result !== "object") return capText(String(result ?? ""), maxChars);
  if (result.duplicate) return String(result.note || "Duplicate tool call.");
  let text = "";
  try {
    text = renderByTool(name, result, context, maxChars);
  } catch {
    text = "";
  }
  if (!text) text = compactJson(result);
  const cap = name === "get" && result.batch ? Math.round(maxChars * 1.5) : maxChars;
  return capText(text, cap);
}

/**
 * Tool results from this answer, carried into the next user message so follow-ups
 * can build on what was already found. Opened pages, threads, and media analyses win
 * over search result lists when space runs out; output keeps call order.
 */
export function buildEvidenceDigest(entries, maxChars) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.text) : [];
  if (!list.length) return "";
  const ranked = list
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const kept = [];
  let used = 0;
  for (const entry of ranked) {
    const room = Math.floor(maxChars) - used;
    if (room < 300) break;
    const text = capText(entry.text, room);
    kept.push({ ...entry, text });
    used += text.length + 2;
  }
  return kept
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.text)
    .join("\n\n");
}

/** Rank for the evidence carried into the next turn: opened sources beat result lists. */
export function evidencePriority(name) {
  if (name === "get" || name === "read_thread" || name === "analyze_image" || name === "analyze_video") return 1;
  if (name === "web_search" || name === "x_search") return 2;
  return 0;
}

function renderByTool(name, result, context, maxChars) {
  if (name === "get" || name === "read_thread") {
    return result.batch ? renderGetBatch(result, context, maxChars) : renderGetSingle(result, context, maxChars);
  }
  if (name === "web_search") return renderWebSearch(result);
  if (name === "x_search") return renderXSearch(result);
  if (name === "analyze_image" || name === "analyze_video") return renderMediaAnalysis(result, context, maxChars);
  if (name === "lookup") return renderLookup(result);
  if (name === "fetch") return renderFetch(result);
  return result.ok ? "" : renderError(result);
}

function renderError(result) {
  const lines = [`Error: ${String(result.error || "The tool call failed.").trim()}`];
  if (result.didYouMean?.length) {
    lines.push(`Did you mean: ${result.didYouMean.map(formatRefLine).join("; ")}`);
  }
  if (result.availablePosts?.length) {
    lines.push(`Posts you can open: ${result.availablePosts.map((ref) => `${ref.id}${ref.author ? ` ${ref.author}` : ""}`).join(", ")}`);
  }
  if (result.availableLinks?.length) {
    lines.push(`Links you can open: ${result.availableLinks.map((ref) => `${ref.id}${ref.title ? ` "${ref.title}"` : ""}`).join(", ")}`);
  }
  const media = [...(result.availableImages ?? []), ...(result.availableVideos ?? [])];
  if (media.length) {
    lines.push(`Media you can analyze: ${media.map((ref) => `${ref.id} (${ref.citeAs || ref.type || "media"})`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatRefLine(ref) {
  const text = String(ref?.text || "").replace(/\s+/g, " ").slice(0, 80);
  return [ref?.id, ref?.author, text ? `"${text}"` : ""].filter(Boolean).join(" ");
}

function renderGetBatch(result, context, maxChars) {
  const results = Array.isArray(result.results) ? result.results : [];
  const perItem = Math.max(1200, Math.floor((maxChars * 1.5) / Math.max(1, results.length)) - 40);
  const header = [`Opened ${Number(result.opened || 0)} of ${Number(result.requested || results.length)}.`];
  if (result.skipped?.length) {
    header.push(`Not opened (over the per-turn limit of ${result.maxMultiLinks}): ${result.skipped.join(", ")}.`);
  }
  const parts = results.map((entry) => capText(renderGetSingle(entry, context, perItem), perItem));
  return [header.join(" "), ...parts].join("\n\n---\n\n");
}

function renderGetSingle(result, context, maxChars) {
  if (!result) return "";
  if (!result.ok) {
    if (result.type === "link") {
      const url = result.page?.url || result.target?.url || "";
      return `Could not read ${url || "the page"}: ${result.page?.error || result.error || "unknown error"}`;
    }
    return renderError(result);
  }
  if (result.type === "post") return renderThread(result.thread, context, maxChars);
  if (result.type === "link") return renderPage(result, context, maxChars);
  return "";
}

function renderThread(thread, context, maxChars) {
  if (!thread) return "";
  // Assign short ids to the posts this read just added to the context.
  buildInspectableItems(context);
  const aliasOf = (tweet) => lookupItemAlias(context, "p", tweet?.contextId || (tweet?.statusId ? `post:${tweet.statusId}` : ""));
  const keyOf = (tweet) => tweet?.statusId || tweet?.contextId || "";
  const seen = new Set();
  const lines = [`X post${thread.url ? ` ${thread.url}` : ""}:`];
  const section = (label, tweets, chars, limit) => {
    const fresh = (tweets ?? []).filter((tweet) => tweet && keyOf(tweet) && !seen.has(keyOf(tweet))).slice(0, limit);
    if (!fresh.length) return;
    lines.push(label);
    for (const tweet of fresh) {
      seen.add(keyOf(tweet));
      lines.push(formatCompiledTweet(tweet, { aliasOf, maxChars: chars }));
    }
  };

  const focal = thread.root;
  if (thread.conversationRoot && keyOf(thread.conversationRoot) !== keyOf(focal)) {
    section("Thread root:", [thread.conversationRoot], 1200, 1);
  }
  section("Earlier in the thread:", thread.parents, 500, 6);
  section("Post:", [focal], Math.min(4000, Math.max(800, Math.floor(maxChars * 0.4))), 1);
  section("Quoted post:", [thread.quoted], 1500, 1);
  section(
    "Replies (most liked first):",
    uniqueBy([...(thread.topLikedReplies ?? []), ...(thread.rankedReplies ?? [])], keyOf),
    400,
    12
  );
  section("Other replies to the thread root:", thread.rootReplies, 300, 6);
  if (lines.length === 1) lines.push(thread.error || "No readable posts were returned.");
  return lines.join("\n");
}

function renderPage(result, context, maxChars) {
  const page = result.page ?? {};
  const url = page.url || result.target?.url || "";
  const title = String(page.title || result.target?.title || "").trim();
  // Page links get short ids when the inspectable list is rebuilt.
  buildInspectableItems(context);
  const alias = lookupItemAlias(context, "l", result.target?.url || url) || lookupItemAlias(context, "l", url);
  const header = `Page${alias ? ` ${alias}` : ""}: ${title ? `"${title}" ` : ""}(${url})`;

  const links = (page.links ?? []).slice(0, 6).map((link) => {
    const id = lookupItemAlias(context, "l", link.url);
    return `- ${id ? `${id}: ` : ""}${String(link.title || "").slice(0, 100)} (${getHostname(link.url) || link.url})`;
  });
  const linksBlock = links.length ? `\nLinks on this page:\n${links.join("\n")}` : "";
  const text = normalizePlainText(page.text || page.description || "");
  const room = Math.max(600, maxChars - header.length - linksBlock.length - 10);
  return `${header}\n${capText(text, room) || "[no readable text]"}${linksBlock}`;
}

function renderWebSearch(result) {
  if (!result.ok) {
    if (result.challenge || /bot check|captcha/i.test(result.error || "")) {
      return "Web search was blocked by a bot check. Don't retry it; tell the user web search was blocked if it matters.";
    }
    return `Web search failed: ${result.error || "no results"}`;
  }
  const items = Array.isArray(result.results) ? result.results : [];
  const lines = [`Web results for "${result.query}":`];
  if (!items.length) lines.push("No results.");
  for (const item of items) {
    const host = getHostname(item.url) || item.url;
    const snippet = String(item.snippet || "").replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(`- ${item.id}: ${String(item.title || host).slice(0, 140)} (${host})${snippet ? `\n  ${snippet}` : ""}`);
  }
  if (items.length) lines.push("Open the relevant results with get (several ids in one call) before relying on them.");
  return lines.join("\n");
}

function renderXSearch(result) {
  if (!result.ok) return `X search failed: ${result.error || "no results"}`;
  const items = Array.isArray(result.results) ? result.results : [];
  const lines = [`X posts for "${result.query}":`];
  if (!items.length) lines.push("No results.");
  for (const item of items) {
    const author = item.authorHandle ? `@${item.authorHandle}` : item.displayName || "unknown author";
    const meta = [item.postedAt, item.engagement].filter(Boolean).join(", ");
    const text = String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
    lines.push(`- [${item.id}] ${author}${meta ? ` (${meta})` : ""}: ${text || "[no readable text]"}${item.textTruncated ? " [truncated]" : ""}`);
  }
  if (items.length) lines.push("Open posts with get to read the full text and replies.");
  return lines.join("\n");
}

function describeMediaTarget(target, fallbackType) {
  const type = target?.type || target?.mediaType || fallbackType || "media";
  const handle = String(target?.authorHandle || "").replace(/^@/, "");
  return handle ? `${type} from @${handle}` : type;
}

function renderMediaAnalysis(result, context, maxChars) {
  const fallbackType = result.tool === "analyze_video" ? "video" : "image";
  if (!result.ok) return renderError(result);
  const citeAs = result.citeAs || describeMediaTarget(result.target, result.type || fallbackType);
  if (result.reusedFromContext || result.already_in_context) {
    return `The ${citeAs} was already analyzed; that analysis is earlier in this conversation.${result.summary ? ` Summary: ${result.summary}` : ""}`;
  }
  const alias = mediaAliasForTarget(context, result.target);
  const label = (result.type || fallbackType) === "video" ? "Video" : "Image";
  const lines = [`${label} analysis of the ${citeAs}${alias ? ` (${alias})` : ""}:`];
  const analysisCap = Math.floor(maxChars * (result.audioAnalysis ? 0.65 : 0.95));
  lines.push(trimStitchedAnalysis(String(result.analysis || "").trim(), analysisCap) || "[no visual analysis returned]");
  const audio = String(result.audioAnalysis || "").trim();
  if (audio) lines.push("Audio:", trimStitchedAnalysis(audio, Math.floor(maxChars * 0.3)));
  else if (result.audioError && !result.audioMergedIntoAnalysis) lines.push(`Audio could not be analyzed: ${result.audioError}`);
  return lines.join("\n");
}

function renderLookup(result) {
  if (!result.ok && !result.items?.length) return renderError(result);
  const lines = (result.items ?? []).map((item) => {
    const meta = [item.roleLabel, item.postedAt, item.engagement].filter(Boolean).join(", ");
    const text = String(item.text || item.postText || item.snippet || "").replace(/\s+/g, " ").trim().slice(0, 400);
    return `- ${item.id}: ${item.citeAs}${meta ? ` (${meta})` : ""}${text ? `: ${text}` : ""}${item.url ? ` ${item.url}` : ""}`;
  });
  if (result.missing?.length) lines.push(`Not found: ${result.missing.join(", ")}`);
  return lines.join("\n");
}

function renderFetch(result) {
  const lines = [];
  for (const post of result.posts ?? []) {
    const text = String(post.text || "").replace(/\s+/g, " ").slice(0, 120);
    lines.push(`- ${post.id}: @${post.authorHandle || "unknown"}${post.role ? ` (${post.role.replace(/_/g, " ")})` : ""}: ${text}`);
  }
  for (const link of result.links ?? []) {
    lines.push(`- ${link.id}: ${String(link.title || "").slice(0, 100)} (${getHostname(link.url) || link.url})`);
  }
  for (const media of result.media ?? []) {
    lines.push(`- ${media.id}: ${describeMediaTarget(media, media.mediaType)}`);
  }
  if (!lines.length) lines.push(result.note || "No items available.");
  return lines.join("\n");
}

function compactJson(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (item === "" || item === null || (Array.isArray(item) && !item.length)) return undefined;
      return item;
    });
  } catch {
    return String(value);
  }
}
