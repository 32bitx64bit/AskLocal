import {
  normalizePlainText
} from "../../lib/text.js";
import {
  clampNumber,
  uniqueBy
} from "../../lib/utils.js";

/**
 * Turns the posts gathered around a selected X post into a reply tree and prints it as
 * indented text: every post sits under the post it replies to, the selected post is
 * marked, and each post says who it is answering. A flat list of "top replies" forces
 * the model to guess which reply is aimed at which; the tree states it.
 *
 * Reply links come from the X API (replyToStatusId). When the API read failed and only
 * the page was scraped there are no links, so placement falls back to page order and is
 * flagged as approximate; nothing is claimed about a post's position that is not known.
 */

const keyOf = (tweet) => tweet?.statusId || tweet?.contextId || "";

const handleOf = (tweet) => String(tweet?.authorHandle || "").replace(/^@/, "");

const whoIs = (tweet) => (handleOf(tweet) ? `@${handleOf(tweet)}` : tweet?.displayName || "unknown author");

const scoreOf = (node) => {
  const metrics = node.tweet?.metrics ?? {};
  return Number(metrics.likes || 0) * 1e6 + Number(metrics.replies || 0) * 1e3 + Number(metrics.reposts || 0);
};

const orderOf = (node) => Number(node.tweet?.entryOrder ?? node.tweet?.sequenceIndex ?? 0);

const byValue = (left, right) => scoreOf(right) - scoreOf(left) || orderOf(left) - orderOf(right);

/**
 * @param {object} input
 * @param {object} input.selected   the post the user clicked
 * @param {object} [input.quoted]   the post the selected post quotes
 * @param {object} [input.thread]   X API thread (root, conversationRoot, parents, posts, rootStatusId); absent when the API read failed
 * @param {object[]} [input.extraPosts] page-scraped posts (visibleRole tells where they sat)
 */
export function buildConversation({ selected = null, quoted = null, thread = null, extraPosts = [] } = {}) {
  const apiBacked = Boolean(thread);
  const selectedKey = keyOf(selected);
  const quotedKey = keyOf(quoted);

  const pool = uniqueBy([
    selected,
    thread?.conversationRoot,
    ...(thread?.parents ?? []),
    ...(thread?.posts ?? []),
    ...extraPosts
  ].filter(Boolean), keyOf);

  // A quoted post belongs to the post that quotes it, not to the reply tree.
  const quotedBy = new Map();
  if (quoted && selectedKey) quotedBy.set(selectedKey, quoted);
  for (const tweet of pool) {
    if (tweet.sourceRole === "quoted_post" && tweet.quotedByStatusId && !quotedBy.has(tweet.quotedByStatusId)) {
      quotedBy.set(tweet.quotedByStatusId, tweet);
    }
  }

  const nodes = new Map();
  for (const tweet of pool) {
    const key = keyOf(tweet);
    if (!key) continue;
    if (key !== selectedKey && (tweet.sourceRole === "quoted_post" || key === quotedKey)) continue;
    nodes.set(key, { key, tweet, parent: null, children: [], inferred: false });
  }

  const link = (child, parent, inferred = false) => {
    if (!child || !parent || child === parent) return false;
    for (let walker = parent; walker; walker = walker.parent) {
      if (walker === child) return false;
    }
    child.parent = parent;
    child.inferred = inferred;
    parent.children.push(child);
    return true;
  };

  for (const node of nodes.values()) {
    const parent = nodes.get(node.tweet.replyToStatusId);
    if (parent) link(node, parent);
  }

  const selectedNode = nodes.get(selectedKey) ?? null;
  const topOf = (node) => {
    let top = node;
    while (top?.parent) top = top.parent;
    return top;
  };

  // Without X's reply links the page is all there is: it lists the original post and
  // the replies above the selected post in order, then the replies below it.
  if (!apiBacked && selectedNode) {
    const loose = [...nodes.values()].filter((node) => node !== selectedNode);
    const prior = loose
      .filter((node) => /^(original_post|prior_reply_or_parent_context)$/.test(node.tweet.visibleRole || ""))
      .sort((left, right) => orderOf(left) - orderOf(right));
    prior.forEach((node, index) => {
      if (index > 0) link(node, prior[index - 1], true);
    });
    if (prior.length) link(selectedNode, prior[prior.length - 1], true);
    for (const node of loose) {
      if (!node.parent && node.tweet.visibleRole === "later_reply_or_comment") link(node, selectedNode, true);
    }
  }

  const primaryTop = selectedNode ? topOf(selectedNode) : null;
  // Replies whose parent post could not be loaded still belong to this thread.
  if (primaryTop && apiBacked) {
    for (const node of nodes.values()) {
      if (node.parent || node === primaryTop) continue;
      const sameThread = thread.rootStatusId && node.tweet.conversationId === thread.rootStatusId;
      if (sameThread && node.tweet.replyToStatusId) link(node, primaryTop, true);
    }
  }

  const path = [];
  for (let walker = selectedNode; walker; walker = walker.parent) path.unshift(walker);
  const onPath = new Set(path);

  const sortChildren = (node) => {
    node.children.sort((left, right) => (onPath.has(right) ? 1 : 0) - (onPath.has(left) ? 1 : 0) || byValue(left, right));
    node.children.forEach(sortChildren);
  };
  if (primaryTop) sortChildren(primaryTop);

  // Posts that could not be placed in the tree (page-scraped extras the API did not return).
  const orphans = [...nodes.values()]
    .filter((node) => topOf(node) !== primaryTop)
    .sort((left, right) => orderOf(left) - orderOf(right));

  return {
    apiBacked,
    nodes,
    selected: selectedNode,
    primaryTop,
    path,
    onPath,
    orphans,
    quotedBy,
    // The first post of the path is the real start of the conversation only when X says it replies to nothing.
    pathIsComplete: Boolean(apiBacked && path.length && !path[0].tweet.replyToStatusId),
    hasInferred: [...nodes.values()].some((node) => node.inferred)
  };
}

