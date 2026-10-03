/**
 * Persistent media-analysis cache (IndexedDB), shared by every chat, tab and post.
 *
 * Entries are keyed by media identity (media/identity.js) plus the analysis profile
 * (models, sampling, strategy, focus prompt), never by the post the media was seen on,
 * so a repost or quote of an already-analyzed video is a hit. The post-specific part of
 * a result (`target`: which post, whose post) is not trusted from the cache; callers put
 * the current target back on it.
 *
 * Chats that used an entry are recorded on it. Deleting a chat removes entries that only
 * that chat used (the old per-chat cleanup, kept for privacy); entries made by prefetch
 * belong to no chat and age out by LRU.
 *
 * Falls back to an in-memory map when IndexedDB is unavailable.
 */

const DB_NAME = "asklocal-media";
const DB_VERSION = 1;
const STORE = "analyses";
const MEMORY_LIMIT = 200;
export const MEDIA_STORE_ENTRY_LIMIT = 3000;

const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("usedAt", "usedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((value) => {
      result = value;
    }, reject);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function remember(key, entry) {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

/** The stored entry ({ key, identity, result, chatIds, createdAt, usedAt }) or null. */
export async function getMediaEntry(key) {
  if (!key) return null;
  const hot = memory.get(key);
  if (hot) {
    hot.usedAt = Date.now();
    remember(key, hot);
    return hot;
  }
  const db = await openDb();
  if (!db) return null;
  try {
    const entry = await tx(db, "readonly", (store) => req(store.get(key)));
    if (!entry?.result?.ok) return null;
    entry.usedAt = Date.now();
    remember(key, entry);
    // Touch for LRU without blocking the caller.
    tx(db, "readwrite", (store) => store.put(entry)).catch(() => {});
    return entry;
  } catch {
    return null;
  }
}

/** Store a successful analysis. `chatId` (optional) records which chat used it. */
export async function putMediaEntry(key, { identity = "", result, chatId = "" } = {}) {
  if (!key || !result?.ok) return;
  const now = Date.now();
  const previous = memory.get(key) ?? null;
  const chatIds = new Set(previous?.chatIds ?? []);
  if (chatId) chatIds.add(String(chatId));
  const entry = {
    key,
    identity,
    result,
    chatIds: [...chatIds],
    createdAt: previous?.createdAt ?? now,
    usedAt: now
  };
  remember(key, entry);
  const db = await openDb();
  if (!db) return;
  try {
    await tx(db, "readwrite", async (store) => {
      const stored = await req(store.get(key));
      if (stored?.chatIds?.length) entry.chatIds = [...new Set([...stored.chatIds, ...entry.chatIds])];
      if (stored?.createdAt) entry.createdAt = stored.createdAt;
      store.put(entry);
    });
    remember(key, entry);
    void pruneMediaStore(db);
  } catch {
    // Persistence is best-effort; the memory copy still serves this worker's lifetime.
  }
}

/** Record that `chatId` used an entry (a cache hit from another chat). */
export async function touchMediaEntryForChat(key, chatId) {
  if (!key || !chatId) return;
  const entry = await getMediaEntry(key);
  if (!entry || entry.chatIds?.includes(chatId)) return;
  await putMediaEntry(key, { identity: entry.identity, result: entry.result, chatId });
}

let pruning = null;
async function pruneMediaStore(db) {
  if (pruning) return pruning;
  pruning = (async () => {
    try {
      const count = await tx(db, "readonly", (store) => req(store.count()));
      const excess = count - MEDIA_STORE_ENTRY_LIMIT;
      if (excess <= 0) return;
      await tx(db, "readwrite", (store) => new Promise((resolve) => {
        let removed = 0;
        const cursorRequest = store.index("usedAt").openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || removed >= excess) {
            resolve();
            return;
          }
          memory.delete(cursor.primaryKey);
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
        cursorRequest.onerror = () => resolve();
      }));
    } catch {
      // Ignore.
    } finally {
      pruning = null;
    }
  })();
  return pruning;
}

/** Remove the given chats from every entry; delete entries no remaining chat used. */
export async function forgetChatsInMediaStore(chatIds) {
  const ids = new Set((Array.isArray(chatIds) ? chatIds : [chatIds]).map((id) => String(id || "").trim()).filter(Boolean));
  if (!ids.size) return { removed: 0 };
  let removed = 0;
  const visit = (entry) => {
    const owners = entry.chatIds ?? [];
    if (!owners.some((id) => ids.has(id))) return "keep";
    const rest = owners.filter((id) => !ids.has(id));
    if (!rest.length) return "delete";
    entry.chatIds = rest;
    return "update";
  };
  for (const [key, entry] of [...memory.entries()]) {
    const action = visit(entry);
    if (action === "delete") memory.delete(key);
  }
  const db = await openDb();
  if (!db) return { removed };
  try {
    await tx(db, "readwrite", (store) => new Promise((resolve) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        const entry = cursor.value;
        const action = visit(entry);
        if (action === "delete") {
          cursor.delete();
          removed += 1;
        } else if (action === "update") {
          cursor.update(entry);
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => resolve();
    }));
  } catch {
    // Ignore.
  }
  return { removed };
}

export async function clearMediaStore() {
  const removed = memory.size;
  memory.clear();
  const db = await openDb();
  if (!db) return { removed };
  try {
    const count = await tx(db, "readonly", (store) => req(store.count()));
    await tx(db, "readwrite", (store) => req(store.clear()));
    return { removed: count };
  } catch {
    return { removed };
  }
}

export async function countMediaStore() {
  const db = await openDb();
  if (!db) return memory.size;
  try {
    return await tx(db, "readonly", (store) => req(store.count()));
  } catch {
    return memory.size;
  }
}
