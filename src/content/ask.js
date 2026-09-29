import { api } from "./api.js";
import {
  appendChatMessage,
  appendStoppedNote,
  attachAssistantMessageActions,
  inferPromptPresetFromQuestion,
  normalizePromptPreset,
  renderFollowupSuggestions,
  renderMessageSources,
  renderPendingStatus,
  resizeComposer,
  scrollChatToBottom,
  scrollChatToBottomIfPinned,
  setRequestStatus
} from "./chat-ui.js";
import {
  renderMarkdownInto
} from "./markdown.js";
import {
  expandAskLocalPanel
} from "./panel-controller.js";
import {
  deactivateContentScript,
  isExtensionContextInvalidated,
  isRuntimeAvailable,
  sendMessage
} from "./runtime.js";
import {
  state
} from "./state.js";
import {
  collectVisibleThread,
  extractQuotedTweet,
  extractTweet
} from "./tweet-extract.js";
import {
  extractStatusIdFromUrl
} from "./tweet-media.js";
import {
  CONVERSATION_ENTRY_LIMIT,
  appendConversationTurn,
  capConversationEntries
} from "../lib/conversation.js";

export function cancelAskRequest(requestId) {
  sendMessage({ type: "CANCEL_ASK", payload: { requestId } }).catch(() => {});
}
export async function askQuestion({ article, host, textarea, messages, status, model, askButton, chatScroll, suggestions, conversationHistory, sessionRef, panelState, promptPreset = "", chatId = "", onTurnComplete = null }) {
  if (panelState.activeRequestId) return;

  const requestId = createRequestId();
  const hasPostContext = Boolean(article);
  const rawQuestion = textarea.value.trim();
  const question = rawQuestion || (hasPostContext ? "Explain this post." : "Answer as a general assistant.");
  const effectivePromptPreset = normalizePromptPreset(promptPreset)
    || inferPromptPresetFromQuestion(question)
    || (!rawQuestion && hasPostContext ? "explain" : "");
  textarea.value = "";
  resizeComposer(textarea);
  suggestions.hidden = true;
  appendChatMessage(messages, "user", question);
  const pending = appendChatMessage(messages, "assistant", "");
  pending.classList.add("pending");
  if (!host?.dataset?.asklocalPage) {
    expandAskLocalPanel(host);
  }
  scrollChatToBottom(chatScroll);

  const requestState = { pending, status, chatScroll };
  state.activeRequests.set(requestId, requestState);
  setRequestStatus(requestState, "Gathering visible context...");
  panelState.activeRequestId = requestId;
  askButton.textContent = "Stop";
  askButton.title = "Stop this request";

  const payload = {
    requestId,
    mediaSessionId: sessionRef.id,
    chatId: String(chatId || "").trim(),
    question,
    promptPreset: effectivePromptPreset,
    // The whole (capped) chat goes along: the background budgets it, and the first
    // turn holds the thread context that follow-ups rely on.
    conversationHistory: capConversationEntries(conversationHistory, CONVERSATION_ENTRY_LIMIT),
    page: {
      url: location.href,
      statusId: extractStatusIdFromUrl(location.href)
    },
    tweet: hasPostContext ? extractTweet(article) : null,
    visibleThread: hasPostContext ? collectVisibleThread(article) : [],
    quotedTweet: hasPostContext ? extractQuotedTweet(article) : null
  };

  const flow = { answerText: "", renderQueued: false, settled: false };

  const renderStreamed = () => {
    if (flow.renderQueued) return;
    flow.renderQueued = true;
    window.requestAnimationFrame(() => {
      flow.renderQueued = false;
      if (flow.settled) return;
      renderMarkdownInto(pending.querySelector(".message-body"), flow.answerText);
      scrollChatToBottomIfPinned(chatScroll);
    });
  };

  const handleDelta = (text) => {
    if (!text || flow.settled) return;
    if (!flow.answerText) {
      pending.classList.remove("pending");
      status.textContent = "";
    }
    flow.answerText += text;
    renderStreamed();
  };

  // The provisionally streamed turn turned out to be a tool call — go back to thinking.
  const handleReset = () => {
    if (flow.settled) return;
    flow.answerText = "";
    pending.classList.add("pending");
    renderPendingStatus(pending, "Working...");
  };

  const finishSuccess = (response) => {
    flow.settled = true;
    model.textContent = response.model;
    model.hidden = false;
    status.textContent = "";
    pending.classList.remove("pending");
    renderMarkdownInto(pending.querySelector(".message-body"), response.answer);
    attachAssistantMessageActions(pending, response.answer);
    appendConversationTurn(conversationHistory, question, response.answer, response.turn);
    renderFollowupSuggestions(suggestions, {
      promptPreset: effectivePromptPreset,
      hasPostContext
    });
    scrollChatToBottom(chatScroll);
    try {
      onTurnComplete?.({
        question,
        answer: response.answer,
        model: response.model,
        conversationHistory
      });
    } catch {
      // Persistence must not break the chat UI.
    }
  };

  const finishFailure = (errorMessage, stopped) => {
    flow.settled = true;
    status.textContent = "";
    pending.classList.remove("pending");
    if (stopped) {
      if (flow.answerText) {
        // Keep the partial answer the user already read instead of discarding it.
        renderMarkdownInto(pending.querySelector(".message-body"), flow.answerText);
        attachAssistantMessageActions(pending, flow.answerText);
        appendStoppedNote(pending);
      } else {
        pending.querySelector(".message-body").textContent = "Stopped.";
      }
      return;
    }
    pending.classList.add("error");
    pending.querySelector(".message-body").textContent = errorMessage || "AskLocal could not get an answer.";
  };

  try {
    setRequestStatus(requestState, "Asking provider...");
    // Cheap round trip that wakes the MV3 service worker: connecting a port to a
    // suspended worker can disconnect immediately instead of waking it (observed live).
    await sendMessage({ type: "GET_SETTINGS" }).catch(() => null);

    const streamed = await askOverPort(payload, {
      requestState,
      pending,
      panelState,
      handleDelta,
      handleReset,
      finishSuccess,
      finishFailure
    });

    if (!streamed) {
      // Port transport unavailable (worker suspended mid-connect, extension just
      // reloaded) — fall back to the one-shot message round trip without streaming.
      const response = await sendMessage({ type: "ASK_LOCAL", payload });
      if (!response?.ok) {
        finishFailure(response?.error, Boolean(response?.stopped));
      } else {
        finishSuccess(response);
        renderMessageSources(pending, response.sources ?? []);
      }
    }
  } catch (error) {
    if (!flow.settled) finishFailure(error.message, false);
  } finally {
    state.activeRequests.delete(requestId);
    panelState.activeRequestId = null;
    panelState.cancel = null;
    askButton.textContent = "Ask";
    askButton.title = "";
    scrollChatToBottom(chatScroll);
    textarea.focus();
  }
}
export function askOverPort(payload, handlers) {
  if (state.disposed || !isRuntimeAvailable()) return Promise.resolve(false);
  let port;
  try {
    port = api.runtime.connect({ name: "asklocal:ask" });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) deactivateContentScript();
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let done = false;
    let gotAnyEvent = false;
    const settle = (handled) => {
      done = true;
      clearInterval(keepalive);
      resolve(handled);
    };

    // Content-script timers throttle in background tabs; the worker also emits
    // keepalive Port traffic. Ping every few seconds anyway as a second belt.
    const keepalive = setInterval(() => {
      if (done) return;
      try {
        port.postMessage({ type: "ping" });
      } catch {
        // Port already gone; the disconnect listener will finalize the request.
      }
    }, 5000);

    handlers.panelState.cancel = () => {
      try {
        port.postMessage({ type: "cancel" });
      } catch {
        // Port already gone; the request is over anyway.
      }
    };

    port.onMessage.addListener((event) => {
      if (!event || typeof event.type !== "string") return;
      gotAnyEvent = true;
      if (event.type === "pong" || event.type === "keepalive") {
        return;
      }
      if (event.type === "status") {
        if (!done && handlers.pending.classList.contains("pending")) {
          setRequestStatus(handlers.requestState, event.message || "Working...");
        }
        return;
      }
      if (event.type === "answer_delta") {
        handlers.handleDelta(event.text);
        return;
      }
      if (event.type === "answer_reset") {
        handlers.handleReset();
        return;
      }
      if (event.type === "answer_done") {
        handlers.finishSuccess(event);
        settle(true);
        return;
      }
      if (event.type === "sources") {
        // Arrives after answer_done (favicon fetching is slow); the listener outlives
        // the resolved promise on purpose.
        renderMessageSources(handlers.pending, event.sources ?? []);
        return;
      }
      if (event.type === "error") {
        handlers.finishFailure(event.error, Boolean(event.stopped));
        settle(true);
      }
    });

    port.onDisconnect.addListener(() => {
      if (done) return;
      if (!gotAnyEvent) {
        // The worker dropped the port before saying anything (suspended mid-connect):
        // report "unhandled" so the caller retries over sendMessage instead of erroring.
        settle(false);
        return;
      }
      handlers.finishFailure("AskLocal lost its connection to the background service.", false);
      settle(true);
    });

    try {
      port.postMessage({ type: "start", payload });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) deactivateContentScript();
      settle(false);
    }
  });
}
export function handleAskLocalProgress(message) {
  const request = state.activeRequests.get(String(message.requestId || ""));
  if (!request) return;
  if (!request.pending.classList.contains("pending")) return;
  setRequestStatus(request, message.message || "Working...");
}
export function createRequestId() {
  return `asklocal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

