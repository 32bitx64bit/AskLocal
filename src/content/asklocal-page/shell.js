import { AskLocalPageStyles } from "./styles.js";

export function createAskLocalPageHost() {
  const host = document.createElement("div");
  host.dataset.asklocalPage = "true";
  host.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "pointer-events:auto",
    "display:none"
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = AskLocalPageStyles;
  shadow.appendChild(style);

  const root = document.createElement("section");
  root.className = "al-page";
  // Match /i/grok: centered chat volume + empty right rail equal to the left sidebar.
  root.innerHTML = `
    <div class="al-page-volume">
      <header class="al-page-header">
        <div class="al-brand">AskLocal</div>
        <button type="button" data-new-chat title="New chat">New</button>
        <button type="button" data-open-history title="Chat history">History</button>
        <button type="button" data-open-settings title="Settings">Settings</button>
      </header>
      <div class="al-page-body">
        <div class="al-view al-view-chat is-empty active" data-view="chat">
          <div class="al-welcome" data-welcome>
            <h1>AskLocal</h1>
            <p>Ask general questions with your local or configured provider. Chats stay on this device.</p>
          </div>
          <div class="al-chat-scroll" data-chat-scroll hidden>
            <div class="messages" data-messages></div>
          </div>
          <div class="al-composer-dock">
            <div class="al-composer-card">
              <textarea data-textarea placeholder="Ask anything" rows="1"></textarea>
              <div class="al-composer-toolbar">
                <div class="status" data-status></div>
                <select data-model-select aria-label="Main text model" hidden></select>
                <span data-model hidden></span>
                <button type="button" class="secondary" data-new-chat-inline>New chat</button>
                <button type="button" data-ask>Ask</button>
              </div>
            </div>
          </div>
        </div>
        <div class="al-view al-view-settings" data-view="settings">
          <iframe class="al-settings-frame" data-settings-frame title="AskLocal Settings"></iframe>
        </div>
        <div class="al-history-backdrop" data-history-backdrop hidden></div>
        <aside class="al-history-drawer" data-history-drawer hidden>
          <header>
            <h2>History</h2>
            <button type="button" data-clear-history title="Clear all">Clear</button>
            <button type="button" data-close-history aria-label="Close">Close</button>
          </header>
          <div class="al-history-search">
            <input type="search" data-history-search placeholder="Search AskLocal history" />
          </div>
          <div class="al-history-list" data-history-list>
            <div class="al-history-empty">No saved chats yet.</div>
          </div>
        </aside>
      </div>
    </div>
    <div class="al-page-rail" data-page-rail aria-hidden="true"></div>
  `;
  shadow.appendChild(root);

  const els = {
    host,
    root,
    volume: root.querySelector(".al-page-volume"),
    rail: root.querySelector("[data-page-rail]"),
    brand: root.querySelector(".al-brand"),
    newChat: root.querySelector("[data-new-chat]"),
    newChatInline: root.querySelector("[data-new-chat-inline]"),
    openHistory: root.querySelector("[data-open-history]"),
    openSettings: root.querySelector("[data-open-settings]"),
    chatView: root.querySelector('[data-view="chat"]'),
    settingsView: root.querySelector('[data-view="settings"]'),
    welcome: root.querySelector("[data-welcome]"),
    chatScroll: root.querySelector("[data-chat-scroll]"),
    messages: root.querySelector("[data-messages]"),
    textarea: root.querySelector("[data-textarea]"),
    status: root.querySelector("[data-status]"),
    model: root.querySelector("[data-model]"),
    modelSelect: root.querySelector("[data-model-select]"),
    askButton: root.querySelector("[data-ask]"),
    settingsFrame: root.querySelector("[data-settings-frame]"),
    historyBackdrop: root.querySelector("[data-history-backdrop]"),
    historyDrawer: root.querySelector("[data-history-drawer]"),
    historyList: root.querySelector("[data-history-list]"),
    historySearch: root.querySelector("[data-history-search]"),
    closeHistory: root.querySelector("[data-close-history]"),
    clearHistory: root.querySelector("[data-clear-history]")
  };

  return { host, shadow, root, els };
}
