#!/usr/bin/env node
/**
 * Split src/content.js into ESM modules under src/content/.
 * Assumes src/grok/* are already ESM.
 */
import * as acorn from "acorn";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FN = Object.create(null);
const set = (mod, names) => { for (const n of names) FN[n] = mod; };

set("runtime", [
  "sendMessage", "getRuntimeUrl", "isRuntimeAvailable", "isExtensionContextInvalidated",
  "handleContentScriptError", "deactivateContentScript", "safeSendResponse", "addTrackedListener",
  "refreshSettings"
]);
set("x-session", [
  "collectXSessionContext", "fetchXGraphQLForBackground", "isAllowedXGraphQLUrl",
  "normalizeXGraphQLHeaders", "readCookieValue", "collectXClientScriptUrls",
  "safePerformanceResourceNames", "scoreXClientScriptUrl"
]);
set("x-video-cache", [
  "handleXMediaSnifferMessage", "requestXMediaSnifferCache", "mergeXVideoCandidates",
  "getCachedTweetVideoUrls"
]);
set("tweet-mount", [
  "queryTweetArticles", "mountVisibleTweets", "cleanupMountedControls", "hasMountedControl",
  "removeMountedControls", "handleViewportChange", "alignAllMountedControls", "alignMountedControls",
  "findHeaderMountPoint", "shouldSkipArticle", "inferUnlabeledGrokControl", "getControlName",
  "findTopGrokControl", "createControlOffsetMountPoint", "alignContainerToControl",
  "createHeaderOverlayMountPoint", "createActionButton"
]);
set("panel-controller", [
  "openPanel", "setShellMode", "positionPanel", "expandedShellRect", "hideShell", "closeMenu",
  "reopenShell", "expandAskLocalPanel", "collapseShell", "handleNativeGrokLaunch",
  "destroyShell", "schedulePanelAlignment", "alignActivePanel", "fallbackRect", "clampPanelRect",
  "isXMediaViewerOpen", "isXMediaViewerElement", "releaseMediaSession", "isVisibleRect"
]);
set("shell-wiring", ["wireShell"]);
set("ask", [
  "askQuestion", "askOverPort", "cancelAskRequest", "handleAskLocalProgress", "createRequestId"
]);
set("chat-ui", [
  "scrollChatToBottomIfPinned", "appendStoppedNote", "normalizePromptPreset",
  "inferPromptPresetFromQuestion", "renderFollowupSuggestions", "buildFollowupSuggestions",
  "attachAssistantMessageActions", "renderContextPost", "formatContextTimestamp",
  "appendChatMessage", "setRequestStatus", "renderPendingStatus", "renderMessageSources",
  "normalizeMessageSources", "scrollChatToBottom", "resizeComposer", "normalizePanelText"
]);
set("markdown", [
  "renderMarkdownInto", "renderMarkdown", "getMarkdownListKind", "isHorizontalRuleLine",
  "isTableStart", "isTableRowLine", "isTableSeparatorRow", "splitTableRow",
  "parseTableAlignments", "createMarkdownTable", "createCodeBlock", "appendInlineMarkdown",
  "renderInlineToken", "createMarkdownAnchor"
]);
set("tweet-extract", [
  "extractTweet", "cleanFallbackTweetText", "extractPostedAt", "extractEngagement",
  "extractTweetTextLinks", "extractTweetCard", "findQuotedContainer", "findOwnedElement",
  "findOwnedElements", "findStatusLink", "collectVisibleThread", "shouldCollectVisibleThreadForArticle",
  "extractQuotedTweet", "extractTweetFromQuotedContainer", "waitForArticleContent"
]);
set("tweet-media", [
  "extractTweetMedia", "isLikelyTweetImage", "normalizeTweetImageUrl", "normalizeMediaUrlForContext",
  "findRawTweetVideoUrls", "getMatchingRawTweetVideoResourceUrls", "getRawTweetVideoResourceUrls",
  "isPlayableTweetVideoUrl", "extractTweetVideoMediaId", "scoreRawTweetVideoUrl",
  "scoreTweetVideoCandidate", "widthFromTweetVideoUrl", "heightFromTweetVideoUrl",
  "normalizeResourceVideoIdentity", "extractStatusIdFromUrl", "extractVideoSubtitles",
  "extractTextTrackSubtitles", "extractVisibleSubtitleOverlay", "isLikelyVideoControlText",
  "normalizeSubtitleText", "formatCueTime", "dedupeSubtitleGroups", "urlsMatch"
]);
set("context-collectors", [
  "collectThreadContext", "collectSearchContext", "collectSearchArticles", "collectThreadArticles",
  "cacheVisibleProfile", "collectProfileContext"
]);
set("media-capture", [
  "collectMediaCapture", "findVideoCaptureTarget", "captureVideoFrames",
  "buildForwardVideoFrameTimes", "waitForPlaybackTime", "resolveEffectiveFrameCount",
  "waitForVideoMetadata", "waitForMediaEvent", "drawVideoFrame", "fitFrameDimensions",
  "formatTimestamp", "clampNumeric"
]);
set("dom-utils", ["uniqueBy", "sleep", "stableHash"]);
set("index", ["main"]);

