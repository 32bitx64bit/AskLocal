#!/usr/bin/env node
import * as acorn from "acorn";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FN = Object.create(null);
const set = (mod, names) => { for (const n of names) FN[n] = mod; };

set("lib/utils", [
  "clampNumber", "sleep", "stableHash", "uniqueBy", "cloneJson", "stableStringify",
  "normalizeSearchQuery", "throwIfAborted", "createProgressReporter", "capitalize",
  "formatSeconds", "formatCompactNumber", "trimTrailingZero", "arrayBufferToBase64",
  "promiseWithAbortAndTimeout", "normalizeUrlPathname", "normalizeModelText",
  "normalizeResponsesOutput"
]);
set("lib/url", [
  "normalizeSourceUrl", "isAllowedHttpUrl", "getHostname", "extractStatusIdFromUrl",
  "normalizePotentialHttpUrl", "normalizeTweetImageUrlForBackground",
  "isAllowedXStatusUrl", "cleanSearchResultUrl", "isLikelySearchNoiseUrl",
  "normalizeMediaUrl", "normalizeRawVideoUrls", "inferMediaTypeFromUrl",
  "isRawTweetVideoFileUrl"
]);
set("lib/text", [
  "stripHtml", "decodeHtml", "cleanReadableText", "normalizePlainText",
  "decodeCookieValue", "shortStatusText", "isReadableJunkLine", "htmlToReadableText",
  "removeJunkHtml", "cleanSearchSnippet", "expandXShortUrls"
]);
set("settings", [
  "getSettings", "saveSettings", "sanitizeSettings", "normalizeProvider",
  "normalizeWebSearchEngines", "normalizeProfile", "normalizeSearchSource",
  "migrateVideoSamplingDefaults", "isSettingsObject", "openOptionsPage"
]);
set("ask/pipeline", [
  "runAskPipeline", "askLocal", "cancelAsk", "clearMediaSession",
  "rememberClosedMediaSession", "handleMessage"
]);
set("ask/context", [
  "buildContext", "prepareAutomaticMediaContext", "prepareAutomaticLinkContext",
  "prepareXPostContext", "mergeXPostContextIntoAskContext", "mergeContextTweet",
  "getSelectedAutomaticMedia", "shouldAttachImagesToMainProvider", "attachAutomaticImages",
  "analyzeAutomaticImages", "analyzeAutomaticVideos", "normalizeConversationHistory",
  "normalizeContextTweets", "normalizeContextTweet", "normalizeSubtitleGroup",
  "normalizeMediaSubtitleGroups", "normalizeTweetMediaItem", "flattenContextPosts",
  "countVideoSubtitleGroups", "countMediaItems", "shouldUseVisibleThread"
]);
set("x/graphql-client", [
  "requestXGraphQL", "fetchXGraphQLFromBackground", "fetchXGraphQLFromSourceTab",
  "parseXGraphQLFetchResult", "formatXGraphQLRequestError", "getXGraphQLSession",
  "resolveXBearerToken", "resolveXGraphQLOperation", "fetchXClientScript",
  "extractXGraphQLOperation", "extractXStringBooleanMap"
]);
set("x/parse", [
  "collectTweetsFromTweetDetail", "collectTweetsFromXObject", "buildPostFromXSearchFallback",
  "extractXTimelineEntries", "extractXBottomCursor", "inferXEntrySourceRole",
  "collectXTweetResult", "unwrapXTweetResult", "normalizeXTweetResult",
  "extractXTweetUser", "extractXTweetLinks", "extractXTweetCard", "extractXTweetMedia",
  "normalizeXMediaEntity", "compareTweetsByContextValue", "formatCompiledTweet",
  "formatCompiledSubtitles", "formatXEngagement", "parseXCreatedAt",
  "buildTweetDetailVariables"
]);
set("x/collect", [
  "collectXPostContextInBackground", "collectThreadInBackground",
  "collectProfileInBackground", "cacheProfileContext"
]);
set("providers/index", ["callProvider"]);
set("providers/openai-compatible", [
  "callOpenAICompatible", "resolveOpenAICompatibleEndpoint", "buildOpenAICompatibleMessages",
  "buildOpenAICompatibleRequest", "readOpenAICompatibleStream", "buildOpenAICompatibleTools",
  "prepareToolDiagnostics", "recordToolResponseDiagnostics", "extractOpenAICompatibleAnswer",
  "normalizeOpenAIToolCalls", "normalizeContentToolCalls", "parseContentToolCallCandidate",
  "normalizeContentToolCallValue", "normalizeToolCall", "normalizeAssistantToolMessage",
  "callOpenAICompatibleMediaAnalysis", "iterateStreamLines"
]);
set("providers/errors", [
  "parseProviderResponse", "isHtmlErrorText", "summarizeProviderErrorBody",
  "describeProviderError", "isTransientProviderStatus", "fetchWithTransientRetry",
  "extractProviderError", "isContextSizeError", "describeContextSizeError",
  "isTrivialFinalAnswer", "isStreamSupportError", "isToolSupportError",
  "isModelOutputFormatError",
  "isToolChoiceSupportError", "fetchWithTimeout"
]);
set("tools/registry", [
  "executeOpenAIToolCall", "buildToolResultCacheKey", "normalizeToolCacheArgs",
  "parseToolArguments", "formatToolPlanStatus", "formatToolStartStatus",
  "formatToolResultStatus", "formatToolName", "buildAvailableTools", "isSearchToolEnabled"
]);
set("tools/fetch-get", [
  "fetchTool", "getTool", "readThreadTool", "findExistingThreadRead", "findExistingWebRead",
  "normalizeFetchKind"
]);
set("tools/search", ["xSearchTool", "webSearchTool", "searchContextTool"]);
set("tools/inspectables", [
  "assignItemAlias", "lookupItemAlias", "aliasPostItem", "aliasLinkItem", "aliasMediaItem",
  "buildInspectableItems", "buildInspectablePostItem", "buildInspectableLinkItem",
  "buildInspectableMediaItems", "normalizeMediaItemForInspection", "normalizeMediaType",
  "filterInspectableItems", "editDistance", "findClosestPostIds", "compactPostRef",
  "compactLinkRef", "compactMediaRef", "resolveInspectableTarget", "resolveInspectableMediaTarget",
  "summarizeMediaTarget", "threadTargetFromInspectableItem", "buildContextSearchQuery"
]);
set("search/x-search", ["collectSearchContextInBackground", "collectXSearchInBackground"]);
set("search/web-search", [
  "resolveSearchEngineOrder", "resolveSearchEngine", "waitForSearchTab",
  "canRenderSearchTabs", "runSerpExtractorOnTab", "runSerpTabSearch",
  "inspectSearchChallengeOnTab", "tryPassSearchChallengeOnTab",
  "fetchEngineFallbackResults", "collectWebSearchInBackground",
  "fetchDuckDuckGoResults", "parseDuckDuckGoResults"
]);
set("web/readable", [
  "collectWebPageInBackground", "fetchReadableUrl", "extractReadableHtml",
  "selectReadableHtmlCandidate", "scoreReadableText", "extractReadableLinks"
]);
set("media/cache", [
  "findExistingMediaAnalysis", "mediaTargetsMatch", "buildMediaIdentityValues",
  "buildImageDataCacheKey", "buildMediaAnalysisCacheKey", "mediaCacheFingerprint",
  "ensureMediaAnalysisCacheHydrated", "persistMediaAnalysisCache", "readCachedMediaAnalysis",
  "writeCachedMediaAnalysis", "rememberLimitedCache", "trackMediaCacheKey", "forgetMediaCacheKey"
]);
set("media/image", [
  "analyzeImageTool", "loadImageForAnalysis", "fetchMediaImageAsDataUrl",
  "normalizeAnalysisImage", "extractDataUrlMimeType", "buildImageAnalysisPrompt",
  "formatAnalysisImageLabel", "formatInlineImageLabel", "resolveMediaProviderSettings",
  "describeMediaProvider", "callMediaAnalysisProvider"
]);
set("media/video", [
  "analyzeVideoTool", "runVideoAnalysis", "groupVideoFramesIntoChunks",
  "buildVideoFrameCacheKey", "collectVideoAnalysisFramesOnce", "collectVideoAnalysisFrames",
  "resolveRawVideoUrlsForTarget", "getTargetRawVideoUrls", "addTweetVideoCandidate",
  "selectTweetVideoCandidatesForTarget", "fetchTweetVideoUrlCandidates",
  "extractTweetVideoUrlCandidates", "isLikelyTweetMediaId",
  "scoreTweetVideoCandidate", "scoreRawTweetVideoUrl", "bitrateFromTweetVideoUrl",
  "widthFromTweetVideoUrl", "heightFromTweetVideoUrl", "extractTweetVideoMediaId",
  "captureVideoFromDirectUrl", "ensureVideoCaptureOffscreenDocument",
  "hasVideoCaptureOffscreenDocument", "sendOffscreenVideoCaptureMessage",
  "handleVideoCaptureProgress", "createVideoCaptureId", "collectSourceTabMediaCapture",
  "buildVideoAnalysisPrompt", "flattenSubtitleGroups", "formatFrameList",
  "trimStitchedAnalysis", "normalizePlayableTweetVideoUrl"
]);
set("prompt/build", [
  "buildSystemPrompt", "formatCurrentDateTime", "normalizePromptPreset",
  "inferPromptPresetFromQuestion", "estimatePromptTokens", "buildPrompt",
  "buildPromptAtLevel", "compileContextPosts", "describeAvailableToolsForPrompt",
  "briefPostReminder", "trimContext", "compactWebRead", "compactMediaAnalysis",
  "compactMediaTargetRef", "compactProfile", "pruneEmptyValues", "summarizeContext"
]);
set("response/sources", [
  "buildResponseSources", "attachSourceIcon", "resolveFaviconDataUrl",
  "buildFaviconCandidates", "fetchFaviconAsDataUrl"
]);
set("test-provider", [
  "testProvider", "testOpenAICompatibleProvider"
]);

