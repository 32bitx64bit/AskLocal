import { api } from "../api.js";
import {
  ASKLOCAL_VERSION,
  DEFAULT_MULTI_LINKS,
  INVALID_MODEL_OUTPUT_HINT,
  MAX_MULTI_LINKS,
  MIN_MULTI_LINKS,
  OPENAI_TOOL_CALL_LIMIT,
  PROVIDER_FORMAT_RETRY_LIMIT
} from "../constants.js";
import {
  clampNumber,
  formatSeconds,
  normalizeModelText,
  normalizeResponsesOutput,
  normalizeUrlPathname,
  throwIfAborted
} from "../../lib/utils.js";
import {
  formatAnalysisImageLabel,
  formatInlineImageLabel
} from "../media/image.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  resolveRequestBudget
} from "../prompt/budget.js";
import {
  buildSystemPrompt
} from "../prompt/build.js";
import {
  describeContextSizeError,
  describeProviderError,
  extractProviderError,
  fetchWithTransientRetry,
  isContextSizeError,
  isModelOutputFormatError,
  isStreamSupportError,
  isTemperatureSupportError,
  isToolChoiceSupportError,
  isToolSupportError,
  isTrivialFinalAnswer,
  parseProviderResponse
} from "../providers/errors.js";
import {
  normalizeSearchSource
} from "../settings.js";
import {
  resetTurnLinkOpenBudget
} from "../tools/fetch-get.js";
import {
  executeOpenAIToolCall,
  formatToolPlanStatus,
  formatToolResultStatus,
  formatToolStartStatus,
  parseToolArguments
} from "../tools/registry.js";
import {
  evidencePriority,
  renderToolResultForModel
} from "../tools/render.js";
import {
  ANALYZE_IMAGE_TOOL,
  ANALYZE_VIDEO_TOOL,
  GET_TOOL,
  WEB_SEARCH_TOOL,
  X_SEARCH_TOOL
} from "../tools/schemas.js";

