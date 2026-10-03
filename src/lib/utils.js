
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
}

/**
 * Keep progress/port traffic flowing while a long async task runs (vision calls,
 * slow local generations). Chrome may suspend an MV3 worker during silent waits.
 */
export async function runWithProgressHeartbeat(task, {
  reportProgress,
  label = "working",
  heartbeatMs = 10_000,
  signal = null
} = {}) {
  const startedAt = Date.now();
  void reportProgress?.(typeof label === "function" ? label(0) : `Still ${label}...`);
  const heartbeat = setInterval(() => {
    if (signal?.aborted) return;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const message = typeof label === "function" ? label(seconds) : `Still ${label} — ${seconds}s...`;
    void reportProgress?.(message);
  }, Math.max(3_000, Number(heartbeatMs) || 10_000));
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
  }
}

export function createProgressReporter(sender, requestId) {
  const tabId = sender?.tab?.id;
  const id = String(requestId || "").trim();
  return async (message, detail = {}) => {
    if (!tabId || !id || !message) return;
    try {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.tabs.sendMessage(tabId, {
        type: "ASK_LOCAL_PROGRESS",
        requestId: id,
        message,
        detail
      });
    } catch {
      // Progress updates are best-effort; the final response still carries the answer.
    }
  };
}
export function promiseWithAbortAndTimeout(promise, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Timed out waiting for the X page fetch.")));
    }, timeoutMs);
    const onAbort = () => settle(() => reject(new DOMException("Aborted", "AbortError")));
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
      callback();
    };

    signal?.addEventListener?.("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}
export function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (number >= 1000000) return `${trimTrailingZero((number / 1000000).toFixed(1))}M`;
  if (number >= 1000) return `${trimTrailingZero((number / 1000).toFixed(1))}K`;
  return String(number);
}
export function trimTrailingZero(value) {
  return String(value).replace(/\.0$/, "");
}
export function normalizeUrlPathname(pathname) {
  const cleaned = `/${String(pathname || "")
    .split("/")
    .filter(Boolean)
    .join("/")}`;
  return cleaned === "/" ? "/" : cleaned.replace(/\/+$/, "");
}
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
export function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const totalTenths = Math.round(seconds * 10);
  const whole = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}${tenths ? `.${tenths}` : ""}`;
}
export function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}
export function normalizeModelText(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}
export function normalizeResponsesOutput(output) {
  if (!Array.isArray(output)) return "";

  return output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [item])
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
export function stableHash(value) {
  let hash = 0;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
export function uniqueBy(items, getKey) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item, index) => {
    const key = getKey(item, index);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function normalizeSearchQuery(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Firefox often surfaces opaque "NetworkError when attempting to fetch resource."
 * Rewrite those into something actionable.
 */
export function describeFetchError(error, what = "the remote server") {
  const message = String(error?.message || error || "").trim();
  const lower = message.toLowerCase();
  if (
    lower.includes("networkerror when attempting to fetch")
    || lower === "failed to fetch"
    || lower.includes("network request failed")
    || lower.includes("load failed")
  ) {
    return `Could not reach ${what}. The server may be offline, blocked, or rejecting the request.`;
  }
  return message || `Could not reach ${what}.`;
}

