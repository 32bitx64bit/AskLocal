import { api } from "../api.js";
import {
  clampNumber,
  normalizeSearchQuery
} from "../../lib/utils.js";
import {
  collectWebSearchInBackground
} from "../search/web-search.js";
import {
  collectSearchContextInBackground,
  collectXSearchInBackground
} from "../search/x-search.js";
import {
  normalizeSearchSource
} from "../settings.js";
import {
  aliasLinkItem,
  aliasPostItem,
  buildContextSearchQuery,
  buildInspectableLinkItem,
  buildInspectablePostItem
} from "../tools/inspectables.js";
import {
  isSearchToolEnabled
} from "../tools/registry.js";

export async function xSearchTool(args, context, settings) {
  if (!isSearchToolEnabled(settings, "x")) {
    return { ok: false, tool: "x_search", error: "X search is disabled in AskLocal settings." };
  }

  const query = normalizeSearchQuery(args.query || buildContextSearchQuery(context.originalQuestion, context));
  if (!query) return { ok: false, tool: "x_search", error: "Search query was empty." };

  const maxResults = clampNumber(args.max_results ?? args.maxResults ?? settings.maxBackgroundSearchResults, 1, 12, 6);
  const search = await collectXSearchInBackground(query, maxResults, context, settings);
  const posts = (search.posts ?? [])
    .map((post, index) => aliasPostItem(context, buildInspectablePostItem(post, "x_search", index)))
    .filter(Boolean);
  const result = {
    ok: search.ok,
    tool: "x_search",
    query,
    source: "x_search",
    url: search.url,
    collectedAt: search.collectedAt,
    results: posts,
    error: search.error || "",
    next: "Open the relevant posts with get to read the full text and replies."
  };

  context.searchResults.push({
    ok: result.ok,
    tool: "x_search",
    search: {
      ok: search.ok,
      query,
      source: "x",
      collectedAt: search.collectedAt ?? new Date().toISOString(),
      searches: [search]
    },
    results: posts
  });
  return result;
}
export async function webSearchTool(args, context, settings) {
  if (!isSearchToolEnabled(settings, "web")) {
    return { ok: false, tool: "web_search", error: "Browser web search is disabled in AskLocal settings." };
  }

  const query = normalizeSearchQuery(args.query || buildContextSearchQuery(context.originalQuestion, context));
  if (!query) return { ok: false, tool: "web_search", error: "Search query was empty." };

  const maxResults = clampNumber(args.max_results ?? args.maxResults ?? settings.maxBackgroundSearchResults, 1, 12, 6);
  const search = await collectWebSearchInBackground(query, maxResults, settings, context?.abortSignal, context?.reportProgress);
  const links = (search.results ?? [])
    .map((link, index) => aliasLinkItem(context, buildInspectableLinkItem(link, search.source || "web_search", index)))
    .filter(Boolean);
  const challengeBlocked = Boolean(search.challenge) || /bot check|captcha/i.test(search.error || "");
  const result = {
    ok: search.ok,
    tool: "web_search",
    query,
    source: search.source || "web_search",
    url: search.url,
    title: search.title,
    collectedAt: search.collectedAt,
    results: links,
    error: search.error || "",
    challenge: search.challenge,
    next: challengeBlocked
      ? "Do not retry this query. Tell the user web search was blocked by a captcha/bot check."
      : "Open the relevant results with get before relying on them."
  };

  context.searchResults.push({
    ok: result.ok,
    tool: "web_search",
    search: {
      ok: search.ok,
      query,
      source: "web",
      collectedAt: search.collectedAt ?? new Date().toISOString(),
      searches: [search]
    },
    results: links
  });
  return result;
}
export async function searchContextTool(args, context, settings) {
  if (!settings.allowBackgroundSearch) {
    return { ok: false, error: "Background search is disabled in AskLocal settings." };
  }

  const query = normalizeSearchQuery(args.query || buildContextSearchQuery(context.originalQuestion, context));
  if (!query) return { ok: false, error: "Search query was empty." };

  const source = normalizeSearchSource(args.source || settings.backgroundSearchSource);
  const maxResults = clampNumber(args.max_results ?? args.maxResults ?? settings.maxBackgroundSearchResults, 1, 12, 6);
  const search = await collectSearchContextInBackground(query, source, maxResults, context, settings);
  const result = {
    ok: search.ok,
    tool: "search_context",
    search
  };
  context.searchResults.push(result);
  return result;
}