export async function callOpenAICompatible(settings, prompt, context, progress) {
  const endpoint = resolveOpenAICompatibleEndpoint(settings.endpoint);
  const headers = {
    "Content-Type": "application/json",
    "X-AskLocal-Version": ASKLOCAL_VERSION
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const budget = context.requestBudget ?? resolveRequestBudget(settings);
  const tools = buildOpenAICompatibleTools(settings);
  const toolsTokens = estimateTokens(JSON.stringify(tools));
  const history = Array.isArray(context.historyMessages) ? context.historyMessages : [];
  const messages = buildOpenAICompatibleMessages(prompt, context.inlineImages ?? [], history);
  // messages = [system, ...history, user, ...this ask's tool exchange]
  let historyCount = history.length;
  context.sentPrompt = prompt;
  prepareToolDiagnostics(context, tools);
  let allowTools = true;
  let includeToolChoice = true;
  let includeTemperature = hasTemperature(settings);
  let streamingSupported = true;
  let toolTurns = 0;
  let retriedTrivialAnswer = false;
  let formatRetries = 0;
  let forceTextAfterInvalidFormat = false;
  let budgetForcedAnswer = false;
  let ignoredForcedToolCalls = false;
  let overflowRecoveries = 0;
  const shortenedToolMessages = new WeakSet();
  let latestToolBatchSize = 0;
  const maxToolTurns = Math.max(1, Math.floor(Number(settings.maxToolTurns) || OPENAI_TOOL_CALL_LIMIT));

  const requestTokens = () => estimateMessagesTokens(messages) + (allowTools ? toolsTokens : 0);

  // Shrink tool results until the request fits. Order matters: results from earlier
  // turns go first (oldest first), and the newest turn's results are only trimmed as a
  // last resort, because the model has not read them yet. `keep` is how many chars
  // a shrunken result retains.
  const shortenToolMessages = (targetTokens, { includeLatest = false } = {}) => {
    let total = requestTokens();
    const toolMessages = messages.filter((message) => message.role === "tool");
    const latestStart = toolMessages.length - latestToolBatchSize;
    const candidates = toolMessages.filter((_, index) => includeLatest || index < latestStart);
    for (const message of candidates) {
      if (total <= targetTokens) break;
      const before = estimateMessageTokens(message);
      const isLatest = toolMessages.indexOf(message) >= latestStart;
      const keep = shortenedToolMessages.has(message) ? 200 : isLatest ? 2000 : 700;
      message.content = shortenToolContent(message.content, keep);
      shortenedToolMessages.add(message);
      total -= before - estimateMessageTokens(message);
    }
    return total;
  };

  const recoverFromContextOverflow = async () => {
    if (overflowRecoveries >= 4) return false;
    overflowRecoveries += 1;
    context.emitAnswerReset?.();
    if (messages.some((message) => message.role === "tool" && estimateMessageTokens(message) > 220)) {
      shortenToolMessages(0, { includeLatest: true });
      budgetForcedAnswer = true;
      await progress?.("Context window is full; answering from what was gathered...");
      return true;
    }
    if (historyCount >= 2) {
      messages.splice(1, 2);
      historyCount -= 2;
      await progress?.("Context window is full; dropping the oldest chat turn and retrying...");
      return true;
    }
    const smaller = typeof context.shrinkPrompt === "function" ? context.shrinkPrompt() : "";
    if (smaller) {
      setUserMessageText(messages[1 + historyCount], smaller);
      context.sentPrompt = smaller;
      await progress?.("Context window is full; trimming the post context and retrying...");
      return true;
    }
    return false;
  };

  const recoverFromInvalidModelOutput = async (data, extraMessage = "") => {
    if (!isModelOutputFormatError(data, extraMessage)) return false;
    context.emitAnswerReset?.();
    if (formatRetries < PROVIDER_FORMAT_RETRY_LIMIT) {
      formatRetries += 1;
      await progress?.(`Model output was invalid; asking it to retry (${formatRetries} of ${PROVIDER_FORMAT_RETRY_LIMIT})...`);
      if (formatRetries === 1) {
        messages.push({ role: "user", content: INVALID_MODEL_OUTPUT_HINT });
      }
      return true;
    }
    if (!forceTextAfterInvalidFormat && allowTools) {
      forceTextAfterInvalidFormat = true;
      await progress?.("Model could not produce a valid tool call; answering from gathered context...");
      messages.push({
        role: "user",
        content: "Your previous tool calls were rejected as invalid format. Do not call tools. Using the conversation and any tool results already gathered, write the complete final answer now."
      });
      return true;
    }
    return false;
  };

  while (toolTurns <= maxToolTurns) {
    throwIfAborted(context.abortSignal);
    // Keep the whole request inside the input budget: shorten old tool results first,
    // and if that is not enough, stop calling tools and answer from what is here.
    if (requestTokens() > budget.inputTokens) {
      let total = shortenToolMessages(budget.inputTokens);
      // Still over: trim the newest results too, but keep the model's next call
      // (an answer) possible instead of dropping their content entirely.
      if (total > budget.inputTokens && toolTurns > 0) {
        total = shortenToolMessages(budget.inputTokens, { includeLatest: true });
        budgetForcedAnswer = true;
      }
    }
    const wantStream = streamingSupported && typeof context.emitAnswerDelta === "function";
    const forcedAnswer = toolTurns >= maxToolTurns || retriedTrivialAnswer || forceTextAfterInvalidFormat || budgetForcedAnswer;
    const status = forceTextAfterInvalidFormat
      ? "Answering from gathered context..."
      : formatRetries > 0
        ? `Model output was invalid; asking it to retry (${formatRetries} of ${PROVIDER_FORMAT_RETRY_LIMIT})...`
        : toolTurns === 0
          ? "Asking model..."
          : forcedAnswer
            ? "Answering from gathered context..."
            : "Asking model to answer from gathered context...";
    await progress?.(status);
    let response;
    let data;
    try {
      response = await fetchWithTransientRetry(endpoint, {
        method: "POST",
        headers,
        signal: context.abortSignal,
        // Forced-answer turns keep the tools field and forbid calls via tool_choice
        // "none" instead of omitting tools: the tools JSON is serialized into the chat
        // template ahead of the messages, so dropping it would invalidate the prefix
        // cache for the whole (longest) context right at the final turn. Tools are only
        // omitted when the provider already rejected tool_choice or tools.
        body: JSON.stringify(buildOpenAICompatibleRequest(settings, messages, {
          tools: allowTools && (!forcedAnswer || includeToolChoice) ? tools : null,
          toolChoice: forcedAnswer
            ? (includeToolChoice ? "none" : false)
            : (includeToolChoice ? "auto" : false),
          stream: wantStream,
          temperature: includeTemperature ? settings.temperature : undefined
        }))
      }, { progress });

      // A turn's nature (tool call vs. final answer) is only known once deltas arrive, so
      // every turn streams; tool-call fragments are accumulated silently while content
      // deltas are forwarded live. The stream is folded back into the same response shape
      // the non-streaming loop already handles.
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      data = response.ok && wantStream && contentType.includes("text/event-stream")
        ? await readOpenAICompatibleStream(response, context, progress)
        : await parseProviderResponse(response);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throwIfAborted(context.abortSignal);
      if (await recoverFromInvalidModelOutput({ error: { message: error?.message } }, error?.message)) {
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      if (wantStream && isStreamSupportError(response.status, data)) {
        streamingSupported = false;
        continue;
      }
      // Checked before the tool checks: "Unsupported parameter: temperature" would
      // otherwise read as a tools rejection.
      if (includeTemperature && isTemperatureSupportError(response.status, data)) {
        includeTemperature = false;
        continue;
      }
      if (isContextSizeError(data)) {
        if (await recoverFromContextOverflow()) continue;
        throw new Error(describeContextSizeError(data));
      }
      if (allowTools && includeToolChoice && isToolChoiceSupportError(response.status, data)) {
        context.toolDiagnostics.toolChoiceRejected = true;
        includeToolChoice = false;
        continue;
      }
      if (allowTools && isToolSupportError(response.status, data)) {
        // Models without tool support can still answer from the provided context.
        context.toolDiagnostics.toolsRejected = true;
        allowTools = false;
        await progress?.("This model does not support tools; answering from the provided context...");
        continue;
      }
      if (await recoverFromInvalidModelOutput(data)) continue;
      throw new Error(describeContextSizeError(data) || `Provider request failed: ${describeProviderError(response.status, data)}`);
    }

    const toolCalls = allowTools ? normalizeOpenAIToolCalls(data) : [];
    recordToolResponseDiagnostics(context, data, toolCalls);
    // If provisional content was streamed to the panel but the turn turned out to be a
    // tool turn (including tool calls parsed out of plain content), retract it.
    if (toolCalls.length > 0 && (data?.__asklocalStreamedChars ?? 0) > 0) {
      context.emitAnswerReset?.();
    }
    if (toolCalls.length > 0 && forcedAnswer) {
      // Some servers ignore tool_choice "none". Never run tools on a forced-answer
      // turn (the budget or turn limit said stop); ask once more for plain text.
      context.emitAnswerReset?.();
      if (ignoredForcedToolCalls) {
        throw new Error("Provider kept requesting tools past the limit; unable to produce a final answer.");
      }
      ignoredForcedToolCalls = true;
      messages.push({
        role: "user",
        content: "Tools are no longer available for this answer. Using the conversation and the tool results already gathered, write the complete final answer now."
      });
      continue;
    }
    if (toolCalls.length === 0) {
      const answer = extractOpenAICompatibleAnswer(data);
      // Small models sometimes close a long tool exchange with a bare acknowledgment
      // ("Ok.") instead of an answer. Retract it and demand the real answer once,
      // with tools disabled so this turn can only produce text.
      if (toolTurns > 0 && !retriedTrivialAnswer && isTrivialFinalAnswer(answer)) {
        retriedTrivialAnswer = true;
        context.emitAnswerReset?.();
        messages.push({ role: "assistant", content: answer });
        messages.push({
          role: "user",
          content: "That was an acknowledgment, not an answer. Using the conversation and the tool results already gathered above, write the complete final answer to the original user question now."
        });
        continue;
      }
      await progress?.("Model finished answering.");
      return answer;
    }

    await progress?.(formatToolPlanStatus(toolCalls));
    const assistantMessage = data?.choices?.[0]?.message ?? {};
    messages.push(normalizeAssistantToolMessage(assistantMessage, toolCalls));

    resetTurnLinkOpenBudget(context, settings);
    const toolResults = await executeToolCallsForTurn(toolCalls, context, settings, progress);
    latestToolBatchSize = toolResults.length;
    for (const entry of toolResults) {
      const name = entry.toolCall.function.name;
      const content = renderToolResultForModel(name, entry.result, context, { maxChars: budget.toolResultChars });
      messages.push({
        role: "tool",
        tool_call_id: entry.toolCall.id,
        content
      });
      recordToolEvidence(context, name, entry.result, content);
    }

    toolTurns += 1;
  }

  // Should be unreachable: the forced-answer turn (toolTurns >= maxToolTurns)
  // forbids tool calls, and any calls it returns anyway are refused above.
  throw new Error("Provider kept requesting tools past the limit; unable to produce a final answer.");
}
function hasTemperature(settings) {
  return typeof settings.temperature === "number" && Number.isFinite(settings.temperature);
}
function setUserMessageText(message, text) {
  if (!message) return;
  if (Array.isArray(message.content)) {
    const part = message.content.find((item) => item?.type === "text");
    if (part) part.text = text;
  } else {
    message.content = text;
  }
}
function shortenToolContent(content, keep = 700) {
  const text = String(content || "");
  if (text.length <= keep) return text;
  const cut = text.lastIndexOf("\n", keep);
  const head = text.slice(0, cut > keep * 0.5 ? cut : keep).trimEnd();
  return `${head}\n[…shortened to fit the context window]`;
}
/** Successful, new tool results become evidence the next turn can build on. */
function recordToolEvidence(context, name, result, content) {
  const priority = evidencePriority(name);
  if (!priority || !result?.ok || result.duplicate || result.reusedFromContext) return;
  if ((name === "get" || name === "read_thread") && result.cached && !result.batch) return;
  context.toolEvidence ??= [];
  context.toolEvidence.push({ name, priority, text: content });
}
export function resolveOpenAICompatibleEndpoint(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("OpenAI-compatible endpoint is required.");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OpenAI-compatible endpoint must be a valid URL.");
  }
  const pathname = normalizeUrlPathname(url.pathname);
  if (pathname.endsWith("/responses")) {
    throw new Error("Use a /v1 base URL or a /chat/completions URL for OpenAI-compatible providers.");
  }

  if (pathname.endsWith("/chat/completions")) {
    url.pathname = pathname;
    return url.href;
  }

  if (pathname.endsWith("/v1")) {
    url.pathname = `${pathname}/chat/completions`;
    return url.href;
  }

  if (pathname === "/") {
    url.pathname = "/v1/chat/completions";
    return url.href;
  }

  url.pathname = `${pathname}/v1/chat/completions`;
  return url.href;
}
export function buildOpenAICompatibleMessages(prompt, inlineImages = [], historyMessages = []) {
  const normalizedImages = Array.isArray(inlineImages) ? inlineImages.filter((image) => image?.dataUrl) : [];
  const userContent = normalizedImages.length
    ? [
      { type: "text", text: prompt },
      ...normalizedImages.flatMap((image, index) => [
        {
          type: "text",
          text: formatInlineImageLabel(image, index)
        },
        {
          type: "image_url",
          image_url: {
            url: image.dataUrl
          }
        }
      ])
    ]
    : prompt;

  return [
    { role: "system", content: buildSystemPrompt() },
    // Prior turns go in as real alternating messages (see prompt/history.js): each
    // user turn replays the exact context it was asked with, so follow-ups see the
    // thread and earlier tool results, and the prefix stays cacheable.
    ...(Array.isArray(historyMessages) ? historyMessages : [])
      .map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: userContent }
  ];
}
export function buildOpenAICompatibleRequest(settings, messages, options = {}) {
  const request = {
    model: settings.model,
    stream: Boolean(options.stream),
    messages
  };

  const tools = Array.isArray(options.tools)
    ? options.tools
    : options.tools ? buildOpenAICompatibleTools(settings) : null;
  if (tools?.length) {
    request.tools = tools;
    if (options.toolChoice !== false) request.tool_choice = options.toolChoice || "auto";
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    request.temperature = options.temperature;
  }

  return request;
}
export async function* iterateStreamLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) yield line;
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released by an aborted fetch.
    }
  }
}
export async function readOpenAICompatibleStream(response, context, progress) {
  const toolCallsByIndex = [];
  let content = "";
  let finishReason = "";
  let streamedChars = 0;
  let sawToolCalls = false;
  let announcedTools = false;

  for await (const line of iterateStreamLines(response.body)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed?.error) {
      throw new Error(describeContextSizeError(parsed) || `Provider stream failed: ${extractProviderError(parsed) || "unknown stream error"}`);
    }

    const choice = parsed?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      sawToolCalls = true;
      const index = Number.isFinite(fragment?.index) ? fragment.index : 0;
      toolCallsByIndex[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (fragment.id) toolCallsByIndex[index].id = fragment.id;
      if (fragment.function?.name) toolCallsByIndex[index].function.name += fragment.function.name;
      if (typeof fragment.function?.arguments === "string") {
        toolCallsByIndex[index].function.arguments += fragment.function.arguments;
      }
    }
    if (sawToolCalls && !announcedTools) {
      announcedTools = true;
      await progress?.("Model is requesting tools...");
    }

    const chunk = typeof delta.content === "string" ? delta.content : "";
    if (chunk) {
      content += chunk;
      if (!sawToolCalls) {
        streamedChars += chunk.length;
        context.emitAnswerDelta?.(chunk);
      }
    }
  }

  const message = { content: content || null };
  const toolCalls = toolCallsByIndex
    .filter(Boolean)
    .map((toolCall, index) => ({
      id: toolCall.id || `call_${index + 1}`,
      type: "function",
      function: toolCall.function
    }))
    .filter((toolCall) => toolCall.function.name);
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    __asklocalStreamedChars: streamedChars,
    choices: [{ finish_reason: finishReason, message }]
  };
}
export function buildOpenAICompatibleTools(settings) {
  const tools = [];
  const source = normalizeSearchSource(settings.backgroundSearchSource);
  const maxMultiLinks = Math.floor(clampNumber(
    settings.maxMultiLinks,
    MIN_MULTI_LINKS,
    MAX_MULTI_LINKS,
    DEFAULT_MULTI_LINKS
  ));

  if (settings.allowBackgroundSearch && (source === "x" || source === "both")) {
    tools.push(X_SEARCH_TOOL);
  }

  if (settings.allowBackgroundSearch && (source === "web" || source === "both")) {
    tools.push(WEB_SEARCH_TOOL);
  }

  if (settings.allowImageAnalysis) tools.push(ANALYZE_IMAGE_TOOL);
  if (settings.allowVideoAnalysis) tools.push(ANALYZE_VIDEO_TOOL);
  tools.push(buildGetToolSchema(maxMultiLinks));
  return tools;
}

