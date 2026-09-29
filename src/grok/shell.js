// AskLocal — Grok-clone shell factory.
// Builds the shadow-DOM surface that replaces "rendering over" native Grok:
// a header with [AskLocal][Grok] tabs + actions, and an AskLocal body that
// mirrors Grok's welcome/composer/message-list layout. The AskLocal backend
// (background.js) is wired by content.js via the returned `els`.
//
// The DOM reuses the legacy chat class names (.chat-scroll, .context-post,
// .suggestions, .messages, .message, .message-body, .composer, .primary,
// .status) so the shared rendering helpers (renderMarkdownInto, appendChatMessage,
// renderContextPost, renderMessageSources, renderPendingStatus, resizeComposer,
// scrollChatToBottom, …) apply unchanged.

const POST_SUGGESTIONS = [
  '<button data-preset="explain" data-suggestion="Explain this post">Explain</button>',
  '<button data-preset="fact_check" data-suggestion="Is this true?">Is this true?</button>',
  '<button data-preset="summarize" data-suggestion="Summarize this post">Summarize</button>'
];
const GENERAL_SUGGESTIONS = [];

function create(article) {
  const hasPostContext = Boolean(article);
  const suggestionsMarkup = hasPostContext ? POST_SUGGESTIONS.join("\n            ") : "";
  const placeholder = hasPostContext ? "Ask about this post..." : "Ask a question or check a claim...";

  const root = document.createElement("section");
  root.className = "al-shell";
  root.dataset.mode = "asklocal";
  root.innerHTML = `
      <header class="al-header">
        <div class="al-brand">AskLocal</div>
        <nav class="al-tabs">
          <button type="button" data-tab="asklocal" class="active">AskLocal</button>
          <button type="button" data-tab="grok">Grok</button>
        </nav>
        <div class="al-actions">
          <button type="button" class="al-icon" data-settings-panel title="Settings" aria-label="Settings">Settings</button>
          <button type="button" class="al-close" data-close-panel title="Close" aria-label="Close">&times;</button>
        </div>
      </header>
      <div class="al-body">
        <div class="chat-scroll" data-chat-scroll>
          <div class="context-block" data-context-block${hasPostContext ? "" : " hidden"}>
            <div class="context-post" data-context-post></div>
            <div class="suggestions" data-suggestions${hasPostContext ? "" : " hidden"}>${suggestionsMarkup}</div>
          </div>
          <div class="messages" data-messages></div>
        </div>
        <div class="composer-wrap">
          <div class="status" data-status></div>
          <span data-model hidden>Local context</span>
          <div class="composer">
            <button type="button" class="al-new" data-new-chat title="Create new chat" aria-label="Create new chat">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <textarea placeholder="${placeholder}" rows="1"></textarea>
            <button type="button" class="primary" data-ask>Ask</button>
          </div>
        </div>
      </div>
    `;

  const els = {
    root,
    textarea: root.querySelector("textarea"),
    messages: root.querySelector("[data-messages]"),
    chatScroll: root.querySelector("[data-chat-scroll]"),
    contextBlock: root.querySelector("[data-context-block]"),
    suggestions: root.querySelector("[data-suggestions]"),
    suggestionButtons: [...root.querySelectorAll("[data-suggestion]")],
    status: root.querySelector("[data-status]"),
    model: root.querySelector("[data-model]"),
    askButton: root.querySelector("[data-ask]"),
    contextPost: root.querySelector("[data-context-post]"),
    tabButtons: [...root.querySelectorAll("[data-tab]")],
    newChat: root.querySelector("[data-new-chat]"),
    settings: root.querySelector("[data-settings-panel]"),
    close: root.querySelector("[data-close-panel]")
  };

  function setMode(mode) {
    root.dataset.mode = mode;
    els.tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.tab === mode));
  }

  return { root, els, setMode };
}

export const AskLocalGrokShell = { create, POST_SUGGESTIONS, GENERAL_SUGGESTIONS };