function descendantsOf(node) {
  const out = [];
  const walk = (current) => {
    for (const child of current.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Which posts make it into the prompt under the current budget level. */
export function pickVisibleNodes(conversation, caps = {}) {
  const { selected, primaryTop, path } = conversation;
  const keep = new Set();
  const omittedBefore = new Map();
  if (!selected) return { keep, omittedBefore };

  // Adds `node` and the not-yet-kept posts connecting it to the tree, if they fit in `room`.
  const addWithin = (candidates, cap) => {
    let used = 0;
    for (const node of candidates) {
      if (keep.has(node)) continue;
      const chain = [];
      for (let walker = node; walker && !keep.has(walker); walker = walker.parent) chain.push(walker);
      if (used >= cap) break;
      if (used > 0 && used + chain.length > cap) continue;
      chain.forEach((item) => keep.add(item));
      used += chain.length;
    }
  };

  const ancestors = path.slice(0, -1);
  const maxAncestors = Math.max(1, Number(caps.parents ?? 8));
  // Keep the thread root and the posts nearest the selected one.
  const keptAncestors = ancestors.length > maxAncestors
    ? [ancestors[0], ...ancestors.slice(ancestors.length - (maxAncestors - 1))]
    : ancestors;
  keptAncestors.forEach((node) => keep.add(node));
  keep.add(selected);

  // Replies under the selected post, most valuable first, each with the replies that
  // connect it to the selected post.
  const under = descendantsOf(selected);
  addWithin([...under].sort(byValue), Math.max(0, Number(caps.topLiked ?? 12) + Number(caps.ranked ?? 0)));

  // The rest of the thread (siblings, replies to the root): a sample.
  if (primaryTop) {
    const underSet = new Set(under);
    const elsewhere = descendantsOf(primaryTop).filter((node) => !underSet.has(node) && !conversation.onPath.has(node));
    addWithin(elsewhere.sort(byValue), Math.max(0, Number(caps.rootReplies ?? 8)));
  }

  // Counted last: connecting a sibling can pull a dropped ancestor back in.
  let previousIndex = -1;
  path.forEach((node, index) => {
    if (!keep.has(node)) return;
    const gap = index - previousIndex - 1;
    if (previousIndex >= 0 && gap > 0) omittedBefore.set(node, gap);
    previousIndex = index;
  });

  return { keep, omittedBefore };
}

function replyTarget(node) {
  const tweet = node.tweet;
  const handles = (tweet.replyingTo?.length ? tweet.replyingTo : [tweet.replyToHandle]).filter(Boolean);
  if (!handles.length) return "";
  return `replying to ${handles.map((handle) => `@${String(handle).replace(/^@/, "")}`).join(", ")}`;
}

function formatFlags(tweet, { skipMedia, aliasOf }) {
  const flags = [];
  if (!skipMedia) {
    for (const item of Array.isArray(tweet.media) ? tweet.media : []) {
      const type = item?.type || item?.mediaType;
      if (type === "video") flags.push("[video]");
      else if (type === "image") flags.push("[image]");
    }
  }
  if (tweet.card?.url) flags.push(`[link card: ${[tweet.card.title, tweet.card.url].filter(Boolean).join(" ")}]`.slice(0, 220));
  if (tweet.textTruncated) {
    const id = aliasOf?.(tweet);
    flags.push(id ? `[truncated: get ${id} for full text]` : "[truncated]");
  }
  return flags;
}

/** 2025-03-05T10:00:00.000Z -> 2025-03-05 10:00Z; anything else is left as X or the page gave it. */
function shortTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/.exec(String(value || ""));
  return match ? `${match[1]} ${match[2]}Z` : String(value || "");
}

function indentBlock(text, indent) {
  return String(text || "")
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line))
    .join("\n");
}

