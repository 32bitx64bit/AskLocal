import { api } from "../api.js";
import {
  getHostname,
  isAllowedHttpUrl,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  arrayBufferToBase64,
  uniqueBy
} from "../../lib/utils.js";

export const FAVICON_CACHE = new Map();
export async function buildResponseSources(context) {
  const sources = [];

  const addSource = (source) => {
    if (!source?.url || !isAllowedHttpUrl(source.url)) return;
    const url = source.url;
    sources.push({
      url,
      title: String(source.title || source.label || getHostname(url) || "Source").trim().slice(0, 160),
      host: getHostname(url),
      kind: source.kind || "web",
      source: source.source || ""
    });
  };

  (context.webReads ?? []).forEach((read) => {
    addSource({
      url: read.page?.url || read.target?.url,
      title: read.page?.title || read.target?.title || read.page?.description,
      kind: "page",
      source: read.page?.source || read.tool
    });
  });

  (context.deepThreads ?? []).forEach((read) => {
    addSource({
      url: read.target?.url || read.thread?.root?.url,
      title: read.thread?.root?.text || read.target?.authorHandle || "X post",
      kind: "x_post",
      source: read.tool
    });
  });

  if (context.xPostContext?.ok) {
    [context.xPostContext.root, context.xPostContext.quoted]
      .filter(Boolean)
      .forEach((post) => {
        addSource({
          url: post.url,
          title: post.text || post.authorHandle || "X post",
          kind: "x_post",
          source: context.xPostContext.source || "x_post_context"
        });
      });
  }

  (context.searchResults ?? []).forEach((read) => {
    (read.results ?? []).forEach((item) => {
      addSource({
        url: item.url,
        title: item.title || item.text || item.authorHandle,
        kind: item.type === "post" ? "x_post" : "search_result",
        source: read.tool || item.source
      });
    });

    (read.search?.searches ?? []).forEach((search) => {
      (search.results ?? []).forEach((item) => {
        addSource({
          url: item.url,
          title: item.title || item.snippet,
          kind: "search_result",
          source: search.source
        });
      });
      (search.posts ?? []).forEach((post) => {
        addSource({
          url: post.url,
          title: post.text || post.authorHandle,
          kind: "x_post",
          source: search.source
        });
      });
    });
  });

  const uniqueSources = uniqueBy(sources, (source) => normalizeSourceUrl(source.url)).slice(0, 8);
  return Promise.all(uniqueSources.map(attachSourceIcon));
}
export async function attachSourceIcon(source) {
  return {
    ...source,
    iconUrl: await resolveFaviconDataUrl(source.url)
  };
}
export async function resolveFaviconDataUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }

  const host = url.hostname.replace(/^www\./, "");
  if (!host) return "";
  if (FAVICON_CACHE.has(host)) return FAVICON_CACHE.get(host);

  const candidates = buildFaviconCandidates(url, host);
  for (const candidate of candidates) {
    const dataUrl = await fetchFaviconAsDataUrl(candidate);
    if (dataUrl) {
      FAVICON_CACHE.set(host, dataUrl);
      return dataUrl;
    }
  }

  FAVICON_CACHE.set(host, "");
  return "";
}
export function buildFaviconCandidates(url, host) {
  const origin = url.origin;
  return uniqueBy([
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `${origin}/favicon.ico`,
    `${origin}/favicon.png`,
    `${origin}/apple-touch-icon.png`,
    `${origin}/apple-touch-icon-precomposed.png`
  ], (candidate) => candidate);
}
export async function fetchFaviconAsDataUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8" },
      signal: controller.signal
    });
    if (!response.ok) return "";

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) return "";

    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > 150000) return "";

    return `data:${contentType || "image/x-icon"};base64,${arrayBufferToBase64(buffer)}`;
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

