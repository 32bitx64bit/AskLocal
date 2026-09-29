import {
  createRequestId
} from "./ask.js";
import {
  sendMessage
} from "./runtime.js";

export function createChatId() {
  return createRequestId().replace(/^asklocal-/, "chat-");
}

export async function listChats(query = "") {
  return sendMessage({ type: "LIST_CHATS", payload: { query } });
}

export async function getChat(id) {
  return sendMessage({ type: "GET_CHAT", payload: { id } });
}

export async function deleteChat(id) {
  return sendMessage({ type: "DELETE_CHAT", payload: { id } });
}

export async function clearChats() {
  return sendMessage({ type: "CLEAR_CHATS" });
}

export async function renameChat(id, title) {
  return sendMessage({ type: "RENAME_CHAT", payload: { id, title } });
}

/**
 * Persist a conversation snapshot. No-ops when history is disabled in settings
 * (background returns skipped).
 */
export async function upsertConversation({
  chatId,
  messages,
  source = "page",
  context = null,
  model = "",
  provider = "",
  title = ""
}) {
  if (!chatId || !Array.isArray(messages) || messages.length === 0) {
    return { ok: true, skipped: true };
  }
  return sendMessage({
    type: "UPSERT_CHAT",
    payload: {
      chat: {
        id: chatId,
        title,
        source,
        context,
        messages,
        model,
        provider
      }
    }
  });
}
