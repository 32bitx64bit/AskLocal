/**
 * Optional recording of raw X GraphQL responses (Settings → Diagnostics).
 *
 * X changes its response format without notice. With capture on, the last responses
 * the extension received are kept so they can be exported and turned into test
 * fixtures: the parser is then checked against what X actually sends today instead of
 * guesses. Responses contain post text and public profile data of whatever was opened,
 * so this is off by default and kept local.
 */

import { api } from "../api.js";

const STORAGE_KEY = "asklocalXCaptures";
const CAPTURE_LIMIT = 40;
let enabled = false;
let writing = Promise.resolve();

export function setXCaptureEnabled(value) {
  enabled = Boolean(value);
}

export function recordXCapture(operationName, variables, data) {
  if (!enabled || !data) return;
  const entry = {
    operationName: String(operationName || ""),
    variables: variables ?? null,
    capturedAt: new Date().toISOString(),
    data
  };
  writing = writing.then(async () => {
    try {
      const stored = await api.storage.local.get(STORAGE_KEY);
      const list = Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      list.push(entry);
      await api.storage.local.set({ [STORAGE_KEY]: list.slice(-CAPTURE_LIMIT) });
    } catch {
      // Diagnostics only.
    }
  });
}

export async function exportXCaptures() {
  await writing;
  const stored = await api.storage.local.get(STORAGE_KEY).catch(() => ({}));
  return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

export async function clearXCaptures() {
  await writing;
  await api.storage.local.remove(STORAGE_KEY).catch(() => {});
}
