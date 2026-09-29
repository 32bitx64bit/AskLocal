import { api } from "./api.js";
import {
  state
} from "./state.js";

export function addTrackedListener(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  state.cleanupCallbacks.push(() => target.removeEventListener(type, listener, options));
}
export function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) deactivateContentScript();
  }
}
export function isRuntimeAvailable() {
  try {
    return Boolean(api?.runtime?.id);
  } catch {
    return false;
  }
}
export function handleContentScriptError(error) {
  if (isExtensionContextInvalidated(error)) {
    deactivateContentScript();
    return;
  }
  throw error;
}
export function isExtensionContextInvalidated(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("extension context invalidated")
    || message.includes("context invalidated")
    || message.includes("receiving end does not exist")
    || message.includes("message port closed")
    || message.includes("extension has been reloaded")
    || !isRuntimeAvailable();
}
export function deactivateContentScript() {
  if (state.disposed) return;
  state.disposed = true;
  if (state.mutationFrame) {
    window.cancelAnimationFrame(state.mutationFrame);
    state.mutationFrame = null;
  }
  for (const cleanup of state.cleanupCallbacks.splice(0)) {
    try {
      cleanup();
    } catch {
      // Best-effort teardown for stale content scripts after extension reload.
    }
  }
  state.activeRequests.clear();
}
export async function refreshSettings() {
  const response = await sendMessage({ type: "GET_SETTINGS" });
  state.settings = response?.settings ?? { enabled: true };
}
export function sendMessage(message) {
  if (state.disposed || !isRuntimeAvailable()) {
    deactivateContentScript();
    return Promise.resolve({ ok: false, contextInvalidated: true, error: "Extension context invalidated." });
  }

  try {
    return Promise.resolve(api.runtime.sendMessage(message))
      .catch((error) => {
        if (isExtensionContextInvalidated(error)) {
          deactivateContentScript();
          return { ok: false, contextInvalidated: true, error: error.message || "Extension context invalidated." };
        }
        return { ok: false, error: error.message || String(error || "Message failed.") };
      });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      deactivateContentScript();
      return Promise.resolve({ ok: false, contextInvalidated: true, error: error.message || "Extension context invalidated." });
    }
    return Promise.resolve({ ok: false, error: error.message || String(error || "Message failed.") });
  }
}
export function getRuntimeUrl(path) {
  if (state.disposed || !isRuntimeAvailable()) return "";
  try {
    return api.runtime.getURL(path);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) deactivateContentScript();
    return "";
  }
}

