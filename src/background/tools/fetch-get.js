import {
  DEFAULT_MULTI_LINKS,
  DONT_RETRY_HINT,
  MAX_MULTI_LINKS,
  MIN_MULTI_LINKS
} from "../constants.js";
import {
  extractStatusIdFromUrl,
  isAllowedHttpUrl,
  isAllowedXStatusUrl,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  clampNumber,
  cloneJson,
  normalizeSearchQuery
} from "../../lib/utils.js";
import {
  buildInspectableItems,
  compactLinkRef,
  compactPostRef,
  filterInspectableItems,
  findClosestPostIds,
  resolveInspectableTarget,
  resolveLookupItems,
  threadTargetFromInspectableItem
} from "../tools/inspectables.js";
import {
  collectWebPageInBackground
} from "../web/readable.js";
import {
  collectThreadInBackground
} from "../x/collect.js";

export async function lookupTool(args, context) {
  const ids = normalizeLookupIds(args);
  if (!ids.length) {
    return {
      ok: false,
      tool: "lookup",
      error: "Provide at least one short id via ids or id (for example [\"p3\", \"p9\"]).",
      next: "Copy ids exactly from the context or search results."
    };
  }

  const { items, missing } = resolveLookupItems(ids, context);
  return {
    ok: items.length > 0,
    tool: "lookup",
    counts: { resolved: items.length, missing: missing.length },
    items,
    missing,
    next: items.length
      ? "Refer to items by citeAs in the answer, never by id. Open posts or pages with get when you need the full text."
      : "No ids resolved. Copy ids exactly from the context or search results."
  };
}
export function normalizeLookupIds(args = {}) {
  const fromList = Array.isArray(args.ids) ? args.ids : [];
  const single = args.id ?? args.context_id ?? args.contextId ?? "";
  return [...fromList, single]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 20);
}
export async function fetchTool(args, context) {
  const kind = normalizeFetchKind(args.kind || args.type || "all");
  const maxItems = clampNumber(args.max_items ?? args.maxItems ?? 20, 1, 50, 20);
  const query = normalizeSearchQuery(args.query || "");
  const available = buildInspectableItems(context);
  const posts = (kind === "all" || kind === "posts") ? filterInspectableItems(available.posts, query).slice(0, maxItems) : [];
  const links = (kind === "all" || kind === "links") ? filterInspectableItems(available.links, query).slice(0, maxItems) : [];
  const media = (kind === "all" || kind === "media") ? filterInspectableItems(available.media, query).slice(0, maxItems) : [];

  // counts must describe what is actually returned: reporting unfiltered totals next
  // to empty filtered arrays ("12 posts" but posts: []) sends models into a dead end.
  const result = {
    ok: true,
    tool: "fetch",
    kind,
    query,
    counts: {
      posts: posts.length,
      links: links.length,
      media: media.length
    },
    totalAvailable: {
      posts: available.posts.length,
      links: available.links.length,
      media: available.media.length
    },
    posts,
    links,
    media,
    next: "Open posts or pages with get, or analyze media with analyze_image / analyze_video."
  };
  if (query && !posts.length && !links.length && !media.length) {
    result.note = `No available items matched the query "${query}". Call fetch again without a query to list all available items.`;
  }
  return result;
}

export function resolveMaxMultiLinks(settings = {}, context = {}) {
  return Math.floor(clampNumber(
    settings.maxMultiLinks ?? context.maxMultiLinks,
    MIN_MULTI_LINKS,
    MAX_MULTI_LINKS,
    DEFAULT_MULTI_LINKS
  ));
}

/** Reset at the start of each tool-execution turn so batch + parallel gets share one budget. */
export function resetTurnLinkOpenBudget(context, settings = {}) {
  const max = resolveMaxMultiLinks(settings, context);
  context.maxMultiLinks = max;
  context.turnLinkOpenBudget = max;
  return max;
}

export function remainingTurnLinkOpenBudget(context) {
  if (typeof context?.turnLinkOpenBudget !== "number") return Infinity;
  return Math.max(0, context.turnLinkOpenBudget);
}

function consumeTurnLinkOpenBudget(context) {
  if (typeof context?.turnLinkOpenBudget !== "number") return true;
  if (context.turnLinkOpenBudget <= 0) return false;
  context.turnLinkOpenBudget -= 1;
  return true;
}

/**
 * Normalize get args into discrete target specs. Supports single id/url fields and
 * batch ids[] / urls[] for multi-link research in one call.
 */
