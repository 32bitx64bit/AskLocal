import { api } from "../api.js";
import {
  cleanReadableText,
  cleanSearchSnippet,
  decodeHtml,
  htmlToReadableText,
  removeJunkHtml,
  stripHtml
} from "../../lib/text.js";
import {
  isAllowedHttpUrl,
  isLikelySearchNoiseUrl,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  cloneJson,
  uniqueBy
} from "../../lib/utils.js";

/** Recent page reads, so follow-ups and repeated gets skip the network. */
const PAGE_CACHE = new Map();
const PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_CACHE_LIMIT = 30;

export async function collectWebPageInBackground(url, maxChars) {
  const cacheKey = `${maxChars}:${url}`;
  const cached = PAGE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < PAGE_CACHE_TTL_MS) return cloneJson(cached.page);
  const page = await collectWebPageUncached(url, maxChars);
  if (page?.ok) {
    PAGE_CACHE.delete(cacheKey);
    PAGE_CACHE.set(cacheKey, { at: Date.now(), page: cloneJson(page) });
    while (PAGE_CACHE.size > PAGE_CACHE_LIMIT) PAGE_CACHE.delete(PAGE_CACHE.keys().next().value);
  }
  return page;
}

async function collectWebPageUncached(url, maxChars) {
  if (!isAllowedHttpUrl(url)) {
    return {
      ok: false,
      source: "web_page",
      url,
      error: "Only http(s) URLs can be opened.",
      text: "",
      links: []
    };
  }

  try {
    return await fetchReadableUrl(url, maxChars);
  } catch (error) {
    return {
      ok: false,
      source: "web_page",
      url,
      error: error.message || "Could not read page.",
      text: "",
      links: []
    };
  }
}
export async function fetchReadableUrl(url, maxChars) {
  try {
    const response = await fetch(url, {
      credentials: "omit",
      headers: {
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const readable = contentType.includes("html")
      ? extractReadableHtml(raw, url, maxChars)
      : {
        title: "",
        description: "",
        text: cleanReadableText(raw).slice(0, maxChars),
        links: []
      };
    return {
      ok: Boolean(readable.text),
      source: "direct_fetch",
      url,
      title: readable.title,
      description: readable.description,
      collectedAt: new Date().toISOString(),
      text: readable.text.slice(0, maxChars),
      links: readable.links,
      error: readable.text ? "" : "No readable response text was found."
    };
  } catch (error) {
    return {
      ok: false,
      source: "direct_fetch",
      url,
      error: error.message,
      text: "",
      links: []
    };
  }
}
export function extractReadableHtml(html, baseUrl, maxChars) {
  const raw = String(html || "");
  const title = stripHtml(
    raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || ""
  );
  const description = stripHtml(
    raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || raw.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || ""
  );
  const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw;
  const cleaned = removeJunkHtml(body);
  const selected = selectReadableHtmlCandidate(cleaned) || cleaned;
  const text = cleanReadableText(htmlToReadableText(selected)).slice(0, maxChars);
  const links = extractReadableLinks(selected, baseUrl);
  return { title, description, text, links };
}
export function selectReadableHtmlCandidate(html) {
  const candidates = [];
  for (const tag of ["article", "main"]) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    for (const match of String(html || "").matchAll(pattern)) {
      const candidate = match[0];
      const text = cleanReadableText(htmlToReadableText(candidate));
      if (text.length >= 400) candidates.push({ html: candidate, score: scoreReadableText(text) });
    }
  }

  for (const match of String(html || "").matchAll(/<([a-z0-9-]+)\b[^>]*role=["']main["'][^>]*>[\s\S]*?<\/\1>/gi)) {
    const candidate = match[0];
    const text = cleanReadableText(htmlToReadableText(candidate));
    if (text.length >= 400) candidates.push({ html: candidate, score: scoreReadableText(text) });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.html || "";
}
export function scoreReadableText(text) {
  const lines = String(text || "").split("\n").filter(Boolean);
  const paragraphCount = lines.filter((line) => line.length > 80).length;
  return text.length + paragraphCount * 200;
}
export function extractReadableLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url = "";
    try {
      url = new URL(decodeHtml(match[1]), baseUrl).href;
    } catch {
      continue;
    }
    if (!isAllowedHttpUrl(url) || isLikelySearchNoiseUrl(url)) continue;
    const title = cleanSearchSnippet(stripHtml(match[2])).slice(0, 180);
    if (!title || title.length < 3) continue;
    links.push({ title, url, snippet: "" });
    if (links.length >= 20) break;
  }
  return uniqueBy(links, (link) => normalizeSourceUrl(link.url));
}

