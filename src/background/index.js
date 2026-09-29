import { api } from "./api.js";
import {
  handleMessage,
  runAskPipeline
} from "./ask/pipeline.js";
import {
  ASK_PORT_KEEPALIVE_MS
} from "./constants.js";
import {
  buildResponseSources
} from "./response/sources.js";
import {
  DEFAULT_SETTINGS
} from "./settings.js";

api.runtime.onInstalled.addListener(async () => {
  const existing = await api.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const next = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) next[key] = value;
  }
  if (Object.keys(next).length > 0) {
    await Promise.allSettled([
      api.storage.sync.set(next),
      api.storage.local.set(next)
    ]);
  }
});
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // video-capture.html (offscreen or Firefox tab) owns this message; the
  // background must not sendResponse or it can win the race with an empty reply.
  if (message?.type === "ASKLOCAL_CAPTURE_RAW_VIDEO_FRAMES") return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "asklocal:ask") return;

  const controller = new AbortController();
  let started = false;
  let open = true;
  const post = (message) => {
    if (!open) return;
    try {
      port.postMessage(message);
    } catch {
      open = false;
    }
  };

  // Content-script timers throttle hard in background tabs, so the worker must
  // emit its own Port traffic during long vision/media waits. Otherwise Chrome
  // can suspend the MV3 service worker and the panel sees a disconnect.
  const keepalive = setInterval(() => {
    post({ type: "keepalive" });
  }, ASK_PORT_KEEPALIVE_MS);

  const stopKeepalive = () => {
    clearInterval(keepalive);
  };

  port.onDisconnect.addListener(() => {
    open = false;
    stopKeepalive();
    controller.abort();
  });

  port.onMessage.addListener(async (message) => {
    if (message?.type === "ping") {
      // Keepalive heartbeat from the panel: replying (and receiving) resets the MV3 service
      // worker's idle timer so it is not suspended during long, silent stretches such as a
      // slow model pass inside multi-chunk video analysis.
      post({ type: "pong" });
      return;
    }
    if (message?.type === "cancel") {
      controller.abort();
      return;
    }
    if (message?.type !== "start" || started) return;
    started = true;

    const progress = async (text) => post({ type: "status", message: String(text || "") });
    try {
      const result = await runAskPipeline(message.payload ?? {}, port.sender, controller, progress, {
        delta: (text) => post({ type: "answer_delta", text }),
        reset: () => post({ type: "answer_reset" })
      });
      if (result.disabled) {
        post({ type: "error", error: "AskLocal is disabled." });
        return;
      }
      post({
        type: "answer_done",
        answer: result.answer,
        model: result.model,
        contextSummary: result.contextSummary,
        turn: result.turn
      });
      const sources = await buildResponseSources(result.context);
      post({ type: "sources", sources });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        post({ type: "error", stopped: true, error: "Stopped." });
      } else {
        post({ type: "error", error: error?.message || "AskLocal could not get an answer." });
      }
    } finally {
      open = false;
      stopKeepalive();
      try {
        port.disconnect();
      } catch {
        // Already disconnected by the panel.
      }
    }
  });
});
