import {
  askQuestion,
  cancelAskRequest,
  createRequestId
} from "../ask.js";
import {
  appendChatMessage,
  resizeComposer
} from "../chat-ui.js";
import {
  clearChats,
  createChatId,
  deleteChat,
  getChat,
  listChats,
  upsertConversation
} from "../history-client.js";
import {
  renderMarkdownInto
} from "../markdown.js";
import {
  getRuntimeUrl,
  sendMessage
} from "../runtime.js";
import {
  createAskLocalPageHost
} from "./shell.js";
import {
  getAskLocalView,
  isAskLocalPath,
  navigateAskLocal
} from "./router.js";
import {
  capConversationInPlace,
  toConversationEntry
} from "../../lib/conversation.js";

let page = null;
const PAGE_ACTIVE_ATTR = "data-asklocal-page-active";
const PAGE_VISIBILITY_STYLE_ID = "asklocal-page-visibility-style";
const ASKLOCAL_DOCUMENT_TITLE = "AskLocal / X";
let savedDocumentTitle = null;
let titleGuard = null;

function ensurePageVisibilityStyle() {
  if (document.getElementById(PAGE_VISIBILITY_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PAGE_VISIBILITY_STYLE_ID;
  // Own the full content canvas beside the primary nav — same slot /i/grok uses —
  // so the center feed and right rail both get out of the way.
  style.textContent = `
    html[${PAGE_ACTIVE_ATTR}] [data-testid="primaryColumn"],
    html[${PAGE_ACTIVE_ATTR}] [data-testid="sidebarColumn"] {
      pointer-events: none !important;
      visibility: hidden !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function luminance(color) {
  const match = String(color || "").match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return null;
  const channels = match.slice(1, 4).map((value) => Number(value) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function currentTheme() {
  const column = document.querySelector('[data-testid="primaryColumn"]');
  const candidates = [column, document.body, document.documentElement].filter(Boolean);
  for (const element of candidates) {
    const styles = window.getComputedStyle(element);
    if (styles.colorScheme === "dark") return "dark";
    if (styles.colorScheme === "light") return "light";

    const value = luminance(styles.backgroundColor);
    if (value !== null) return value < 0.3 ? "dark" : "light";
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncTheme() {
  const host = page?.host;
  if (!host) return;
  const theme = currentTheme();
  host.dataset.asklocalTheme = theme;
  const frame = page.els?.settingsFrame;
  if (!frame?.contentWindow) return;
  let targetOrigin = "*";
  try {
    targetOrigin = new URL(getRuntimeUrl("options.html")).origin;
  } catch {
    // The frame may not be available while the extension is being reloaded.
  }
  frame.contentWindow.postMessage({ type: "ASKLOCAL_SET_THEME", theme }, targetOrigin);
}

/**
 * Full viewport strip to the right of X's left nav — matches /i/grok's canvas,
 * not the narrow primaryColumn feed width.
 */
function leftRailRightEdge() {
  const nav = document.querySelector('nav[aria-label="Primary"]');
  if (!nav) return 0;

  let best = nav.getBoundingClientRect().right;
  let el = nav.parentElement;
  for (let depth = 0; el && el !== document.body && depth < 8; depth += 1) {
    const rect = el.getBoundingClientRect();
    if (rect.left <= 16 && rect.width > 0 && rect.width < 420) {
      best = Math.max(best, rect.right);
    }
    if (rect.width > window.innerWidth * 0.5) break;
    el = el.parentElement;
  }
  return Math.round(best);
}

function contentAreaRect() {
  // Keep a minimum left inset so a missing nav never lets us cover the rail.
  const rail = leftRailRightEdge();
  const left = Math.max(88, Math.min(rail || 88, window.innerWidth - 320));
  return {
    left,
    top: 0,
    width: Math.max(320, window.innerWidth - left),
    height: window.innerHeight,
    railWidth: Math.max(88, rail || 88)
  };
}

function positionHost(host, root = page?.els?.root) {
  const rect = contentAreaRect();
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;

  // Mirror the left sidebar on the right so the chat volume sits centered,
  // matching /i/grok. Drop the mirror when the remaining volume would be too tight.
  if (root) {
    const mirror = rect.width > rect.railWidth + 520 ? rect.railWidth : 0;
    root.style.setProperty("--asklocal-mirror-rail", `${mirror}px`);
  }
}

function formatWhen(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function ensurePage() {
  if (page) return page;

  const { host, els } = createAskLocalPageHost();
  document.documentElement.appendChild(host);

  const session = {
    chatId: createChatId(),
    conversationHistory: [],
    sessionRef: { id: createRequestId() },
    panelState: { activeRequestId: null, cancel: null },
    historyOpen: false,
    view: "chat"
  };

  const dummySuggestions = document.createElement("div");
  dummySuggestions.hidden = true;

  const syncWelcome = () => {
    const hasMessages = els.messages.childElementCount > 0;
    els.chatView.classList.toggle("is-empty", !hasMessages);
    els.welcome.hidden = hasMessages;
    els.chatScroll.hidden = !hasMessages;
  };

  const persist = async (model = "") => {
    await upsertConversation({
      chatId: session.chatId,
      messages: session.conversationHistory,
      source: "page",
      model
    });
  };

  const ask = () => {
    // askQuestion appends the user/assistant nodes synchronously before its first
    // await — flip the welcome/thread panes immediately so the chat doesn't stay
    // blank for the whole request.
    const request = askQuestion({
      article: null,
      host,
      textarea: els.textarea,
      messages: els.messages,
      status: els.status,
      model: els.model,
      askButton: els.askButton,
      chatScroll: els.chatScroll,
      suggestions: dummySuggestions,
      conversationHistory: session.conversationHistory,
      sessionRef: session.sessionRef,
      panelState: session.panelState,
      chatId: session.chatId,
      onTurnComplete: ({ model }) => {
        syncWelcome();
        void persist(model);
        if (session.historyOpen) void renderHistory();
      }
    });
    syncWelcome();
    request.finally(() => {
      syncWelcome();
    });
  };

  const resetChat = () => {
    if (session.panelState.activeRequestId) return;
    session.chatId = createChatId();
    session.sessionRef.id = createRequestId();
    session.conversationHistory.length = 0;
    els.messages.textContent = "";
    els.status.textContent = "";
    els.model.hidden = true;
    els.textarea.value = "";
    resizeComposer(els.textarea);
    setView("chat");
    syncWelcome();
    els.textarea.focus();
  };

  const loadChat = async (id) => {
    const response = await getChat(id);
    if (!response?.ok || !response.chat) return;
    if (session.panelState.activeRequestId) return;

    session.chatId = response.chat.id;
    session.sessionRef.id = createRequestId();
    session.conversationHistory.length = 0;
    els.messages.textContent = "";

    for (const message of response.chat.messages || []) {
      session.conversationHistory.push(toConversationEntry(message));
      const node = appendChatMessage(els.messages, message.role, "");
      if (message.role === "assistant") {
        renderMarkdownInto(node.querySelector(".message-body"), message.content);
      } else {
        node.querySelector(".message-body").textContent = message.content;
      }
    }
    capConversationInPlace(session.conversationHistory);
    els.status.textContent = "";
    syncWelcome();
    setView("chat");
    closeHistory();
    els.textarea.focus();
  };

  const renderHistory = async () => {
    const query = els.historySearch.value.trim();
    const response = await listChats(query);
    const chats = response?.chats || [];
    if (!chats.length) {
      els.historyList.innerHTML = `<div class="al-history-empty">${query ? "No matching chats." : "No saved chats yet."}</div>`;
      return;
    }
    els.historyList.innerHTML = chats.map((chat) => `
      <div class="al-history-item${chat.id === session.chatId ? " active" : ""}" data-chat-id="${chat.id}">
        <div class="meta">
          <div class="title"></div>
          <div class="preview"></div>
          <div class="when"></div>
        </div>
        <button type="button" class="delete" data-delete-id="${chat.id}">Delete</button>
      </div>
    `).join("");

    [...els.historyList.querySelectorAll(".al-history-item")].forEach((row, index) => {
      const chat = chats[index];
      row.querySelector(".title").textContent = chat.title || "Untitled";
      row.querySelector(".preview").textContent = chat.preview || "";
      row.querySelector(".when").textContent = formatWhen(chat.updatedAt);
      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-delete-id]")) return;
        void loadChat(chat.id);
      });
    });

    [...els.historyList.querySelectorAll("[data-delete-id]")].forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = button.getAttribute("data-delete-id");
        await deleteChat(id);
        if (session.chatId === id) resetChat();
        await renderHistory();
      });
    });
  };

  const openHistory = () => {
    session.historyOpen = true;
    els.historyBackdrop.hidden = false;
    els.historyDrawer.hidden = false;
    els.openHistory.classList.add("active");
    void renderHistory();
    els.historySearch.focus();
  };

  const closeHistory = () => {
    session.historyOpen = false;
    els.historyBackdrop.hidden = true;
    els.historyDrawer.hidden = true;
    els.openHistory.classList.remove("active");
  };

  const setView = (view) => {
    session.view = view === "settings" ? "settings" : "chat";
    els.chatView.classList.toggle("active", session.view === "chat");
    els.settingsView.classList.toggle("active", session.view === "settings");
    els.openSettings.classList.toggle("active", session.view === "settings");
    if (session.view === "settings") {
      const url = getRuntimeUrl("options.html");
      if (url && els.settingsFrame.getAttribute("src") !== url) {
        els.settingsFrame.setAttribute("src", url);
      }
      closeHistory();
    } else {
      void syncModelSelect(els);
      window.setTimeout(() => els.textarea.focus(), 0);
    }
  };

  els.askButton.addEventListener("click", () => {
    if (session.panelState.activeRequestId) {
      if (session.panelState.cancel) session.panelState.cancel();
      else cancelAskRequest(session.panelState.activeRequestId);
      return;
    }
    ask();
  });
  els.textarea.addEventListener("input", () => resizeComposer(els.textarea));
  els.textarea.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask();
    }
  });
  els.newChat.addEventListener("click", resetChat);
  els.newChatInline.addEventListener("click", resetChat);
  els.openHistory.addEventListener("click", () => {
    if (session.historyOpen) closeHistory();
    else openHistory();
  });
  els.closeHistory.addEventListener("click", closeHistory);
  els.historyBackdrop.addEventListener("click", closeHistory);
  els.openSettings.addEventListener("click", () => {
    if (session.view === "settings") navigateAskLocal("chat");
    else navigateAskLocal("settings");
  });
  els.settingsFrame.addEventListener("load", syncTheme);
  els.brand.addEventListener("click", () => navigateAskLocal("chat"));
  els.brand.style.cursor = "pointer";
  els.historySearch.addEventListener("input", () => {
    window.clearTimeout(els.historySearch._timer);
    els.historySearch._timer = window.setTimeout(() => void renderHistory(), 160);
  });
  els.clearHistory.addEventListener("click", async () => {
    if (!window.confirm("Clear all AskLocal chat history on this device?")) return;
    await clearChats();
    resetChat();
    await renderHistory();
  });

  els.modelSelect.addEventListener("change", async () => {
    const id = els.modelSelect.value;
    if (!id) return;
    els.modelSelect.disabled = true;
    try {
      const response = await sendMessage({
        type: "SAVE_SETTINGS",
        payload: { activeMainModelId: id }
      });
      if (response?.ok && response.settings) {
        applyModelSelectOptions(els.modelSelect, response.settings);
      } else {
        els.status.textContent = response?.error || "Could not switch model.";
        await syncModelSelect(els);
      }
    } catch (error) {
      els.status.textContent = error?.message || "Could not switch model.";
      await syncModelSelect(els);
    } finally {
      els.modelSelect.disabled = false;
    }
  });

  page = {
    host,
    els,
    session,
    setView,
    openHistory,
    closeHistory,
    resetChat,
    loadChat,
    show() {
      positionHost(host, els.root);
      syncTheme();
      host.style.display = "block";
      setView(getAskLocalView());
      syncWelcome();
      void syncModelSelect(els);
    },
    hide() {
      host.style.display = "none";
      closeHistory();
    },
    reposition() {
      if (host.style.display !== "none") positionHost(host, els.root);
    }
  };

  return page;
}

function applyModelSelectOptions(select, settings) {
  if (!select) return;
  const models = Array.isArray(settings?.models) ? settings.models : [];
  const usable = models.filter((entry) => entry?.usableAsMainText);
  const activeId = settings?.activeMainModelId || "";
  select.textContent = "";
  if (!usable.length) {
    select.hidden = true;
    return;
  }
  for (const entry of usable) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name || entry.model || entry.id;
    select.appendChild(option);
  }
  select.value = usable.some((entry) => entry.id === activeId) ? activeId : usable[0].id;
  select.hidden = false;
}

async function syncModelSelect(els) {
  const select = els?.modelSelect;
  if (!select) return;
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    if (!response?.ok || !response.settings) {
      select.hidden = true;
      return;
    }
    applyModelSelectOptions(select, response.settings);
  } catch {
    select.hidden = true;
  }
}

function hideNativePrimaryColumn(hidden) {
  document.documentElement.toggleAttribute(PAGE_ACTIVE_ATTR, hidden);
}

function applyAskLocalTitle() {
  if (document.title !== ASKLOCAL_DOCUMENT_TITLE) {
    document.title = ASKLOCAL_DOCUMENT_TITLE;
  }
}

function startDocumentTitleGuard() {
  if (savedDocumentTitle === null) {
    const current = document.title;
    savedDocumentTitle =
      current && current !== ASKLOCAL_DOCUMENT_TITLE && !/unknown page/i.test(current)
        ? current
        : "";
  }
  applyAskLocalTitle();
  if (titleGuard) return;

  titleGuard = new MutationObserver(() => {
    if (!isAskLocalPath()) return;
    applyAskLocalTitle();
  });
  // Observe head so we still catch X replacing the <title> node entirely.
  const head = document.head || document.documentElement;
  titleGuard.observe(head, { childList: true, subtree: true, characterData: true });
}

function stopDocumentTitleGuard() {
  titleGuard?.disconnect();
  titleGuard = null;
  if (savedDocumentTitle !== null) {
    if (document.title === ASKLOCAL_DOCUMENT_TITLE || /unknown page/i.test(document.title)) {
      if (savedDocumentTitle) document.title = savedDocumentTitle;
    }
    savedDocumentTitle = null;
  }
}

export function syncAskLocalPage() {
  const active = isAskLocalPath();
  const instance = ensurePage();
  if (active) {
    hideNativePrimaryColumn(true);
    startDocumentTitleGuard();
    instance.show();
  } else {
    hideNativePrimaryColumn(false);
    stopDocumentTitleGuard();
    instance.hide();
  }
}

export function startAskLocalPage() {
  ensurePageVisibilityStyle();
  syncAskLocalPage();

  let routeKey = `${location.pathname}${location.search}`;
  const syncRoute = () => {
    routeKey = `${location.pathname}${location.search}`;
    syncAskLocalPage();
  };
  const syncRouteIfChanged = () => {
    const nextRouteKey = `${location.pathname}${location.search}`;
    if (nextRouteKey === routeKey) return false;
    syncRoute();
    return true;
  };
  const onRoute = () => syncRoute();
  window.addEventListener("popstate", onRoute);
  window.addEventListener("asklocal:route", onRoute);

  // Catch X's client-side navigations that don't always fire popstate for us.
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = function patchedPushState(...args) {
    const result = pushState(...args);
    window.queueMicrotask(onRoute);
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = replaceState(...args);
    window.queueMicrotask(onRoute);
    return result;
  };

  let themeFrame = null;
  let routeFrame = null;
  const scheduleThemeSync = () => {
    if (themeFrame !== null) return;
    themeFrame = window.requestAnimationFrame(() => {
      themeFrame = null;
      syncTheme();
    });
  };
  const scheduleRouteSync = () => {
    if (routeFrame !== null) return;
    routeFrame = window.requestAnimationFrame(() => {
      routeFrame = null;
      syncRouteIfChanged();
    });
  };
  const onResize = () => {
    ensurePage().reposition();
    scheduleThemeSync();
  };
  window.addEventListener("resize", onResize, { passive: true });

  const observer = new MutationObserver(() => {
    if (syncRouteIfChanged() || !isAskLocalPath()) return;
    hideNativePrimaryColumn(true);
    ensurePage().reposition();
    scheduleThemeSync();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
    childList: true,
    subtree: true
  });
  document.addEventListener("click", scheduleRouteSync, true);

  // Deep-link from extension UI.
  try {
    const api = globalThis.browser ?? globalThis.chrome;
    api?.runtime?.onMessage?.addListener((message) => {
      if (message?.type !== "ASKLOCAL_SHOW_PAGE") return;
      navigateAskLocal(message.payload?.view === "settings" ? "settings" : "chat");
    });
  } catch {
    // Ignore.
  }

  return () => {
    observer.disconnect();
    if (themeFrame !== null) window.cancelAnimationFrame(themeFrame);
    if (routeFrame !== null) window.cancelAnimationFrame(routeFrame);
    window.removeEventListener("popstate", onRoute);
    window.removeEventListener("asklocal:route", onRoute);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("click", scheduleRouteSync, true);
    history.pushState = pushState;
    history.replaceState = replaceState;
    hideNativePrimaryColumn(false);
    stopDocumentTitleGuard();
    document.getElementById(PAGE_VISIBILITY_STYLE_ID)?.remove();
    page?.host?.remove();
    page = null;
  };
}

export function openAskLocalSettingsFromPanel() {
  navigateAskLocal("settings");
}
