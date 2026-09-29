import { api } from "../api.js";
import {
  clampNumber,
  normalizeSearchQuery,
  uniqueBy
} from "../../lib/utils.js";
import {
  collectWebSearchInBackground
} from "../search/web-search.js";
import {
  normalizeSearchSource
} from "../settings.js";
import {
  requestXGraphQL
} from "../x/graphql-client.js";
import {
  buildPostFromXSearchFallback,
  collectTweetsFromXObject
} from "../x/parse.js";

export async function collectSearchContextInBackground(query, source, maxResults, context = {}, settings = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  const normalizedSource = normalizeSearchSource(source);
  const resultLimit = clampNumber(maxResults, 1, 12, 6);
  const searches = [];

  if (!normalizedQuery) {
    return {
      ok: false,
      query: "",
      source: normalizedSource,
      collectedAt: new Date().toISOString(),
      searches: [],
      error: "Search query was empty."
    };
  }

  if (normalizedSource === "x" || normalizedSource === "both") {
    searches.push(await collectXSearchInBackground(normalizedQuery, resultLimit, context, settings));
  }

  if (normalizedSource === "web" || normalizedSource === "both") {
    searches.push(await collectWebSearchInBackground(normalizedQuery, resultLimit, settings, context?.abortSignal, context?.reportProgress));
  }

  return {
    ok: searches.some((search) => search.ok),
    query: normalizedQuery,
    source: normalizedSource,
    collectedAt: new Date().toISOString(),
    searches
  };
}
export async function collectXSearchInBackground(query, maxResults, context = {}, settings = {}) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  const limit = clampNumber(maxResults, 1, 12, 6);
  let graphError = "";

  try {
    const data = await requestXGraphQL(context, "SearchTimeline", {
      rawQuery: query,
      count: limit,
      querySource: "typed_query",
      product: "Latest"
    });
    const posts = uniqueBy(collectTweetsFromXObject(data, { sourceRole: "x_search_result" }), (tweet) => tweet.statusId || tweet.contextId)
      .slice(0, limit)
      .map((tweet, index) => ({
        ...tweet,
        searchRole: "x_search_result",
        sequenceIndex: index
      }));
    if (posts.length) {
      return {
        ok: true,
        source: "x_graphql_search",
        query,
        url,
        collectedAt: new Date().toISOString(),
        posts,
        error: ""
      };
    }
    graphError = "X GraphQL search returned no readable posts.";
  } catch (error) {
    graphError = error.message || "X GraphQL search failed.";
  }

  const fallback = await collectWebSearchInBackground(`${query} site:x.com`, limit, settings, context?.abortSignal, context?.reportProgress);
  const posts = (fallback.results ?? [])
    .map((result, index) => buildPostFromXSearchFallback(result, index))
    .filter(Boolean)
    .slice(0, limit);

  return {
    ok: posts.length > 0,
    source: posts.length ? "x_search_web_fallback" : "x_search",
    query,
    url,
    collectedAt: new Date().toISOString(),
    posts,
    error: posts.length ? graphError : graphError || fallback.error || "No readable X search results were found."
  };
}

