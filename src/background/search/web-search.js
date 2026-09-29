import { api } from "../api.js";
import {
  SEARCH_CHALLENGE_WAIT_MS,
  SEARCH_TAB_TIMEOUT_MS
} from "../constants.js";
import {
  cleanSearchSnippet,
  decodeHtml,
  stripHtml
} from "../../lib/text.js";
import {
  cleanSearchResultUrl,
  isLikelySearchNoiseUrl,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  clampNumber,
  sleep,
  throwIfAborted,
  uniqueBy
} from "../../lib/utils.js";
import {
  DEFAULT_SETTINGS
} from "../settings.js";

export const SEARCH_ENGINE_REGISTRY = {
  brave: {
    label: "Brave",
    buildUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    originHosts: ["brave.com"],
    settleMs: 900,
    hints: { container: '.snippet[data-pos], .snippet[data-type="web"]', title: ".search-snippet-title, .title", snippet: ".snippet-description" }
  },
  duckduckgo: {
    label: "DuckDuckGo",
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    originHosts: ["duckduckgo.com"],
    settleMs: 600,
    hints: { container: ".result", title: ".result__a", snippet: ".result__snippet" }
  },
  startpage: {
    label: "Startpage",
    buildUrl: (query) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`,
    originHosts: ["startpage.com"],
    settleMs: 900,
    hints: { container: ".w-gl__result, .result", title: ".result-title, .result-link", snippet: ".w-gl__description, .text" }
  },
  google: {
    label: "Google",
    buildUrl: (query) => `https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`,
    originHosts: ["google.com", "googleapis.com", "gstatic.com"],
    settleMs: 1400,
    hints: { container: "div.g, div[data-sokoban-container] div", title: "h3", snippet: "span.aCOpRe, [style*='line-clamp']" }
  },
  bing: {
    label: "Bing",
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    originHosts: ["bing.com"],
    settleMs: 1400,
    hints: { container: ".b_algo", title: "h2 a", snippet: ".b_caption p, p" }
  }
};
export function resolveSearchEngineOrder(settings) {
  let list = Array.isArray(settings?.webSearchEngines) && settings.webSearchEngines.length
    ? settings.webSearchEngines.slice()
    : DEFAULT_SETTINGS.webSearchEngines.slice();
  list = list.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  const ordered = [];
  for (const entry of list) {
    if (!ordered.includes(entry)) ordered.push(entry);
  }
  return ordered.length ? ordered : DEFAULT_SETTINGS.webSearchEngines.slice();
}
export function resolveSearchEngine(key, settings) {
  const name = String(key || "").trim().toLowerCase();
  if (name === "custom") {
    const template = String(settings?.webSearchCustomTemplate || "").trim();
    if (!template.includes("{q}")) return null;
    let originHost = "";
    try {
      originHost = new URL(template.replace("{q}", "asklocal")).hostname;
    } catch {
      originHost = "";
    }
    return {
      label: "Custom",
      buildUrl: (query) => template.replace("{q}", encodeURIComponent(query)),
      originHosts: originHost ? [originHost] : [],
      settleMs: 1400,
      hints: null
    };
  }
  const engine = SEARCH_ENGINE_REGISTRY[name];
  return engine ? { ...engine } : null;
}
export async function waitForSearchTab(tabId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Search aborted.");
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("Search tab closed before results loaded.");
    if (tab.status === "complete") return tab;
    await sleep(150);
  }
  return api.tabs.get(tabId).catch(() => null);
}
export function canRenderSearchTabs() {
  return Boolean(api.scripting?.executeScript || api.tabs?.executeScript);
}

async function injectSerpExtractor(tabId, allFrames = false) {
  try {
    if (api.scripting?.executeScript) {
      await api.scripting.executeScript({ target: { tabId, allFrames }, files: ["serp-extractor.js"] });
      return;
    }
    await api.tabs.executeScript(tabId, { file: "serp-extractor.js", allFrames });
  } catch (error) {
    if (!allFrames) throw error;
    await injectSerpExtractor(tabId, false);
  }
}

async function callSerpExtractor(tabId, method, args = [], { allFrames = false } = {}) {
  await injectSerpExtractor(tabId, allFrames);
  try {
    if (api.scripting?.executeScript) {
      const injections = await api.scripting.executeScript({
        target: { tabId, allFrames },
        func: (methodName, methodArgs) => {
          try {
            const serp = globalThis.AskLocalSerp || self.AskLocalSerp;
            const fn = serp && serp[methodName];
            return fn ? fn(document, ...methodArgs) : null;
          } catch {
            return null;
          }
        },
        args: [method, args]
      });
      return (injections || []).map((entry) => entry?.result);
    }

    const payload = JSON.stringify({ method, args }).replace(/</g, "\\u003c");
    const frameResults = await api.tabs.executeScript(tabId, {
      allFrames,
      code: `(function(p){try{var api=(globalThis.AskLocalSerp||self.AskLocalSerp);var fn=api&&api[p.method];return JSON.stringify(fn?fn.apply(null,[document].concat(p.args)):null);}catch(e){return "null";}})(${payload});`
    });
    return (Array.isArray(frameResults) ? frameResults : [frameResults]).map((text) => {
      try {
        return JSON.parse(String(text));
      } catch {
        return null;
      }
    });
  } catch (error) {
    if (!allFrames) throw error;
    return callSerpExtractor(tabId, method, args, { allFrames: false });
  }
}

function mergeChallengeReports(reports) {
  const merged = {
    detected: false,
    kind: "",
    requiresHuman: false,
    clickable: false,
    autoSolving: false,
    clicked: false,
    label: ""
  };
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    if (report.detected) merged.detected = true;
    if (report.requiresHuman) merged.requiresHuman = true;
    if (report.clickable) merged.clickable = true;
    if (report.autoSolving) merged.autoSolving = true;
    if (report.clicked) merged.clicked = true;
    if (!merged.kind && report.kind) merged.kind = report.kind;
    if (!merged.label && report.label) merged.label = report.label;
  }
  return merged;
}

export async function inspectSearchChallengeOnTab(tabId) {
  try {
    return mergeChallengeReports(await callSerpExtractor(tabId, "inspectChallenge", [], { allFrames: true }));
  } catch {
    return mergeChallengeReports([]);
  }
}

export async function tryPassSearchChallengeOnTab(tabId) {
  try {
    return mergeChallengeReports(await callSerpExtractor(tabId, "tryPassChallenge", [], { allFrames: true }));
  } catch {
    return mergeChallengeReports([]);
  }
}

export async function runSerpExtractorOnTab(tabId, engine, url, maxResults) {
  const options = { origin: url, originHosts: engine.originHosts, hints: engine.hints, maxResults };
  const results = await callSerpExtractor(tabId, "extract", [options], { allFrames: false });
  const value = results.find((entry) => Array.isArray(entry));
  return Array.isArray(value) ? value : [];
}

function challengeFailureMessage(engine, challenge) {
  const label = engine.label || "Search";
  if (challenge?.requiresHuman) {
    return `${label} is blocked by a captcha that needs a person to solve it. Tell the user web search cannot continue until they complete that check, then retry. Do not retry the same query yourself.`;
  }
  return `${label} search failed: a bot check did not produce results. Tell the user the search engine blocked this request with a captcha/bot check. Do not retry the same query.`;
}

export async function runSerpTabSearch(engine, query, maxResults, signal, progress) {
  if (!canRenderSearchTabs()) {
    throw new Error("Scripting is unavailable; cannot render search results.");
  }
  const url = engine.buildUrl(query);
  let tabId = null;
  try {
    const tab = await api.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForSearchTab(tabId, SEARCH_TAB_TIMEOUT_MS, signal);
    if (engine.settleMs) await sleep(engine.settleMs);
    throwIfAborted(signal);

    let challenge = await tryPassSearchChallengeOnTab(tabId);
    if (!challenge.detected) {
      const results = await runSerpExtractorOnTab(tabId, engine, url, maxResults);
      if (results.length) return results;
      challenge = await tryPassSearchChallengeOnTab(tabId);
    }
    if (challenge.requiresHuman) {
      throw new Error(challengeFailureMessage(engine, challenge));
    }
    if (challenge.detected) {
      await progress?.(`Passing a bot check on ${engine.label}...`);
      const results = await waitForChallengeSearchResults(tabId, engine, url, maxResults, signal);
      if (results.length) return results;
      throw new Error(challengeFailureMessage(engine, challenge));
    }

    return await runSerpExtractorOnTab(tabId, engine, url, maxResults);
  } finally {
    if (tabId != null) api.tabs.remove(tabId).catch(() => {});
  }
}

async function waitForChallengeSearchResults(tabId, engine, url, maxResults, signal) {
  const deadline = Date.now() + SEARCH_CHALLENGE_WAIT_MS;
  let last = [];
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const remaining = Math.max(250, deadline - Date.now());
    await waitForSearchTab(tabId, remaining, signal);
    last = await runSerpExtractorOnTab(tabId, engine, url, maxResults);
    if (last.length) return last;
    const inspect = await inspectSearchChallengeOnTab(tabId);
    if (inspect.requiresHuman) throw new Error(challengeFailureMessage(engine, inspect));
    if (inspect.clickable || inspect.detected) await tryPassSearchChallengeOnTab(tabId);
    await sleep(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  return last.length ? last : runSerpExtractorOnTab(tabId, engine, url, maxResults);
}
export async function fetchEngineFallbackResults(key, query, maxResults) {
  // Server-rendered HTML fallback, used only when the render tier (scripting)
  // is unavailable. DuckDuckGo's html endpoint is the most reliable source.
  if (key === "duckduckgo") {
    const result = await fetchDuckDuckGoResults(query, maxResults);
    return result.ok ? result.results : [];
  }
  return [];
}
export async function collectWebSearchInBackground(query, maxResults, settings = {}, signal, progress) {
  const limit = clampNumber(maxResults, 1, 12, 6);
  const order = resolveSearchEngineOrder(settings);
  const canRender = canRenderSearchTabs();
  let lastError = "";
  let challengeBlocked = false;

  for (const key of order) {
    const engine = resolveSearchEngine(key, settings);
    if (!engine) continue;
    try {
      let results = [];
      if (canRender) {
        results = await runSerpTabSearch(engine, query, limit, signal, progress);
      }
      if (!results.length) {
        results = await fetchEngineFallbackResults(key, query, limit);
      }
      if (results.length) {
        return {
          ok: true,
          source: canRender ? `${key}_web_search` : `${key}_web_fetch`,
          query,
          url: engine.buildUrl(query),
          collectedAt: new Date().toISOString(),
          results,
          error: ""
        };
      }
    } catch (error) {
      lastError = error.message || `${engine.label || key} search failed.`;
      if (isSearchChallengeError(lastError)) challengeBlocked = true;
    }
  }

  return {
    ok: false,
    source: "web_search",
    query,
    url: "",
    collectedAt: new Date().toISOString(),
    results: [],
    challenge: challengeBlocked ? "unresolved" : undefined,
    error: lastError || "No web results were found."
  };
}

function isSearchChallengeError(message) {
  return /bot check|captcha/i.test(String(message || ""));
}
export async function fetchDuckDuckGoResults(query, maxResults) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error(`DuckDuckGo request failed: ${response.status}`);
    const html = await response.text();
    const results = parseDuckDuckGoResults(html, maxResults);
    return {
      ok: results.length > 0,
      source: "duckduckgo_web_search",
      query,
      url,
      collectedAt: new Date().toISOString(),
      results,
      error: results.length > 0 ? "" : "No readable DuckDuckGo results were found."
    };
  } catch (error) {
    return {
      ok: false,
      source: "duckduckgo_web_search",
      query,
      url,
      error: error.message,
      results: []
    };
  }
}
export function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) && results.length < maxResults) {
    const start = match.index;
    const nextStart = html.indexOf("result__body", start + 1);
    const block = html.slice(start, nextStart > start ? nextStart : Math.min(html.length, start + 2500));
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const url = cleanSearchResultUrl(decodeHtml(match[1]));
    const title = stripHtml(match[2]);
    const snippet = snippetMatch ? cleanSearchSnippet(stripHtml(snippetMatch[1])).slice(0, 520) : "";
    if (!/^https?:\/\//i.test(url) || !title) continue;
    if (isLikelySearchNoiseUrl(url)) continue;
    results.push({ title, url, snippet });
  }
  return uniqueBy(results, (result) => normalizeSourceUrl(result.url)).slice(0, maxResults);
}