export function normalizeGetTargets(args = {}) {
  const specs = [];
  const seen = new Set();

  const push = (spec) => {
    const key = [
      String(spec.id || "").trim(),
      String(spec.context_id || "").trim(),
      String(spec.status_id || "").trim(),
      normalizeSourceUrl(spec.url || "")
    ].join("|");
    if (!key.replace(/\|/g, "")) return;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(spec);
  };

  const ids = Array.isArray(args.ids) ? args.ids : [];
  for (const id of ids) {
    const value = String(id || "").trim();
    if (value) push({ id: value });
  }

  const urls = Array.isArray(args.urls) ? args.urls : [];
  for (const url of urls) {
    const value = String(url || "").trim();
    if (value) push({ url: value });
  }

  const singleId = String(args.id ?? "").trim();
  const singleContextId = String(args.context_id ?? args.contextId ?? "").trim();
  const singleStatusId = String(args.status_id ?? args.statusId ?? "").trim();
  const singleUrl = String(args.url ?? "").trim();
  if (singleId || singleContextId || singleStatusId || singleUrl) {
    push({
      id: singleId,
      context_id: singleContextId,
      status_id: singleStatusId,
      url: singleUrl
    });
  }

  return specs;
}

export function isBatchGetArgs(args = {}) {
  return (Array.isArray(args.ids) && args.ids.length > 0)
    || (Array.isArray(args.urls) && args.urls.length > 0);
}

export async function getTool(args, context, settings = {}) {
  const maxMultiLinks = resolveMaxMultiLinks(settings, context);
  if (typeof context.turnLinkOpenBudget !== "number") {
    resetTurnLinkOpenBudget(context, settings);
  }

  const specs = normalizeGetTargets(args);
  if (!specs.length) {
    return {
      ok: false,
      tool: "get",
      error: `Provide id, url, ids, or urls. You may open up to ${maxMultiLinks} posts/pages per turn. ${DONT_RETRY_HINT}`,
      maxMultiLinks
    };
  }

  const shared = {
    max_posts: args.max_posts ?? args.maxPosts,
    max_chars: args.max_chars ?? args.maxChars
  };

  const requested = specs.length;
  const truncated = requested > maxMultiLinks;
  const toOpen = specs.slice(0, maxMultiLinks);
  const skipped = truncated ? specs.slice(maxMultiLinks) : [];

  // The schema only offers ids/urls arrays, so a one-element array is the normal
  // single open; only real batches get the batch wrapper.
  if (toOpen.length === 1 && !truncated) {
    return getSingleTarget({ ...toOpen[0], ...shared }, context, { maxMultiLinks });
  }

  const settled = await Promise.all(
    toOpen.map((spec) => getSingleTarget({ ...spec, ...shared }, context, { maxMultiLinks }))
  );

  const opened = settled.filter((result) => result?.ok).length;
  return {
    ok: opened > 0,
    tool: "get",
    batch: true,
    results: settled,
    opened,
    requested,
    maxMultiLinks,
    remainingBudget: remainingTurnLinkOpenBudget(context),
    truncated,
    skipped: skipped.map((spec) => spec.id || spec.url || spec.status_id || spec.context_id).filter(Boolean),
    note: truncated
      ? `Requested ${requested} targets but max multi-links is ${maxMultiLinks}. Opened the first ${toOpen.length}; do not request more than ${maxMultiLinks} in one turn.`
      : `Opened ${opened} of ${toOpen.length} target(s). Remaining open budget this turn: ${remainingTurnLinkOpenBudget(context)}.`
  };
}

