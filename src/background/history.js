import { api } from "./api.js";
import {
  CHAT_HISTORY_LIMIT,
  CHAT_INDEX_KEY,
  CHAT_RECORD_PREFIX
} from "./constants.js";
import {
  clearPostMediaAnalysisCache,
  deletePostMediaAnalysisForChats
} from "./media/cache.js";
import {
  getSettings
} from "./settings.js";

function chatKey(id) {
  return `${CHAT_RECORD_PREFIX}${id}`;
}

function nowIso() {
  return new Date().toISOString();
}

function titleFromMessages(messages) {
  const firstUser = (messages || []).find((m) => m?.role === "user" && String(m.content || "").trim());
  const text = String(firstUser?.content || "New chat").replace(/\s+/g, " ").trim();
  return text.length > 72 ? `${text.slice(0, 69)}…` : text || "New chat";
}

function previewFromMessages(messages) {
  const last = [...(messages || [])].reverse().find((m) => String(m?.content || "").trim());
  const text = String(last?.content || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function normalizeMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const output = {
    role,
    content: String(message?.content || ""),
    createdAt: message?.createdAt || nowIso()
  };
  // Model-facing turn state (see background/prompt/history.js): the exact context a
  // user turn was asked with, and the evidence/ids an answer produced. Reopened chats
  // need these for follow-ups to see the thread.
  if (role === "user") {
    if (typeof message?.context === "string" && message.context) output.context = message.context;
    if (message?.contextKind === "full" || message?.contextKind === "followup") output.contextKind = message.contextKind;
    if (typeof message?.subject === "string" && message.subject) output.subject = message.subject;
  } else {
    if (typeof message?.evidence === "string" && message.evidence) output.evidence = message.evidence;
    if (message?.aliases && typeof message.aliases === "object" && !Array.isArray(message.aliases)) output.aliases = message.aliases;
  }
  return output;
}

function normalizeChat(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) return null;
  const messages = Array.isArray(input.messages) ? input.messages.map(normalizeMessage) : [];
  const createdAt = input.createdAt || nowIso();
  const updatedAt = input.updatedAt || createdAt;
  return {
    id,
    title: String(input.title || titleFromMessages(messages) || "New chat"),
    source: ["page", "panel", "post"].includes(input.source) ? input.source : "page",
    context: input.context && typeof input.context === "object" ? input.context : null,
    messages,
    model: input.model ? String(input.model) : "",
    provider: input.provider ? String(input.provider) : "",
    createdAt,
    updatedAt
  };
}

function indexEntryFromChat(chat) {
  return {
    id: chat.id,
    title: chat.title,
    preview: previewFromMessages(chat.messages),
    source: chat.source,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
    messageCount: chat.messages.length
  };
}

async function readIndex() {
  const result = await api.storage.local.get(CHAT_INDEX_KEY);
  const list = result?.[CHAT_INDEX_KEY];
  return Array.isArray(list) ? list : [];
}

async function writeIndex(index) {
  await api.storage.local.set({ [CHAT_INDEX_KEY]: index });
}

async function pruneIndex(index) {
  if (index.length <= CHAT_HISTORY_LIMIT) return index;
  const sorted = [...index].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const keep = sorted.slice(0, CHAT_HISTORY_LIMIT);
  const drop = sorted.slice(CHAT_HISTORY_LIMIT);
  if (drop.length) {
    await api.storage.local.remove(drop.map((entry) => chatKey(entry.id)));
    await deletePostMediaAnalysisForChats(drop.map((entry) => entry.id));
  }
  return keep;
}

export async function listChats(payload = {}) {
  const query = String(payload.query || "").trim().toLowerCase();
  let index = await readIndex();
  index = [...index].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (query) {
    index = index.filter((entry) => {
      const hay = `${entry.title || ""} ${entry.preview || ""}`.toLowerCase();
      return hay.includes(query);
    });
  }
  return { ok: true, chats: index };
}

export async function getChat(payload = {}) {
  const id = String(payload.id || "").trim();
  if (!id) return { ok: false, error: "Missing chat id." };
  const result = await api.storage.local.get(chatKey(id));
  const chat = normalizeChat(result?.[chatKey(id)]);
  if (!chat) return { ok: false, error: "Chat not found." };
  return { ok: true, chat };
}

export async function upsertChat(payload = {}) {
  const settings = await getSettings();
  if (!settings.saveChatHistory) {
    return { ok: true, skipped: true, reason: "saveChatHistory disabled" };
  }

  const incoming = normalizeChat(payload.chat || payload);
  if (!incoming) return { ok: false, error: "Invalid chat." };
  if (!incoming.messages.length && !payload.allowEmpty) {
    return { ok: true, skipped: true, reason: "empty" };
  }

  const existingResult = await api.storage.local.get(chatKey(incoming.id));
  const existing = normalizeChat(existingResult?.[chatKey(incoming.id)]);
  const chat = {
    ...incoming,
    createdAt: existing?.createdAt || incoming.createdAt,
    updatedAt: nowIso(),
    title: incoming.title || existing?.title || titleFromMessages(incoming.messages)
  };

  await api.storage.local.set({ [chatKey(chat.id)]: chat });

  let index = await readIndex();
  index = index.filter((entry) => entry.id !== chat.id);
  index.unshift(indexEntryFromChat(chat));
  index = await pruneIndex(index);
  await writeIndex(index);

  return { ok: true, chat, entry: indexEntryFromChat(chat) };
}

export async function deleteChat(payload = {}) {
  const id = String(payload.id || "").trim();
  if (!id) return { ok: false, error: "Missing chat id." };
  await api.storage.local.remove(chatKey(id));
  const index = (await readIndex()).filter((entry) => entry.id !== id);
  await writeIndex(index);
  await deletePostMediaAnalysisForChats(id);
  return { ok: true, id };
}

export async function clearChats() {
  const index = await readIndex();
  if (index.length) {
    await api.storage.local.remove(index.map((entry) => chatKey(entry.id)));
  }
  await writeIndex([]);
  await clearPostMediaAnalysisCache();
  return { ok: true, removed: index.length };
}

export async function renameChat(payload = {}) {
  const id = String(payload.id || "").trim();
  const title = String(payload.title || "").trim();
  if (!id || !title) return { ok: false, error: "Missing id or title." };
  const current = await getChat({ id });
  if (!current.ok) return current;
  return upsertChat({
    chat: {
      ...current.chat,
      title,
      updatedAt: nowIso()
    },
    allowEmpty: true
  });
}