function buildGetToolSchema(maxMultiLinks) {
  const tool = JSON.parse(JSON.stringify(GET_TOOL));
  tool.function.description = `${GET_TOOL.function.description} At most ${maxMultiLinks} per turn.`;
  if (tool.function.parameters?.properties?.ids) tool.function.parameters.properties.ids.maxItems = maxMultiLinks;
  if (tool.function.parameters?.properties?.urls) tool.function.parameters.properties.urls.maxItems = maxMultiLinks;
  return tool;
}

/**
 * Execute tool calls for one model turn. All `get` calls run in parallel under the
 * shared multi-link budget; all other tools stay sequential.
 */
export async function executeToolCallsForTurn(toolCalls, context, settings, progress) {
  const results = new Array(toolCalls.length);
  const getEntries = [];
  const otherEntries = [];

  toolCalls.forEach((toolCall, index) => {
    if (toolCall.function.name === "get") getEntries.push({ toolCall, index });
    else otherEntries.push({ toolCall, index });
  });

  if (getEntries.length) {
    await progress?.(
      getEntries.length > 1
        ? `Opening ${getEntries.length} sources in parallel...`
        : formatToolStartStatus("get", parseToolArguments(getEntries[0].toolCall.function.arguments))
    );
    await Promise.all(getEntries.map(async (entry) => {
      throwIfAborted(context.abortSignal);
      const args = parseToolArguments(entry.toolCall.function.arguments);
      if (getEntries.length > 1) {
        await progress?.(formatToolStartStatus("get", args));
      }
      const result = await executeOpenAIToolCall(entry.toolCall, context, settings, args);
      await progress?.(formatToolResultStatus("get", result));
      results[entry.index] = { toolCall: entry.toolCall, result };
    }));
  }

  for (const entry of otherEntries) {
    throwIfAborted(context.abortSignal);
    const args = parseToolArguments(entry.toolCall.function.arguments);
    await progress?.(formatToolStartStatus(entry.toolCall.function.name, args));
    const result = await executeOpenAIToolCall(entry.toolCall, context, settings, args);
    await progress?.(formatToolResultStatus(entry.toolCall.function.name, result));
    results[entry.index] = { toolCall: entry.toolCall, result };
  }

  return results;
}
export function prepareToolDiagnostics(context, tools) {
  context.toolDiagnostics.offered = (tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  return tools;
}
export function recordToolResponseDiagnostics(context, data, toolCalls) {
  context.toolDiagnostics.responseTurns.push({
    finishReason: data?.choices?.[0]?.finish_reason || "",
    toolCallCount: toolCalls.length
  });

  if (toolCalls.length > 0) {
    context.toolDiagnostics.calls.push(...toolCalls.map((toolCall) => toolCall.function.name));
  }
}
export function extractOpenAICompatibleAnswer(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content ?? data?.choices?.[0]?.text ?? data?.output_text;
  const normalized = normalizeModelText(content);
  if (normalized) return normalized;

  const responseOutput = normalizeResponsesOutput(data?.output);
  if (responseOutput) return responseOutput;

  return "No answer returned.";
}
export function normalizeOpenAIToolCalls(data) {
  const message = data?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  if (toolCalls.length > 0) {
    return toolCalls
      .map((toolCall, index) => normalizeToolCall(toolCall, index))
      .filter((toolCall) => toolCall.function.name);
  }

  if (message?.function_call?.name) {
    return [normalizeToolCall({
      id: "legacy_function_call",
      function: message.function_call
    }, 0)];
  }

  const contentToolCalls = normalizeContentToolCalls(normalizeModelText(message?.content));
  if (contentToolCalls.length > 0) return contentToolCalls;

  return [];
}
export function normalizeContentToolCalls(content) {
  const text = String(content || "").trim();
  if (!text) return [];

  const candidates = [];
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    candidates.push(match[1]);
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  if (/^\s*[\[{]/.test(text)) candidates.push(text);

  return candidates
    .flatMap(parseContentToolCallCandidate)
    .map((toolCall, index) => normalizeToolCall(toolCall, index))
    .filter((toolCall) => toolCall.function.name);
}
export function parseContentToolCallCandidate(candidate) {
  try {
    return normalizeContentToolCallValue(JSON.parse(candidate));
  } catch {
    return [];
  }
}
export function normalizeContentToolCallValue(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeContentToolCallValue);
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value.tool_calls)) return value.tool_calls.flatMap(normalizeContentToolCallValue);
  if (value.function?.name) return [value];
  if (value.name || value.tool || value.function_name) {
    return [{
      id: value.id,
      function: {
        name: value.name || value.tool || value.function_name,
        arguments: value.arguments ?? value.args ?? value.parameters ?? {}
      }
    }];
  }

  return [];
}
export function normalizeToolCall(toolCall, index) {
  const fn = toolCall.function ?? {};
  return {
    id: String(toolCall.id || `call_${index + 1}`),
    type: "function",
    function: {
      name: String(fn.name || ""),
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {})
    }
  };
}
export function normalizeAssistantToolMessage(message, toolCalls) {
  const hasNativeToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  return {
    role: "assistant",
    content: hasNativeToolCalls ? normalizeModelText(message.content) || null : null,
    tool_calls: toolCalls
  };
}
export async function callOpenAICompatibleMediaAnalysis(providerSettings, request) {
  const endpoint = resolveOpenAICompatibleEndpoint(providerSettings.endpoint);
  const headers = {
    "Content-Type": "application/json",
    "X-AskLocal-Version": ASKLOCAL_VERSION
  };
  if (providerSettings.apiKey) headers.Authorization = `Bearer ${providerSettings.apiKey}`;

  const userContent = [
    { type: "text", text: request.prompt },
    ...(request.images ?? []).flatMap((image, index) => [
      {
        type: "text",
        text: formatAnalysisImageLabel(image, index)
      },
      {
        type: "image_url",
        image_url: {
          url: image.dataUrl
        }
      }
    ])
  ];

  const response = await fetchWithTransientRetry(endpoint, {
    method: "POST",
    headers,
    signal: request.signal,
    body: JSON.stringify({
      model: providerSettings.model,
      stream: false,
      messages: [
        {
          role: "system",
          content: request.systemPrompt
            || (request.kind === "video"
              ? "You are a precise multimodal evidence extractor for AskLocal. Prefer compact change-based notes over per-frame dumps. Never invent audio or off-screen events. Do not write the final user-facing answer."
              : "You are a precise multimodal evidence extractor for AskLocal. Look at every provided image/frame and write detailed factual visual descriptions: what is happening, scene/setting, people/objects, and exact on-screen text/captions. Be thorough and uncertainty-aware. Never invent audio or off-screen events. Do not write the final user-facing answer.")
        },
        {
          role: "user",
          content: userContent
        }
      ]
    })
  });

  const data = await parseProviderResponse(response);
  if (!response.ok) {
    throw new Error(`Media analysis request failed: ${describeProviderError(response.status, data)}`);
  }
  return extractOpenAICompatibleAnswer(data);
}

