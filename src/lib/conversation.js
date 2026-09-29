/** Most chat entries (user + assistant) a chat keeps and sends; the latest anchor survives the cap. */
export const CONVERSATION_ENTRY_LIMIT = 60;

/**
 * The two chat entries for a finished turn. `turn` comes from the background
 * (runAskPipeline): the exact context the question was asked with, and the tool
 * evidence and short-id aliases the answer produced. The UI shows only `content`.
 */
export function createTurnEntries(question, answer, turn = {}) {
  const user = { role: "user", content: question };
  const assistant = { role: "assistant", content: answer };
  if (turn && typeof turn === "object") {
    if (typeof turn.context === "string" && turn.context) {
      user.context = turn.context;
      user.contextKind = turn.contextKind === "full" ? "full" : "followup";
    }
    if (typeof turn.subject === "string" && turn.subject) user.subject = turn.subject;
    if (typeof turn.evidence === "string" && turn.evidence) assistant.evidence = turn.evidence;
    if (turn.aliases && typeof turn.aliases === "object" && !Array.isArray(turn.aliases)) assistant.aliases = turn.aliases;
  }
  return [user, assistant];
}

/** Copy of a stored chat message with only the fields the model-facing history uses. */
export function toConversationEntry(message) {
  const entry = { role: message?.role === "assistant" ? "assistant" : "user", content: String(message?.content || "") };
  for (const key of ["context", "contextKind", "subject", "evidence", "aliases"]) {
    if (message?.[key] !== undefined && message[key] !== "") entry[key] = message[key];
  }
  return entry;
}

/**
 * Append a finished turn in place (callers share the array). Only the newest
 * assistant entry needs evidence and aliases: older evidence was already copied
 * into the next user turn's context, and the newest aliases supersede older ones.
 */
export function appendConversationTurn(entries, question, answer, turn) {
  for (const entry of entries) {
    if (entry?.role !== "assistant") continue;
    delete entry.evidence;
    delete entry.aliases;
  }
  entries.push(...createTurnEntries(question, answer, turn));
  return capConversationInPlace(entries);
}

/** Cap `entries` in place (callers share the array). */
export function capConversationInPlace(entries, limit = CONVERSATION_ENTRY_LIMIT) {
  const capped = capConversationEntries(entries, limit);
  entries.splice(0, entries.length, ...capped);
  return entries;
}

/**
 * Chat entries are { role, content, ... }. A user entry with contextKind "full"
 * carries the complete post/thread context the model saw for that turn (the
 * "anchor"). Capping must keep the latest anchor pair, or follow-ups lose the
 * thread they are about.
 */
export function capConversationEntries(entries, limit) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const max = Math.max(2, Math.floor(Number(limit) || 0));
  if (list.length <= max) return list.slice();

  let anchor = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user" && list[index]?.contextKind === "full") {
      anchor = index;
      break;
    }
  }

  const withoutLeadingAssistant = (items) => {
    const output = items.slice();
    while (output.length && output[0]?.role !== "user") output.shift();
    return output;
  };

  if (anchor === -1 || anchor >= list.length - max) {
    return withoutLeadingAssistant(list.slice(-max));
  }
  const pair = list.slice(anchor, anchor + 2);
  const tail = withoutLeadingAssistant(list.slice(list.length - (max - pair.length)));
  return [...pair, ...tail];
}
