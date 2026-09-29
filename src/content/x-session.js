import { api } from "./api.js";
import {
  uniqueBy
} from "./dom-utils.js";
import {
  main
} from "./index.js";
import {
  normalizeMediaUrlForContext
} from "./tweet-media.js";

export function collectXSessionContext() {
  return {
    source: "x_page",
    url: location.href,
    ct0: readCookieValue("ct0"),
    scriptUrls: collectXClientScriptUrls()
  };
}
export async function fetchXGraphQLForBackground(payload = {}) {
  const url = normalizeMediaUrlForContext(payload.url);
  if (!isAllowedXGraphQLUrl(url)) {
    return { ok: false, status: 0, text: "", error: "Blocked non-X GraphQL request." };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      credentials: "include",
      signal: controller.signal,
      headers: normalizeXGraphQLHeaders(payload.headers)
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "",
      text: "",
      error: error?.name === "AbortError" ? "Timed out reading X GraphQL from the page." : error.message
    };
  } finally {
    window.clearTimeout(timeout);
  }
}
export function isAllowedXGraphQLUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://x.com" && url.pathname.startsWith("/i/api/graphql/");
  } catch {
    return false;
  }
}
export function normalizeXGraphQLHeaders(headers) {
  const allowed = new Set([
    "accept",
    "authorization",
    "x-csrf-token",
    "x-twitter-active-user",
    "x-twitter-client-language"
  ]);
  return Object.fromEntries(
    Object.entries(headers && typeof headers === "object" ? headers : {})
      .filter(([key, value]) => allowed.has(String(key).toLowerCase()) && value != null)
      .map(([key, value]) => [key, String(value)])
  );
}
export function readCookieValue(name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`))?.[1] ?? "";
}
export function collectXClientScriptUrls() {
  const urls = [
    ...[...document.scripts].map((script) => script.src),
    ...safePerformanceResourceNames()
  ]
    .filter((url) => /(?:^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/|^https:\/\/x\.com\/)/i.test(url))
    .filter((url) => /\.js(?:$|\?)/i.test(url));

  return uniqueBy(urls, (url) => url)
    .sort((left, right) => scoreXClientScriptUrl(right) - scoreXClientScriptUrl(left))
    .slice(0, 30);
}
export function safePerformanceResourceNames() {
  try {
    return performance.getEntriesByType("resource").map((entry) => entry.name);
  } catch {
    return [];
  }
}
export function scoreXClientScriptUrl(value) {
  const url = String(value || "");
  if (/\/main\.[^/]+\.js/i.test(url)) return 100;
  if (/\/vendor\.[^/]+\.js/i.test(url)) return 80;
  if (/\/i18n\//i.test(url)) return 10;
  return 40;
}

