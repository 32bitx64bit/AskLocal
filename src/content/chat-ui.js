import { api } from "./api.js";
import {
  PROMPT_PRESETS
} from "./constants.js";
import {
  main
} from "./index.js";
import {
  renderMarkdownInto
} from "./markdown.js";

export function scrollChatToBottomIfPinned(chatScroll) {
  const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 60;
  if (nearBottom) scrollChatToBottom(chatScroll);
}
export function appendStoppedNote(message) {
  message.querySelector(".stopped-note")?.remove();
  const note = document.createElement("div");
  note.className = "stopped-note";
  note.textContent = "Stopped before the answer finished.";
  message.appendChild(note);
}
export function normalizePromptPreset(value) {
  const preset = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  return PROMPT_PRESETS.has(preset) ? preset : "";
}
export function inferPromptPresetFromQuestion(question) {
  const text = String(question || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/g, "");
  if (!text) return "";
  if (/^explain( this)?( post| tweet| thread| video| image| topic| claim| concept)?$/.test(text)) return "explain";
  if (/^(is this true|fact check this claim|fact-check this claim|fact check this|fact-check this|check if this is true)$/.test(text)) return "fact_check";
  if (/^(summari[sz]e|summerize)( this)?( post| tweet| thread| video| image| link| page)?$/.test(text)) return "summarize";
  return "";
}
export function renderFollowupSuggestions(container, options = {}) {
  if (!container) return;
  const suggestions = buildFollowupSuggestions(options);
  container.textContent = "";
  suggestions.forEach((suggestion) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.suggestion = suggestion.question;
    if (suggestion.preset) button.dataset.preset = suggestion.preset;
    button.textContent = suggestion.label;
    container.appendChild(button);
  });
  container.hidden = suggestions.length === 0;
}
export function buildFollowupSuggestions({ promptPreset = "", hasPostContext = false } = {}) {
  const preset = normalizePromptPreset(promptPreset);
  if (!hasPostContext) return [];
  if (preset === "fact_check") {
    return [
      { label: "Show evidence", question: "Show the strongest evidence for and against this" },
      { label: "What is missing?", question: "What information would change the verdict?" },
      { label: "Summarize it", question: "Summarize this fact-check in plain English", preset: "summarize" }
    ];
  }
  if (preset === "summarize") {
    return [
      { label: "Explain context", question: "Explain the background behind this", preset: "explain" },
      { label: "Check the claim", question: "Is the main claim true?", preset: "fact_check" },
      { label: "Key details", question: "What details matter most here?" }
    ];
  }
  return [
    { label: "Check the claim", question: "Is this true?", preset: "fact_check" },
    { label: "Give context", question: "What context matters most here?" },
    { label: "Short summary", question: "Summarize this in a few bullets", preset: "summarize" }
  ];
}
export function attachAssistantMessageActions(message, answerText) {
  message.querySelector(".message-actions")?.remove();
  if (!String(answerText || "").trim()) return;

  const row = document.createElement("div");
  row.className = "message-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(answerText);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    window.setTimeout(() => {
      copy.textContent = "Copy";
    }, 1400);
  });

  row.appendChild(copy);
  message.appendChild(row);
}
export function renderContextPost(container, tweet) {
  container.textContent = "";

  const label = document.createElement("div");
  label.className = "context-label";
  label.textContent = "Post";

  const author = document.createElement("div");
  author.className = "context-author";
  const name = document.createElement("strong");
  name.textContent = tweet.displayName || tweet.authorHandle || "X post";
  const handle = document.createElement("span");
  const postedAt = tweet.postedAt ? formatContextTimestamp(tweet.postedAt) : "";
  handle.textContent = [
    tweet.authorHandle ? `@${tweet.authorHandle.replace(/^@/, "")}` : "",
    postedAt
  ].filter(Boolean).join(" · ");
  author.append(name, handle);

  const body = document.createElement("p");
  body.textContent = tweet.text || "No readable post text found.";

  container.append(label, author, body);

  if (tweet.videoSubtitles?.length) {
    const subtitles = document.createElement("div");
    subtitles.className = "context-subtitles";
    subtitles.textContent = `Video subtitles detected: ${tweet.videoSubtitles.length}`;
    container.appendChild(subtitles);
  }
}
export function formatContextTimestamp(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function appendChatMessage(messages, role, text) {
  const item = document.createElement("article");
  item.className = `message ${role}`;

  const body = document.createElement("div");
  body.className = "message-body";
  if (role === "assistant") renderMarkdownInto(body, text);
  else body.textContent = text;

  item.appendChild(body);
  messages.appendChild(item);
  return item;
}
export function setRequestStatus(request, message) {
  const text = String(message || "Working...").trim();
  request.status.textContent = text;
  renderPendingStatus(request.pending, text);
  scrollChatToBottom(request.chatScroll);
}
export function renderPendingStatus(message, text) {
  const body = message.querySelector(".message-body");
  if (!body || !message.classList.contains("pending")) return;

  body.textContent = "";
  const row = document.createElement("div");
  row.className = "thinking-row";

  const dot = document.createElement("span");
  dot.className = "thinking-dot";

  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = text;

  row.append(dot, label);
  body.appendChild(row);
}
export function renderMessageSources(message, sources) {
  message.querySelector(".message-sources")?.remove();
  const normalized = normalizeMessageSources(sources).slice(0, 8);
  if (!normalized.length) return;

  const row = document.createElement("div");
  row.className = "message-sources";
  row.setAttribute("aria-label", "Sources");

  normalized.forEach((source, index) => {
    const link = document.createElement("a");
    link.className = "source-icon";
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = source.title ? `${source.title} - ${source.host}` : source.host;
    link.setAttribute("aria-label", `Open source ${index + 1}: ${source.title || source.host}`);

    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";

    const fallback = document.createElement("span");
    fallback.className = "source-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = source.kind === "x_post" ? "X" : (source.host[0] || "?").toUpperCase();

    const showFallback = () => {
      img.hidden = true;
      fallback.hidden = false;
    };
    const showIcon = () => {
      img.hidden = false;
      fallback.hidden = true;
    };

    if (source.iconUrl) {
      showIcon();
      img.src = source.iconUrl;
      img.addEventListener("error", showFallback, { once: true });
    } else {
      showFallback();
    }

    link.append(img, fallback);
    row.appendChild(link);
  });

  message.appendChild(row);
}
export function normalizeMessageSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const normalized = [];
  for (const source of sources) {
    if (!source?.url) continue;
    let url;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const key = url.href.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      url: source.url,
      title: String(source.title || source.host || url.hostname).trim(),
      host: String(source.host || url.hostname).replace(/^www\./, ""),
      kind: source.kind || "web",
      iconUrl: String(source.iconUrl || "")
    });
  }
  return normalized;
}
export function scrollChatToBottom(chatScroll) {
  window.requestAnimationFrame(() => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  });
}
export function resizeComposer(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(128, Math.max(40, textarea.scrollHeight))}px`;
}
export function normalizePanelText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

