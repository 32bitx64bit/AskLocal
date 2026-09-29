import { api } from "../api.js";
import {
  shortStatusText
} from "../../lib/text.js";
import {
  getHostname,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  cloneJson,
  normalizeSearchQuery,
  stableStringify,
  uniqueBy
} from "../../lib/utils.js";
import {
  analyzeImageTool
} from "../media/image.js";
import {
  analyzeVideoTool
} from "../media/video.js";
import {
  normalizeSearchSource
} from "../settings.js";
import {
  fetchTool,
  getTool,
  lookupTool,
  readThreadTool
} from "../tools/fetch-get.js";
import {
  searchContextTool,
  webSearchTool,
  xSearchTool
} from "../tools/search.js";

export async function executeOpenAIToolCall(toolCall, context, settings, parsedArgs) {
  const name = toolCall.function.name;
  const args = parsedArgs ?? parseToolArguments(toolCall.function.arguments);
  const cacheKey = buildToolResultCacheKey(name, args);
  if (cacheKey && context.toolResultCache?.has(cacheKey)) {
    // Resending the whole result would double its tokens; the first copy is already
    // in the conversation.
    const earlier = context.toolResultCache.get(cacheKey);
    return {
      ok: Boolean(earlier?.ok),
      tool: name,
      duplicate: true,
      cached: true,
      note: "Duplicate call: this exact call already ran earlier in this answer and its result is above. Use that result, try different arguments, or answer with what you have."
    };
  }

  let result;
  if (name === "fetch") result = await fetchTool(args, context);
  else if (name === "lookup") result = await lookupTool(args, context);
  else if (name === "get") result = await getTool(args, context, settings);
  else if (name === "analyze_image") result = await analyzeImageTool(args, context, settings);
  else if (name === "analyze_video") result = await analyzeVideoTool(args, context, settings);
  else if (name === "x_search") result = await xSearchTool(args, context, settings);
  else if (name === "web_search") result = await webSearchTool(args, context, settings);
  else if (name === "read_thread") result = await readThreadTool(args, context, settings);
  else if (name === "search_context") result = await searchContextTool(args, context, settings);
  else result = { ok: false, error: `Unsupported tool: ${name}` };

  if (cacheKey) context.toolResultCache?.set(cacheKey, cloneJson(result));
  return result;
}
export function buildToolResultCacheKey(name, args = {}) {
  if (!["get", "lookup", "read_thread", "analyze_video", "analyze_image", "x_search", "web_search"].includes(name)) return "";
  const normalized = normalizeToolCacheArgs(name, args);
  return `${name}:${stableStringify(normalized)}`;
}
export function normalizeToolCacheArgs(name, args = {}) {
  if (name === "lookup") {
    const ids = [
      ...(Array.isArray(args.ids) ? args.ids : []),
      args.id || args.context_id || args.contextId || ""
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return { ids: [...new Set(ids)].sort() };
  }
  if (name === "get" || name === "read_thread") {
    const ids = [
      ...(Array.isArray(args.ids) ? args.ids : []),
      args.id || args.context_id || args.contextId || ""
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const urls = [
      ...(Array.isArray(args.urls) ? args.urls : []),
      args.url || ""
    ].map((value) => normalizeSourceUrl(value)).filter(Boolean);
    return {
      ids: [...new Set(ids)].sort(),
      urls: [...new Set(urls)].sort(),
      statusId: args.status_id || args.statusId || "",
      maxPosts: args.max_posts || args.maxPosts || ""
    };
  }
  if (name === "analyze_video" || name === "analyze_image") {
    return {
      id: args.id || args.media_id || args.mediaId || args.context_id || args.contextId || "",
      url: normalizeSourceUrl(args.url || ""),
      maxFrames: args.max_frames || args.maxFrames || "",
      frameIntervalSeconds: args.frame_interval_seconds || args.frameIntervalSeconds || "",
      framesPerMinute: args.frames_per_minute || args.framesPerMinute || ""
    };
  }
  if (name === "x_search" || name === "web_search") {
    return {
      query: normalizeSearchQuery(args.query || ""),
      maxResults: args.max_results || args.maxResults || ""
    };
  }
  return args;
}
export function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
export function formatToolPlanStatus(toolCalls) {
  const names = uniqueBy(toolCalls.map((toolCall) => toolCall.function.name), (name) => name)
    .map(formatToolName);
  if (names.length === 0) return "Model requested tools...";
  return `Model requested ${names.join(", ")}...`;
}
export function formatToolStartStatus(name, args = {}) {
  if (name === "web_search") {
    return `Searching the web for "${shortStatusText(args.query || "current information")}"...`;
  }
  if (name === "x_search") {
    return `Searching X for "${shortStatusText(args.query || "related posts")}"...`;
  }
  if (name === "fetch") {
    return "Reviewing available posts and links...";
  }
  if (name === "lookup") {
    const ids = [
      ...(Array.isArray(args.ids) ? args.ids : []),
      args.id || ""
    ].filter(Boolean).slice(0, 4);
    return ids.length
      ? `Looking up ${shortStatusText(ids.join(", "))}...`
      : "Looking up selected sources...";
  }
  if (name === "get") {
    const ids = [
      ...(Array.isArray(args.ids) ? args.ids : []),
      args.id || args.context_id || ""
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const urls = [
      ...(Array.isArray(args.urls) ? args.urls : []),
      args.url || ""
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const labels = [...ids, ...urls.map((url) => getHostname(url) || url)];
    const count = Math.max(labels.length, 1);
    if (count > 1 || (Array.isArray(args.ids) && args.ids.length) || (Array.isArray(args.urls) && args.urls.length)) {
      return `Opening ${count} sources (${shortStatusText(labels.slice(0, 4).join(", "))})...`;
    }
    const target = args.url ? getHostname(args.url) : args.id || args.context_id || args.status_id || "selected source";
    return `Opening ${shortStatusText(target)}...`;
  }
  if (name === "analyze_image") {
    const target = args.url ? getHostname(args.url) : args.id || args.context_id || "selected image";
    return `Analyzing image ${shortStatusText(target)}...`;
  }
  if (name === "analyze_video") {
    const target = args.url ? getHostname(args.url) : args.id || args.context_id || "selected video";
    return `Analyzing video ${shortStatusText(target)}...`;
  }
  return `Running ${formatToolName(name)}...`;
}
export function formatToolResultStatus(name, result = {}) {
  if (result.duplicate) return `Skipped a repeated ${formatToolName(name)} call.`;
  if (!result.ok) {
    if (name === "web_search" && (result.challenge || /bot check|captcha/i.test(result.error || ""))) {
      return "Web search was blocked by a bot check.";
    }
    return `${formatToolName(name)} did not return enough information.`;
  }
  if (name === "web_search") return `Found ${(result.results ?? []).length} web result${(result.results ?? []).length === 1 ? "" : "s"}.`;
  if (name === "x_search") return `Found ${(result.results ?? []).length} X post${(result.results ?? []).length === 1 ? "" : "s"}.`;
  if (name === "fetch") {
    const count = (result.posts ?? []).length + (result.links ?? []).length + (result.media ?? []).length;
    return `Found ${count} inspectable item${count === 1 ? "" : "s"}.`;
  }
  if (name === "lookup") {
    const count = result.counts?.resolved ?? (result.items ?? []).length;
    return `Resolved ${count} source${count === 1 ? "" : "s"} for citation.`;
  }
  if (name === "get") {
    if (result.batch) {
      const opened = Number(result.opened || 0);
      return `Opened ${opened} source${opened === 1 ? "" : "s"}.`;
    }
    return result.type === "post" ? "Read the selected post/thread." : "Read the selected page.";
  }
  if (name === "analyze_image") return "Image analysis finished.";
  if (name === "analyze_video") return "Video analysis finished.";
  return `${formatToolName(name)} finished.`;
}
export function formatToolName(name) {
  if (name === "web_search") return "web search";
  if (name === "x_search") return "X search";
  if (name === "fetch") return "source list";
  if (name === "lookup") return "source lookup";
  if (name === "get") return "source reader";
  if (name === "analyze_image") return "image analysis";
  if (name === "analyze_video") return "video analysis";
  return String(name || "tool").replace(/_/g, " ");
}
export function isSearchToolEnabled(settings, source) {
  if (!settings.allowBackgroundSearch) return false;
  const allowedSource = normalizeSearchSource(settings.backgroundSearchSource);
  return allowedSource === source || allowedSource === "both";
}

