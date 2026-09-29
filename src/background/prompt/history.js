import {
  CONVERSATION_ENTRY_LIMIT,
  capConversationEntries
} from "../../lib/conversation.js";
import {
  estimateMessageTokens
} from "./budget.js";
import {
  scrubInternalIds
} from "./build.js";

/**
 * History layout sent to the model:
 *
 *   system
 *   user:      <full context block + question>   (turn 1, the "anchor")
 *   assistant: <answer 1>
 *   user:      <tool evidence from turn 1 + question 2>
 *   assistant: <answer 2>
 *   user:      <new message>
 *
 * Every user turn replays the exact text the model saw at the time (stored as
 * `context`), so the conversation prefix stays byte-identical across asks and local
 * servers can reuse their prompt cache. The UI keeps showing only `content`.
 */
export function normalizeConversationHistory(history) {
  if (!Array.isArray(history)) return [];
  const entries = history.map(normalizeHistoryEntry).filter(Boolean);
  return capConversationEntries(entries, CONVERSATION_ENTRY_LIMIT);
}

function normalizeHistoryEntry(turn) {
  const role = turn?.role === "assistant" ? "assistant" : turn?.role === "user" ? "user" : "";
  const content = String(turn?.content || "").trim();
  if (!role || !content) return null;

  if (role === "user") {
    const entry = { role, content };
    const stored = typeof turn.context === "string" ? turn.context.trim() : "";
    if (stored) {
      entry.context = stored;
      entry.contextKind = turn.contextKind === "full" ? "full" : "followup";
    }
    const subject = typeof turn.subject === "string" ? turn.subject.trim() : "";
    if (subject) entry.subject = subject.slice(0, 64);
    return entry;
  }

  const entry = { role, content: scrubInternalIds(content).trim() };
  const evidence = typeof turn.evidence === "string" ? turn.evidence.trim() : "";
  if (evidence) entry.evidence = evidence;
  if (turn.aliases && typeof turn.aliases === "object" && !Array.isArray(turn.aliases)) {
    entry.aliases = turn.aliases;
  }
  return entry;
}

/** Pair user entries with the assistant reply that follows; drop orphans. */
function groupTurns(history) {
  const turns = [];
  let pendingUser = null;
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry.role === "user") {
      pendingUser = entry;
    } else if (entry.role === "assistant" && pendingUser) {
      turns.push({
        user: pendingUser,
        assistant: entry,
        anchor: pendingUser.contextKind === "full" && Boolean(pendingUser.context),
        mode: "full"
      });
      pendingUser = null;
    }
  }
  return turns;
}

function userTextFor(turn) {
  return turn.mode === "full" && turn.user.context ? turn.user.context : turn.user.content;
}

function turnTokens(turn) {
  if (turn.mode === "drop") return 0;
  return estimateMessageTokens({ content: userTextFor(turn) }) + estimateMessageTokens({ content: turn.assistant.content });
}

/**
 * Fit history into budgetTokens. Shrinks in order of least value:
 *   1. older follow-up turns lose their stored context (evidence) and become plain questions
 *   2. older turns are dropped
 *   3. recent follow-up turns become plain questions
 *   4. recent turns are dropped, except the newest one
 *   5. the anchor becomes a plain question (the caller then rebuilds fresh context)
 *   6. everything else is dropped, oldest first
 * The latest anchor is protected until step 5 because it holds the thread itself.
 */
export function planHistoryMessages(history, { budgetTokens = Infinity, keepRecentTurns = 2 } = {}) {
  const turns = groupTurns(history);
  const budget = Math.max(0, Number(budgetTokens) || 0);
  let anchorIndex = -1;
  turns.forEach((turn, index) => {
    if (turn.anchor) anchorIndex = index;
  });

  let total = turns.reduce((sum, turn) => sum + turnTokens(turn), 0);
  const fits = () => total <= budget;
  const setMode = (index, mode) => {
    const turn = turns[index];
    const rank = { full: 0, plain: 1, drop: 2 };
    if (rank[mode] <= rank[turn.mode]) return;
    if (mode === "plain" && !turn.user.context) return;
    total -= turnTokens(turn);
    turn.mode = mode;
    total += turnTokens(turn);
  };
  const applyUntilFits = (indices, mode) => {
    for (const index of indices) {
      if (fits()) return;
      setMode(index, mode);
    }
  };

  if (!fits()) {
    const recentStart = Math.max(0, turns.length - keepRecentTurns);
    const indices = turns.map((_, index) => index);
    const older = indices.filter((index) => index < recentStart && index !== anchorIndex);
    const recent = indices.filter((index) => index >= recentStart && index !== anchorIndex);
    const newest = turns.length - 1;
    applyUntilFits(older, "plain");
    applyUntilFits(older, "drop");
    applyUntilFits(recent, "plain");
    applyUntilFits(recent.filter((index) => index !== newest), "drop");
    if (anchorIndex >= 0) applyUntilFits([anchorIndex], "plain");
    applyUntilFits(indices, "drop");
  }

  const messages = [];
  for (const turn of turns) {
    if (turn.mode === "drop") continue;
    messages.push({ role: "user", content: userTextFor(turn) });
    messages.push({ role: "assistant", content: turn.assistant.content });
  }

  const anchor = anchorIndex >= 0 ? turns[anchorIndex] : null;
  return {
    messages,
    tokens: total,
    hasAnchor: Boolean(anchor),
    anchorKept: Boolean(anchor && anchor.mode === "full"),
    anchorSubject: anchor?.user.subject || "",
    droppedTurns: turns.filter((turn) => turn.mode === "drop").length
  };
}

/** Subject of the newest anchor turn, whether or not it survives budgeting. */
export function latestAnchorSubject(history) {
  const turns = groupTurns(history);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].anchor) return { found: true, subject: turns[index].user.subject || "" };
  }
  return { found: false, subject: "" };
}

/** Tool evidence and id aliases saved on the most recent assistant turn. */
export function latestAssistantState(history) {
  const list = Array.isArray(history) ? history : [];
  const last = list[list.length - 1];
  const lastAssistant = [...list].reverse().find((entry) => entry.role === "assistant" && entry.aliases);
  return {
    evidence: last?.role === "assistant" ? last.evidence || "" : "",
    aliases: lastAssistant?.aliases || null
  };
}