export async function callOpenAICompatibleAudioAnalysis(providerSettings, request) {
  const endpoint = resolveOpenAICompatibleEndpoint(providerSettings.endpoint);
  const headers = {
    "Content-Type": "application/json",
    "X-AskLocal-Version": ASKLOCAL_VERSION
  };
  if (providerSettings.apiKey) headers.Authorization = `Bearer ${providerSettings.apiKey}`;

  const audioParts = (request.audioChunks ?? []).flatMap((chunk, index) => {
    const base64 = String(chunk.base64 || "").trim();
    if (!base64) return [];
    return [
      {
        type: "text",
        text: formatAnalysisAudioLabel(chunk, index)
      },
      {
        type: "input_audio",
        input_audio: {
          data: base64,
          format: String(chunk.format || "wav")
        }
      }
    ];
  });

  const userContent = [
    { type: "text", text: request.prompt },
    ...audioParts
  ];

  const body = {
    model: providerSettings.model,
    stream: false,
    messages: [
      {
        role: "system",
        content: "You are a precise audio evidence extractor for AskLocal. Listen to every provided audio clip and write detailed factual notes: timestamped transcript, speakers when distinguishable, language, tone, music, sound effects, and ambience. Be thorough and uncertainty-aware. Never invent speech or sounds that are not audible. Do not write the final user-facing answer."
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };
  if (audioParts.length) body.modalities = ["text", "audio"];

  const response = await fetchWithTransientRetry(endpoint, {
    method: "POST",
    headers,
    signal: request.signal,
    body: JSON.stringify(body)
  });

  const data = await parseProviderResponse(response);
  if (!response.ok) {
    throw new Error(`Audio analysis request failed: ${describeProviderError(response.status, data)}`);
  }
  return extractOpenAICompatibleAnswer(data);
}

function formatAnalysisAudioLabel(chunk, index) {
  const range = chunk.rangeLabel
    || [chunk.startSeconds, chunk.endSeconds]
      .filter((value) => Number.isFinite(Number(value)))
      .map((value) => formatSeconds(value))
      .join("-");
  return `Audio ${index + 1}${range ? ` (${range})` : ""}: ${chunk.label || "video audio chunk"}`;
}

