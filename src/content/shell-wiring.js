import { api } from "./api.js";
import { AskLocalGrokShell } from "../grok/shell.js";
import {
  askQuestion,
  cancelAskRequest,
  createRequestId
} from "./ask.js";
import {
  normalizePromptPreset,
  renderContextPost,
  resizeComposer
} from "./chat-ui.js";
import {
  createChatId,
  upsertConversation
} from "./history-client.js";
import {
  collapseShell,
  releaseMediaSession
} from "./panel-controller.js";
import {
  extractTweet
} from "./tweet-extract.js";

export function wireShell(host, article, els) {
  const { textarea, messages, status, model, askButton, chatScroll, suggestions, contextBlock, contextPost, root } = els;
  let currentArticle = article;
  const conversationHistory = [];
  const sessionRef = { id: createRequestId() };
  const panelState = { activeRequestId: null, cancel: null };
  let chatId = createChatId();
  host.dataset.asklocalMediaSessionId = sessionRef.id;

  const POST_SUGGESTIONS = AskLocalGrokShell?.POST_SUGGESTIONS || [];

  const renderContext = (art) => {
    if (art) {
      if (contextBlock) contextBlock.hidden = false;
      renderContextPost(contextPost, extractTweet(art));
      contextPost.hidden = false;
      suggestions.innerHTML = POST_SUGGESTIONS.join("");
      suggestions.hidden = POST_SUGGESTIONS.length === 0;
    } else {
      if (contextBlock) contextBlock.hidden = true;
      contextPost.hidden = true;
      suggestions.textContent = "";
      suggestions.hidden = true;
    }
  };
  renderContext(currentArticle);

  const persist = (responseModel = "") => {
    const tweet = currentArticle ? extractTweet(currentArticle) : null;
    void upsertConversation({
      chatId,
      messages: conversationHistory,
      source: currentArticle ? "post" : "panel",
      context: tweet ? {
        url: tweet.url || "",
        statusId: tweet.statusId || "",
        handle: tweet.handle || "",
        text: String(tweet.text || "").slice(0, 280)
      } : null,
      model: responseModel
    });
  };

  const ask = (options = {}) => {
    askQuestion({
      article: currentArticle,
      host,
      textarea,
      messages,
      status,
      model,
      askButton,
      chatScroll,
      suggestions,
      conversationHistory,
      sessionRef,
      panelState,
      chatId,
      promptPreset: normalizePromptPreset(options.promptPreset),
      onTurnComplete: ({ model: responseModel }) => persist(responseModel)
    });
  };

  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggestion]");
    if (!button) return;
    textarea.value = button.dataset.suggestion;
    resizeComposer(textarea);
    ask({ promptPreset: button.dataset.preset });
  });

  askButton.addEventListener("click", () => {
    if (panelState.activeRequestId) {
      if (panelState.cancel) panelState.cancel();
      else cancelAskRequest(panelState.activeRequestId);
      return;
    }
    ask();
  });

  textarea.addEventListener("input", () => resizeComposer(textarea));
  textarea.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask();
    }
  });

  root.__asklocalReset = (newArticle) => {
    if (panelState.activeRequestId) return;
    releaseMediaSession(sessionRef.id);
    sessionRef.id = createRequestId();
    chatId = createChatId();
    host.dataset.asklocalMediaSessionId = sessionRef.id;
    conversationHistory.length = 0;
    messages.textContent = "";
    suggestions.hidden = false;
    status.textContent = "";
    model.hidden = true;
    textarea.value = "";
    resizeComposer(textarea);
    if (newArticle !== undefined) currentArticle = newArticle;
    renderContext(currentArticle);
    collapseShell();
    textarea.focus();
  };
  root.__asklocalSetContext = (newArticle) => {
    currentArticle = newArticle;
    renderContext(currentArticle);
  };

  window.setTimeout(() => {
    textarea.focus();
    resizeComposer(textarea);
  }, 0);

  return { conversationHistory, sessionRef, panelState, getChatId: () => chatId };
}
