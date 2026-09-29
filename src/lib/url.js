import {
  uniqueBy
} from "./utils.js";

export function normalizeTweetImageUrlForBackground(value) {
  const url = normalizePotentialHttpUrl(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("twimg.com")) {
      if (!parsed.searchParams.has("name")) parsed.searchParams.set("name", "large");
      if (parsed.searchParams.get("name") === "small") parsed.searchParams.set("name", "large");
    }
    return parsed.href;
  } catch {
    return url;
  }
}
export function normalizePotentialHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
export function isRawTweetVideoFileUrl(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname;
    return /(^|\.)video\.twimg\.com$/i.test(url.hostname)
      && /\.(mp4|m4v|webm)$/i.test(pathname)
      && !/\/aud\//i.test(pathname)
      && !/\/vid\/[^/]+\/0\/0\//i.test(pathname);
  } catch {
    return false;
  }
}
export function isRawTweetAudioFileUrl(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname;
    return /(^|\.)video\.twimg\.com$/i.test(url.hostname)
      && /\/aud\//i.test(pathname)
      && /\.(mp4|m4a|m4v|aac|mp3|webm)$/i.test(pathname);
  } catch {
    return false;
  }
}
export function normalizeMediaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("blob:")) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (!isAllowedHttpUrl(raw)) return "";
  return raw;
}
export function normalizeRawVideoUrls(value) {
  const list = Array.isArray(value) ? value : [value];
  return uniqueBy(
    list
      .map(normalizeMediaUrl)
      .filter(isRawTweetVideoFileUrl),
    (url) => normalizeSourceUrl(url)
  );
}
export function normalizeRawAudioUrls(value) {
  const list = Array.isArray(value) ? value : [value];
  return uniqueBy(
    list
      .map(normalizeMediaUrl)
      .filter(isRawTweetAudioFileUrl),
    (url) => normalizeSourceUrl(url)
  );
}
export function inferMediaTypeFromUrl(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(pathname) || url.hostname.includes("pbs.twimg.com")) return "image";
    if (/\.(mp4|m4v|webm|mov)(?:$|\?)/i.test(pathname)) return "video";
  } catch {
    // Keep inference best-effort.
  }
  return "";
}
export function cleanSearchResultUrl(value) {
  try {
    const url = new URL(value);
    const redirected = url.searchParams.get("uddg")
      || url.searchParams.get("q")
      || url.searchParams.get("url");
    if (redirected && /^https?:\/\//i.test(redirected)) return redirected;
    return url.href;
  } catch {
    return value;
  }
}
export function isLikelySearchNoiseUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (/^(bing|google|duckduckgo|yahoo)\./i.test(host)) return true;
    if (/\/(?:search|images|videos|maps)(?:$|[/?#])/i.test(url.pathname) && /[?&](?:q|query|p)=/i.test(url.search)) return true;
    if (/\/(?:preferences|settings|account|login|signin|signup)(?:$|[/?#])/i.test(url.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}
export function isAllowedXStatusUrl(value) {
  try {
    const url = new URL(value);
    const isXHost = /(^|\.)x\.com$/.test(url.hostname) || /(^|\.)twitter\.com$/.test(url.hostname);
    return isXHost && Boolean(extractStatusIdFromUrl(url.href));
  } catch {
    return false;
  }
}
export function isAllowedHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
export function getHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function normalizeSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return String(value || "");
  }
}
export function extractStatusIdFromUrl(value) {
  return String(value || "").match(/\/status\/(\d+)/)?.[1] ?? "";
}