function constModule(name) {
  if (/^(FETCH_TOOL|GET_TOOL|ANALYZE_IMAGE_TOOL|ANALYZE_VIDEO_TOOL|X_SEARCH_TOOL|WEB_SEARCH_TOOL)$/.test(name)) {
    return "tools/schemas";
  }
  if (/^(MEDIA_ANALYSIS_CACHE|MEDIA_IMAGE_CACHE|MEDIA_FRAME_CACHE|MEDIA_SESSION_KEYS|CLOSED_MEDIA_SESSIONS|VIDEO_CAPTURE_PROGRESS_HANDLERS|mediaAnalysisCacheHydration)$/.test(name)) {
    return "media/cache";
  }
  if (name === "videoCaptureOffscreenPromise") return "media/video";
  if (/^(X_CLIENT_SCRIPT_CACHE|X_OPERATION_CACHE)$/.test(name)) return "x/graphql-client";
  if (name === "ACTIVE_ASKS") return "ask/pipeline";
  if (name === "FAVICON_CACHE") return "response/sources";
  if (name === "SEARCH_ENGINE_REGISTRY") return "search/web-search";
  if (name === "CONTEXT_TRIM_LEVELS") return "prompt/build";
  if (name === "DEFAULT_SETTINGS") return "settings";
  if (name === "api") return null; // skipped
  return "constants";
}

