// Minimal extension API so background modules can be imported under `node --test`.
// Import this first in a test file (ES imports run in order).
const memory = new Map();
const area = {
  async get(keys) {
    if (keys == null) return Object.fromEntries(memory);
    const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
    return Object.fromEntries(list.filter((key) => memory.has(key)).map((key) => [key, memory.get(key)]));
  },
  async set(values) {
    for (const [key, value] of Object.entries(values)) memory.set(key, value);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) memory.delete(key);
  }
};
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: "0.0.0-test" }),
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: async () => ({}),
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
    onInstalled: { addListener() {} }
  },
  storage: { local: area, sync: area, session: area },
  tabs: { sendMessage: async () => ({}), query: async () => [] }
};