/**
 * @param {object} conversation  from buildConversation
 * @param {object} options
 * @param {object} options.caps        trim level (parents, topLiked, ranked, rootReplies, visible, tweetChars, currentChars)
 * @param {Function} options.aliasOf   tweet -> short id (p3)
 * @param {Function} [options.extras]  (tweet, { primary }) -> string[]: media analyses, subtitles. Without it,
 *                                     media is only flagged on the post line.
 */
export function renderConversation(conversation, options = {}) {
  const { caps = {}, aliasOf = () => "", extras = null } = options;
  const { selected, primaryTop, path, onPath } = conversation;
  if (!selected || !primaryTop) return renderUnplaced(conversation, options);

  const { keep, omittedBefore } = pickVisibleNodes(conversation, caps);
  const parentOfSelected = selected.parent;
  const isPrimary = (node) => node === selected || node === parentOfSelected || node === primaryTop;

  const renderPost = (sink, tweet, depth, { marks = [], relation = "", primary = false } = {}) => {
    const indent = "  ".repeat(depth);
    const id = aliasOf(tweet);
    const head = [id ? `[${id}]` : "", ...marks, whoIs(tweet)].filter(Boolean).join(" ");
    const meta = [relation, shortTime(tweet.postedAt), tweet.engagement].filter(Boolean).join("; ");
    const maxChars = clampNumber(primary ? caps.currentChars : caps.tweetChars, 100, 4000, primary ? 1500 : 600);
    const text = normalizePlainText(tweet.text || "").slice(0, maxChars);
    const hasMedia = Array.isArray(tweet.media) && tweet.media.length > 0;
    const body = text || (hasMedia && extras ? "(no text: the post is only its attached media, shown below)" : "[no readable text]");
    const flags = formatFlags(tweet, { skipMedia: Boolean(extras), aliasOf });
    sink.push(`${indent}${head}${meta ? ` (${meta})` : ""}: ${indentBlock(body, `${indent}  `).trimStart()}${flags.length ? ` ${flags.join(" ")}` : ""}`);
    if (extras) {
      for (const block of extras(tweet, { primary }) ?? []) {
        if (block) sink.push(indentBlock(block, `${indent}  `));
      }
    }
  };

  // Kept posts below `node`, reaching through ancestors that were dropped to save room.
  const visibleChildren = (node) => node.children.flatMap((child) => {
    if (keep.has(child)) return [child];
    return onPath.has(child) ? visibleChildren(child) : [];
  });

  const lines = [];
  const renderNode = (node, depth) => {
    const tweet = node.tweet;
    const marks = [];
    if (node === selected) marks.push("★ SELECTED");
    if (node === primaryTop && conversation.pathIsComplete) marks.push("THREAD ROOT");
    let relation = replyTarget(node);
    if (relation && tweet.replyToStatusId && (!node.parent || node.inferred)) relation += ", that post was not loaded";
    const omitted = omittedBefore.get(node);
    if (omitted) lines.push(`${"  ".repeat(depth)}… ${omitted} more post${omitted === 1 ? "" : "s"} in the reply chain not shown`);
    renderPost(lines, tweet, depth, { marks, relation, primary: isPrimary(node) });

    const quoted = conversation.quotedBy.get(node.key);
    if (quoted) {
      lines.push(`${"  ".repeat(depth + 1)}↳ quotes:`);
      renderPost(lines, quoted, depth + 2, { primary: node === selected || node === parentOfSelected });
    }
    for (const child of visibleChildren(node)) renderNode(child, depth + 1);
    if (node === selected || node === primaryTop) {
      const hidden = node.children.filter((child) => !keep.has(child) && !onPath.has(child)).length;
      if (hidden > 0) lines.push(`${"  ".repeat(depth + 1)}(${hidden} more repl${hidden === 1 ? "y" : "ies"} to this post not shown)`);
    }
  };
  renderNode(primaryTop, 0);

  const orphanNodes = conversation.orphans.slice(0, Math.max(0, Number(caps.visible ?? 6)));
  const orphanLines = [];
  for (const node of orphanNodes) renderPost(orphanLines, node.tweet, 0, { relation: replyTarget(node) });

  const out = [
    ...describeConversation(conversation, { aliasOf, keep, orphanCount: orphanNodes.length }),
    "",
    "Thread (each post is indented under the post it replies to; ★ marks the post the user selected):",
    ...lines
  ];
  if (orphanLines.length) {
    out.push("", "Other posts seen on the page (how they relate to the thread is unknown):", ...orphanLines);
  }
  return out.join("\n");
}