function moduleFor(name, kind) {
  if (kind === "function") return FN[name] || "index";
  if (kind === "var") return constModule(name);
  return "index";
}

function importPath(fromMod, toMod) {
  if (fromMod.startsWith("lib/") && toMod.startsWith("lib/")) {
    return `./${toMod.slice("lib/".length)}.js`;
  }
  if (toMod.startsWith("lib/")) {
    const fromDepth = fromMod.split("/").length - 1;
    const prefix = Array(fromDepth + 1).fill("..").join("/");
    return `${prefix}/${toMod}.js`;
  }
  if (fromMod.startsWith("lib/")) {
    const fromDepth = fromMod.split("/").length - 1;
    const prefix = Array(fromDepth + 1).fill("..").join("/");
    return `${prefix}/background/${toMod}.js`;
  }
  const fromDepth = fromMod.split("/").length - 1;
  const prefix = fromDepth === 0 ? "." : Array(fromDepth).fill("..").join("/");
  return `${prefix}/${toMod}.js`;
}

function collectIdents(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "Identifier") out.add(node.name);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) val.forEach((v) => collectIdents(v, out));
    else if (val && typeof val === "object" && val.type) collectIdents(val, out);
  }
  return out;
}

function main() {
  let source = readFileSync(join(ROOT, "src/background.js"), "utf8");
  source = source
    .replaceAll('api.runtime.getURL("src/options.html")', 'api.runtime.getURL("options.html")')
    .replaceAll('api.runtime.getURL("src/video-capture.html")', 'api.runtime.getURL("video-capture.html")')
    .replaceAll('url: "src/video-capture.html"', 'url: "video-capture.html"')
    .replaceAll('files: ["src/serp-extractor.js"]', 'files: ["serp-extractor.js"]')
    .replaceAll('{ file: "src/serp-extractor.js" }', '{ file: "serp-extractor.js" }');

  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
    allowReturnOutsideFunction: true
  });

  const decls = [];
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration") {
      decls.push({
        kind: "function",
        name: node.id.name,
        start: node.start,
        end: node.end,
        node
      });
    } else if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") continue;
        if (d.id.name === "api") continue;
        decls.push({
          kind: "var",
          name: d.id.name,
          // Keep the full VariableDeclaration statement for this one declarator if single
          start: node.declarations.length === 1 ? node.start : d.start,
          end: node.declarations.length === 1 ? node.end : d.end,
          node: node.declarations.length === 1 ? node : d,
          varKind: node.kind,
          fullNode: node,
          declarator: d
        });
      }
    } else {
      decls.push({
        kind: "stmt",
        name: `__stmt_${node.start}`,
        start: node.start,
        end: node.end,
        node
      });
    }
  }

  // For multi-declarator VariableDeclarations we need to emit per-name; acorn has one node.
  // Rebuild var decls carefully: one output per VariableDeclaration if all go to same module,
  // else split textually.
  const modules = new Map();
  const push = (mod, item) => {
    if (!modules.has(mod)) modules.set(mod, []);
    modules.get(mod).push(item);
  };

  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration") {
      push(moduleFor(node.id.name, "function"), {
        kind: "function",
        name: node.id.name,
        text: source.slice(node.start, node.end),
        node
      });
    } else if (node.type === "VariableDeclaration") {
      // Group declarators by target module
      const groups = new Map();
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier" || d.id.name === "api") continue;
        const mod = moduleFor(d.id.name, "var");
        if (!mod) continue;
        if (!groups.has(mod)) groups.set(mod, []);
        groups.get(mod).push(d);
      }
      for (const [mod, declarators] of groups) {
        if (declarators.length === node.declarations.length) {
          push(mod, {
            kind: "var",
            name: declarators.map((d) => d.id.name).join(","),
            names: declarators.map((d) => d.id.name),
            text: source.slice(node.start, node.end),
            node
          });
        } else {
          for (const d of declarators) {
            const init = d.init ? ` = ${source.slice(d.init.start, d.init.end)}` : "";
            push(mod, {
              kind: "var",
              name: d.id.name,
              names: [d.id.name],
              text: `${node.kind} ${d.id.name}${init};`,
              node: d
            });
          }
        }
      }
    } else {
      push("index", {
        kind: "stmt",
        name: `__stmt_${node.start}`,
        text: source.slice(node.start, node.end),
        node
      });
    }
  }

  const nameToMod = new Map();
  for (const [mod, list] of modules) {
    for (const item of list) {
      if (item.kind === "function") nameToMod.set(item.name, mod);
      else if (item.kind === "var") for (const n of item.names) nameToMod.set(n, mod);
    }
  }

  const unassigned = [...nameToMod.entries()].filter(([n, m]) => m === "index" && FN[n] === undefined && /^[a-z]/.test(n));
  const fnUnassigned = Object.keys(FN).length;
  const missing = [...modules.get("index") || []].filter((i) => i.kind === "function").map((i) => i.name);
  if (missing.length) console.warn("Functions falling through to index:", missing.join(", "));

  const bgRoot = join(ROOT, "src/background");
  rmSync(bgRoot, { recursive: true, force: true });
  rmSync(join(ROOT, "src/lib"), { recursive: true, force: true });
  mkdirSync(bgRoot, { recursive: true });
  mkdirSync(join(ROOT, "src/lib"), { recursive: true });
  writeFileSync(join(bgRoot, "api.js"), "export const api = globalThis.browser ?? globalThis.chrome;\n");

  const allExportNames = [...nameToMod.keys()];

  for (const [mod, list] of modules) {
    const parts = [];
    for (const item of list) {
      if (item.kind === "stmt") parts.push(item.text);
      else if (item.kind === "function") parts.push(item.text.replace(/^async\s+function|^function/, (m) => `export ${m}`));
      else if (item.kind === "var") parts.push(item.text.replace(/^(const|let|var)\b/, "export $1"));
    }
    const bodyText = parts.join("\n\n");
    const defined = new Set();
    for (const item of list) {
      if (item.kind === "function") defined.add(item.name);
      if (item.kind === "var") item.names.forEach((n) => defined.add(n));
    }

    // Use AST idents from each item's node for more accuracy, unioned
    const used = new Set();
    for (const item of list) collectIdents(item.node, used);

    // Also scan body text for export names (covers nested refs acorn collects anyway)
    for (const name of allExportNames) {
      if (defined.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(bodyText)) used.add(name);
    }

    const importsByMod = new Map();
    for (const name of used) {
      if (defined.has(name)) continue;
      const from = nameToMod.get(name);
      if (!from || from === mod) continue;
      // Keep lib/* free of background imports (move callers instead).
      if (mod.startsWith("lib/") && !from.startsWith("lib/")) {
        console.warn(`Skipping lib←background import: ${mod} wants ${name} from ${from}`);
        continue;
      }
      if (!importsByMod.has(from)) importsByMod.set(from, new Set());
      importsByMod.get(from).add(name);
    }

    const isLib = mod.startsWith("lib/");
    const importLines = [];
    if (!isLib) importLines.push(`import { api } from "${importPath(mod, "api")}";`);

    for (const [from, syms] of [...importsByMod.entries()].sort()) {
      const rel = importPath(mod, from);
      const names = [...syms].sort();
      for (let i = 0; i < names.length; i += 40) {
        importLines.push(`import {\n  ${names.slice(i, i + 40).join(",\n  ")}\n} from "${rel}";`);
      }
    }

    const outPath = isLib ? join(ROOT, "src", `${mod}.js`) : join(bgRoot, `${mod}.js`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${[...importLines, "", ...parts, ""].join("\n")}\n`);
    console.log("Wrote", isLib ? mod : `background/${mod}`, `(${list.length} items)`);
  }

  console.log("Done. Module count:", modules.size);
}

main();
