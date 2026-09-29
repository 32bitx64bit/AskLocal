import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  MAX_MODEL_CONTEXT_TOKENS,
  MIN_MODEL_CONTEXT_TOKENS
} from "../constants.js";
import {
  clampNumber
} from "../../lib/utils.js";

/** Rough per-message framing cost (role markers, separators) in chat templates. */
const MESSAGE_OVERHEAD_TOKENS = 6;
/** Vision encoders cost anywhere from ~250 to ~1500 tokens per image; assume the middle. */
const IMAGE_TOKEN_ESTIMATE = 800;

/**
 * Cheap token estimate. ASCII averages ~4 chars/token; non-ASCII (CJK, emoji,
 * accented scripts) is closer to 1 token/char, and X posts are multilingual, so
 * counting it at chars/4 would badly underestimate and overflow small contexts.
 */
export function estimateTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  const nonAscii = value.replace(/[\x00-\x7F]/g, "").length;
  return Math.ceil((value.length - nonAscii) / 4 + nonAscii);
}

export function estimateMessageTokens(message) {
  if (!message) return 0;
  let total = MESSAGE_OVERHEAD_TOKENS;
  const content = message.content;
  if (typeof content === "string") {
    total += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text") total += estimateTokens(part.text);
      else if (part?.type === "image_url") total += IMAGE_TOKEN_ESTIMATE;
    }
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    total += estimateTokens(call?.function?.name) + estimateTokens(call?.function?.arguments) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

export function estimateMessagesTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * Split the model's context window into the budgets one ask works with.
 * - inputTokens: everything sent (system, tools, history, context, tool results).
 *   The rest of the window is left for the answer.
 * - initialTokens: cap for the first request of an ask, leaving headroom for tool results.
 * - toolResultChars: cap for one rendered tool result.
 * - evidenceChars: cap for the tool evidence carried into the next turn.
 */
export function resolveRequestBudget(settings = {}) {
  const contextTokens = Math.floor(clampNumber(
    settings.modelContextTokens,
    MIN_MODEL_CONTEXT_TOKENS,
    MAX_MODEL_CONTEXT_TOKENS,
    DEFAULT_MODEL_CONTEXT_TOKENS
  ));
  const answerReserve = Math.round(clampNumber(contextTokens * 0.2, 768, 4096, 1024));
  const inputTokens = Math.max(1024, contextTokens - answerReserve);
  const initialTokens = Math.floor(inputTokens * 0.8);
  return {
    contextTokens,
    inputTokens,
    initialTokens,
    toolResultChars: Math.round(clampNumber(inputTokens * 4 * 0.2, 2000, 16000, 4000)),
    evidenceChars: Math.round(clampNumber(inputTokens * 4 * 0.25, 1500, 24000, 4000))
  };
}

/** Cut text to maxChars on a line or word boundary and mark the cut. */
export function capText(text, maxChars, marker = "\n[…cut to fit the context budget]") {
  const value = String(text || "");
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!cap || value.length <= cap) return value;
  const room = Math.max(0, cap - marker.length);
  let cut = value.lastIndexOf("\n", room);
  if (cut < room * 0.6) cut = value.lastIndexOf(" ", room);
  if (cut < room * 0.6) cut = room;
  return `${value.slice(0, cut).trimEnd()}${marker}`;
}