/** No selected post to anchor a tree on (e.g. a tool read): list what there is. */
function renderUnplaced(conversation, options) {
  const { aliasOf = () => "" } = options;
  const posts = [...conversation.nodes.values()].slice(0, 12);
  if (!posts.length) return "";
  const lines = ["Posts (how they relate to each other is unknown):"];
  for (const node of posts) {
    const tweet = node.tweet;
    const id = aliasOf(tweet);
    const meta = [tweet.postedAt, tweet.engagement].filter(Boolean).join("; ");
    lines.push(`${id ? `[${id}] ` : ""}${whoIs(tweet)}${meta ? ` (${meta})` : ""}: ${normalizePlainText(tweet.text || "").slice(0, 600) || "[no readable text]"}`);
  }
  return lines.join("\n");
}

/** A few plain sentences that orient the model before it reads the tree. */
export function describeConversation(conversation, { aliasOf = () => "", keep = new Set(), orphanCount = 0 } = {}) {
  const { selected, path, primaryTop, onPath, apiBacked } = conversation;
  const label = (node) => {
    const id = aliasOf(node.tweet);
    return `${id ? `[${id}] ` : ""}${whoIs(node.tweet)}`;
  };
  const lines = ["Conversation map:"];
  if (!selected) return lines;

  const answering = replyTarget(selected).replace(/^replying to /, "");
  if (path.length <= 1) {
    if (selected.tweet.replyToStatusId || answering) {
      lines.push(`- The user selected ${label(selected)}, a reply to ${answering || "another post"}; the post it replies to could not be loaded.`);
    } else if (apiBacked) {
      lines.push(`- The user selected ${label(selected)}, the original post of this thread (it replies to nothing).`);
    } else {
      lines.push(`- The user selected ${label(selected)}. How it relates to the other posts is not known.`);
    }
  } else {
    const levels = path.length - 1;
    const rootWord = conversation.pathIsComplete ? "the thread root" : "the earliest post available";
    const hedge = path.some((node) => node.inferred) ? "appears to be " : "is ";
    lines.push(`- The user selected ${label(selected)}, which ${hedge}a reply ${levels === 1 ? "directly under" : `${levels} levels below`} ${rootWord} ${label(path[0])}.`);
    lines.push(`- Reply chain, oldest first: ${path.map((node) => `${label(node)}${node === selected ? " (selected)" : ""}`).join(" → ")}`);
  }

  const underAll = descendantsOf(selected);
  const underShown = underAll.filter((node) => keep.has(node)).length;
  const reported = Number(selected.tweet.metrics?.replies || 0);
  if (underShown) {
    lines.push(`- Replies to the selected post shown: ${underShown}${reported > underShown ? ` of about ${reported} (a sample; the rest are not included)` : ""}.`);
  } else if (reported) {
    lines.push(`- The selected post has about ${reported} repl${reported === 1 ? "y" : "ies"}, but none were loaded.`);
  } else {
    lines.push("- No replies to the selected post were loaded.");
  }
  if (primaryTop) {
    const underSet = new Set(underAll);
    const elsewhere = descendantsOf(primaryTop).filter((node) => keep.has(node) && !underSet.has(node) && !onPath.has(node)).length;
    if (elsewhere) lines.push(`- Other posts from elsewhere in the thread (siblings, replies to the root): ${elsewhere}.`);
  }
  if (orphanCount) lines.push(`- ${orphanCount} more post${orphanCount === 1 ? "" : "s"} seen on the page whose place in the thread is unknown.`);
  if (conversation.hasInferred) lines.push("- Some posts' placement is inferred (page order, or a reply whose parent could not be loaded) and may be approximate.");
  return lines;
}
