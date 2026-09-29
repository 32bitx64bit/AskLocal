import { api } from "../api.js";
import {
  PROVIDER_RETRY_BACKOFF_MS,
  PROVIDER_RETRY_LIMIT,
  PROVIDER_TRANSIENT_STATUSES
} from "../constants.js";
import {
  sleep,
  throwIfAborted,
  describeFetchError
} from "../../lib/utils.js";

export function isStreamSupportError(status, data) {
  if (![400, 404, 422, 500, 501].includes(status)) return false;
  return extractProviderError(data).toLowerCase().includes("stream");
}
export async function parseProviderResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) {
      // Providers (notably local OpenAI-compatible servers like LM Studio) return an HTML
      // error page on a crash instead of JSON. Summarize it so the surfaced error stays
      // readable instead of dumping a raw <!DOCTYPE html> blob.
      const isHtml = isHtmlErrorText(text);
      const message = (isHtml ? summarizeProviderErrorBody(text) : text.slice(0, 500)).trim();
      return { error: { message }, __htmlError: isHtml };
    }
    throw new Error("Provider returned non-JSON response.");
  }
}
export function isHtmlErrorText(text) {
  return /<!doctype html/i.test(text) || /<\/?(html|body|head|pre|title|div|p|h[1-6])\b/i.test(text);
}
export function summarizeProviderErrorBody(text) {
  const cleaned = String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Internal Server Error";
}
export function describeProviderError(status, data) {
  const code = Number(status) || 0;
  const detail = extractProviderError(data).trim();
  if (!detail) return `${code}`;
  if (data?.__htmlError || isHtmlErrorText(detail)) {
    return `${code} \u2014 the model provider returned an HTML error page instead of JSON ("${detail.slice(0, 120)}"). This usually means the local server crashed or rejected the request as too large (deep research and large video analyses can trigger it). AskLocal retries transient errors automatically.`;
  }
  return `${code} - ${detail}`;
}
export function isTransientProviderStatus(status) {
  return PROVIDER_TRANSIENT_STATUSES.has(Number(status) || 0);
}
/**
 * llama.cpp peg-native / chat-template parse failures: the model emitted malformed
 * tool-call markup. Same-body HTTP retries will not teach it; AskLocal re-prompts.
 */