async function getSingleTarget(args, context, options = {}) {
  const maxMultiLinks = options.maxMultiLinks ?? resolveMaxMultiLinks({}, context);
  const target = resolveInspectableTarget(args, context);
  if (!target) {
    const available = buildInspectableItems(context);
    const requested = String(args.id ?? args.context_id ?? args.status_id ?? args.url ?? "").trim();
    return {
      ok: false,
      tool: "get",
      error: `Could not resolve "${requested}". Ids must be copied exactly from the context or search results, never retyped or guessed. ${DONT_RETRY_HINT}`,
      didYouMean: findClosestPostIds(requested, available.posts),
      availablePosts: available.posts.slice(0, 12).map(compactPostRef),
      availableLinks: available.links.slice(0, 8).map(compactLinkRef)
    };
  }

  if (target.type === "post" || isAllowedXStatusUrl(target.url)) {
    const maxPosts = clampNumber(args.max_posts ?? args.maxPosts ?? 16, 1, 30, 16);
    const threadTarget = threadTargetFromInspectableItem(target);
    if (!threadTarget.url) {
      return {
        ok: false,
        tool: "get",
        type: "post",
        target: threadTarget,
        error: "The requested post did not have a resolvable X status URL."
      };
    }

    const existing = findExistingThreadRead(context, threadTarget);
    if (existing) return { ...cloneJson(existing), cached: true };

    if (!consumeTurnLinkOpenBudget(context)) {
      return {
        ok: false,
        tool: "get",
        type: "post",
        target: threadTarget,
        error: `Multi-link open budget exhausted for this turn (max ${maxMultiLinks}). Use results already gathered, or wait for the next tool turn.`,
        maxMultiLinks,
        budgetExhausted: true
      };
    }

    const thread = await collectThreadInBackground(threadTarget, maxPosts, context);
    const result = {
      ok: Boolean(thread && !thread.error),
      tool: "get",
      type: "post",
      target: threadTarget,
      thread
    };
    // A thread read that failed (usually a guessed status id X has never seen)
    // must hand the model a way out, or small models retry variants of the same
    // bad id: suggest the closest real ids and list what actually exists.
    // A post the context already listed exists; only a guessed status id or URL is
    // likely bogus. Saying "does not exist" for a known post made models tell users
    // real posts were missing.
    if (!result.ok) {
      const guessed = target.source === "status_id" || target.source === "url";
      if (guessed) {
        const available = buildInspectableItems(context);
        result.error = `${thread?.error || "The post could not be read."} The id likely does not exist. ${DONT_RETRY_HINT}`;
        result.didYouMean = findClosestPostIds(threadTarget.statusId || threadTarget.contextId, available.posts);
        result.availablePosts = available.posts.slice(0, 12).map(compactPostRef);
      } else {
        result.error = `${thread?.error || "The post could not be read."} The post exists but its full thread could not be loaded right now; use the text already in the context and do not retry.`;
      }
    }
    context.deepThreads.push(result);
    return result;
  }

  if (target.type === "link" && isAllowedHttpUrl(target.url)) {
    const maxChars = clampNumber(args.max_chars ?? args.maxChars ?? 12000, 1000, 24000, 12000);
    const existing = findExistingWebRead(context, target.url);
    if (existing) return { ...cloneJson(existing), cached: true };

    if (!consumeTurnLinkOpenBudget(context)) {
      return {
        ok: false,
        tool: "get",
        type: "link",
        target,
        error: `Multi-link open budget exhausted for this turn (max ${maxMultiLinks}). Use results already gathered, or wait for the next tool turn.`,
        maxMultiLinks,
        budgetExhausted: true
      };
    }

    const page = await collectWebPageInBackground(target.url, maxChars);
    const result = {
      ok: page.ok,
      tool: "get",
      type: "link",
      target,
      page
    };
    context.webReads.push(result);
    return result;
  }

  return {
    ok: false,
    tool: "get",
    target,
    error: "Only http(s) URLs and X/Twitter status posts can be inspected."
  };
}
export function findExistingThreadRead(context, target) {
  const statusId = String(target.statusId || extractStatusIdFromUrl(target.url) || "");
  const normalizedUrl = normalizeSourceUrl(target.url || "");
  return (context.deepThreads ?? []).find((read) => {
    const readTarget = read?.target ?? {};
    return (statusId && (readTarget.statusId === statusId || extractStatusIdFromUrl(readTarget.url) === statusId))
      || (normalizedUrl && normalizeSourceUrl(readTarget.url || "") === normalizedUrl);
  }) ?? null;
}
export function findExistingWebRead(context, url) {
  const normalizedUrl = normalizeSourceUrl(url || "");
  return (context.webReads ?? []).find((read) => normalizeSourceUrl(read?.target?.url || read?.page?.url || "") === normalizedUrl) ?? null;
}
export async function readThreadTool(args, context, settings = {}) {
  return getTool({
    ...args,
    id: args.id || args.context_id || args.contextId || "",
    status_id: args.status_id || args.statusId || "",
    url: args.url || ""
  }, context, settings);
}
export function normalizeFetchKind(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  if (normalized === "posts" || normalized === "post") return "posts";
  if (normalized === "links" || normalized === "link") return "links";
  if (normalized === "media" || normalized === "images" || normalized === "videos") return "media";
  return "all";
}