function moduleFor(name, kind) {
  if (kind === "function") return FN[name] || "index";
  if (kind === "var") {
    if (name === "state") return "state";
    if (name === "api") return null;
    return "constants";
  }
  return "index";
}

function importPath(fromMod, toMod) {
  return `./${toMod}.js`;
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
  let source = readFileSync(join(ROOT, "src/content.js"), "utf8");
  source = source
    .replace(/^const api = .*?;\n/m, "")
    .replaceAll('getRuntimeUrl("src/options.html")', 'getRuntimeUrl("options.html")');

  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
    allowReturnOutsideFunction: true
  });

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
            names: declarators.map((d) => d.id.name),
            text: source.slice(node.start, node.end),
            node
          });
        } else {
          for (const d of declarators) {
            const init = d.init ? ` = ${source.slice(d.init.start, d.init.end)}` : "";
            push(mod, {
              kind: "var",
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

  const missing = [...(modules.get("index") || [])].filter((i) => i.kind === "function" && i.name !== "main").map((i) => i.name);
  if (missing.length) console.warn("Unexpected functions → index:", missing.join(", "));

  const outRoot = join(ROOT, "src/content");
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, "api.js"), "export const api = globalThis.browser ?? globalThis.chrome;\n");

  const allExportNames = [...nameToMod.keys()];
  const GROK_NAMES = new Set([
    "AskLocalGrokStyles", "AskLocalGrokShell", "AskLocalGrokGeometry", "AskLocalGrokNative"
  ]);

  for (const [mod, list] of modules) {
    const parts = [];
    const fnParts = [];
    const otherParts = [];
    for (const item of list) {
      let text;
      if (item.kind === "stmt") text = item.text;
      else if (item.kind === "function") text = item.text.replace(/^async\s+function|^function/, (m) => `export ${m}`);
      else if (item.kind === "var") text = item.text.replace(/^(const|let|var)\b/, "export $1");
      if (item.kind === "function") fnParts.push(text);
      else otherParts.push(text);
    }
    // Functions first so `main()` call stmts can sit after the export.
    parts.push(...fnParts, ...otherParts);
    if (mod === "index" && fnParts.some((t) => /\bfunction main\b/.test(t)) && !otherParts.some((t) => /^\s*main\(\)\s*;?\s*$/m.test(t))) {
      parts.push("main();");
    }
    const bodyText = parts.join("\n\n");
    const defined = new Set();
    for (const item of list) {
      if (item.kind === "function") defined.add(item.name);
      if (item.kind === "var") item.names.forEach((n) => defined.add(n));
    }

    const used = new Set();
    for (const item of list) collectIdents(item.node, used);
    for (const name of allExportNames) {
      if (defined.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(bodyText)) used.add(name);
    }
    for (const g of GROK_NAMES) {
      if (new RegExp(`\\b${g}\\b`).test(bodyText)) used.add(g);
    }

    const importsByMod = new Map();
    const grokImports = new Map();
    for (const name of used) {
      if (defined.has(name)) continue;
      if (GROK_NAMES.has(name)) {
        const file =
          name === "AskLocalGrokStyles" ? "styles" :
          name === "AskLocalGrokShell" ? "shell" :
          name === "AskLocalGrokGeometry" ? "geometry" : "native-control";
        if (!grokImports.has(file)) grokImports.set(file, new Set());
        grokImports.get(file).add(name);
        continue;
      }
      const from = nameToMod.get(name);
      if (!from || from === mod) continue;
      if (!importsByMod.has(from)) importsByMod.set(from, new Set());
      importsByMod.get(from).add(name);
    }

    const importLines = [`import { api } from "${importPath(mod, "api")}";`];
    for (const [file, syms] of grokImports) {
      importLines.push(`import { ${[...syms].join(", ")} } from "../grok/${file}.js";`);
    }
    for (const [from, syms] of [...importsByMod.entries()].sort()) {
      const names = [...syms].sort();
      for (let i = 0; i < names.length; i += 40) {
        importLines.push(`import {\n  ${names.slice(i, i + 40).join(",\n  ")}\n} from "${importPath(mod, from)}";`);
      }
    }

    writeFileSync(join(outRoot, `${mod}.js`), `${[...importLines, "", ...parts, ""].join("\n")}\n`);
    console.log("Wrote content/" + mod, `(${list.length})`);
  }

  console.log("Done. Modules:", modules.size);
}

main();