export function isModelOutputFormatError(data, extraMessage = "") {
  const detail = `${extractProviderError(data)} ${extraMessage}`.toLowerCase();
  if (!detail.trim()) return false;
  if (detail.includes("peg-native")) return true;
  return detail.includes("does not match the expected") && detail.includes("format");
}
/** LM Studio / llama.cpp vision crashes — retrying just hammers a dead or OOM'd model. */
export function isProviderChannelCrashError(status, data, extraMessage = "") {
  const detail = `${extractProviderError(data)} ${extraMessage}`.toLowerCase();
  if (!detail.trim()) return false;
  return detail.includes("channel error")
    || detail.includes("model has crashed")
    || detail.includes("canceled predicting due to channel")
    || detail.includes("out of memory")
    || detail.includes("cuda error")
    || detail.includes("failed to decode image")
    || detail.includes("mtmd_helper")
    || detail.includes("failed to find a memory slot");
}
export function isFatalMediaProviderError(error) {
  const message = String(error?.message || error || "");
  return isProviderChannelCrashError(0, { error: { message } }, message);
}
export async function fetchWithTransientRetry(url, options, { progress, maxRetries = PROVIDER_RETRY_LIMIT } = {}) {
  const signal = options?.signal;
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      let host = "the provider";
      try { host = new URL(url).host || host; } catch { /* keep default */ }
      const wrapped = new Error(describeFetchError(error, host));
      if (isFatalMediaProviderError(error) || isFatalMediaProviderError(wrapped)) throw wrapped;
      throw wrapped;
    }
    if (response.ok) return response;

    // Read once so we can refuse retries on fatal vision crashes (Channel Error / OOM).
    const text = await response.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text ? { error: { message: summarizeProviderErrorBody(text) }, __htmlError: isHtmlErrorText(text) } : null;
    }
    const rebuild = () => new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });

    if (
      !isTransientProviderStatus(response.status)
      || attempt >= maxRetries
      || isProviderChannelCrashError(response.status, data, text)
      || isModelOutputFormatError(data, text)
    ) {
      return rebuild();
    }

    throwIfAborted(signal);
    if (typeof progress === "function") {
      await progress(`Provider returned a transient error (${response.status}); retrying (attempt ${attempt + 2} of ${maxRetries + 1})...`);
    }
    await sleep(PROVIDER_RETRY_BACKOFF_MS * (attempt + 1));
  }
}
export function extractProviderError(data) {
  if (!data) return "";
  if (typeof data.error === "string") return data.error;
  if (data.error?.message) return String(data.error.message);
  if (data.message) return String(data.message);
  return "";
}
export function isContextSizeError(data) {
  const err = data?.error;
  if (err && typeof err === "object" && err.type === "exceed_context_size_error") return true;
  const message = String(extractProviderError(data) || "").toLowerCase();
  if (!message) return false;
  if (message.includes("exceeds the available context size")) return true;
  if (/context (window|size|length)/.test(message) && /exceed|too (large|big|small)|larger than|not enough/.test(message)) return true;
  return false;
}
export function describeContextSizeError(data) {
  if (!isContextSizeError(data)) return "";
  const err = data?.error && typeof data.error === "object" ? data.error : {};
  const promptTokens = Number.isFinite(err.n_prompt_tokens) ? Number(err.n_prompt_tokens) : null;
  const ctxTokens = Number.isFinite(err.n_ctx) ? Number(err.n_ctx) : null;
  let sizes = "";
  if (promptTokens != null && ctxTokens != null) {
    sizes = ` AskLocal's request is about ${promptTokens.toLocaleString()} tokens, but this model's context window is only ${ctxTokens.toLocaleString()} tokens.`;
  } else if (promptTokens != null) {
    sizes = ` AskLocal's request is about ${promptTokens.toLocaleString()} tokens.`;
  }
  return [
    `This model's context window is too small for the request.${sizes}`,
    "AskLocal bundles the selected post, its thread and replies, the available tools, and any auto-read linked pages into the first message, so a long thread or article can outgrow a small context window.",
    "Fix it by increasing the model server's context length (LM Studio: the loaded model's Context Length setting; llama-server: the -c flag, e.g. -c 32768; Ollama: raise num_ctx), or by reducing AskLocal context (turn off Auto-read linked articles and Allow background X tabs for extra profile context, or switch to a model with a larger context window)."
  ].join(" ");
}
export function isTrivialFinalAnswer(answer) {
  const text = String(answer || "").trim();
  if (!text || text === "No answer returned.") return true;
  if (text.length > 60) return false;
  return /^(ok(ay)?|sure|done|got it|understood|alright|sounds good|will do|no problem|thanks?|you're welcome)[.!…\s]*$/i.test(text);
}
export function isToolSupportError(status, data) {
  if (![400, 404, 422].includes(status)) return false;
  const detail = extractProviderError(data).toLowerCase();
  return detail.includes("tool")
    || detail.includes("function")
    || detail.includes("tool_choice")
    || detail.includes("unsupported parameter");
}
/** Reasoning models (o-series, some gpt-5 variants) reject any non-default temperature. */
export function isTemperatureSupportError(status, data) {
  if (![400, 422].includes(status)) return false;
  const err = data?.error && typeof data.error === "object" ? data.error : {};
  if (String(err.param || "").toLowerCase() === "temperature") return true;
  return extractProviderError(data).toLowerCase().includes("temperature");
}
export function isToolChoiceSupportError(status, data) {
  if (![400, 404, 422].includes(status)) return false;
  const detail = extractProviderError(data).toLowerCase();
  return detail.includes("tool_choice")
    || detail.includes("tool choice");
}
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

