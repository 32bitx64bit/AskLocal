import { api } from "./api.js";
import {
  handleAskLocalProgress
} from "./ask.js";
import {
  startAskLocalPage
} from "./asklocal-page/index.js";
import {
  cacheVisibleProfile,
  collectProfileContext,
  collectSearchContext,
  collectThreadContext
} from "./context-collectors.js";
import {
  collectMediaCapture
} from "./media-capture.js";
import {
  startAskLocalNav
} from "./nav-inject.js";
import {
  destroyShell,
  handleNativeGrokLaunch,
  releaseMediaSession,
  schedulePanelAlignment
} from "./panel-controller.js";
import {
  addTrackedListener,
  handleContentScriptError,
  isRuntimeAvailable,
  refreshSettings,
  safeSendResponse
} from "./runtime.js";
import {
  state
} from "./state.js";
import {
  cleanupMountedControls,
  handleViewportChange,
  mountVisibleTweets
} from "./tweet-mount.js";
import {
  collectXSessionContext,
  fetchXGraphQLForBackground
} from "./x-session.js";
import {
  handleXMediaSnifferMessage,
  requestXMediaSnifferCache
} from "./x-video-cache.js";

export function main() {
  if (!isRuntimeAvailable()) return;
  cleanupMountedControls();
  refreshSettings().catch(handleContentScriptError);
  mountVisibleTweets();
  cacheVisibleProfile();

  const stopNav = startAskLocalNav();
  const stopPage = startAskLocalPage();
  state.cleanupCallbacks.push(stopNav, stopPage);

  const observer = new MutationObserver(() => {
    if (state.disposed || state.mutationFrame) return;
    state.mutationFrame = window.requestAnimationFrame(() => {
      state.mutationFrame = null;
      if (state.disposed) return;
      try {
        mountVisibleTweets();
        cacheVisibleProfile();
        schedulePanelAlignment();
      } catch (error) {
        handleContentScriptError(error);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  state.observer = observer;
  state.cleanupCallbacks.push(() => observer.disconnect());

  addTrackedListener(window, "resize", handleViewportChange, { passive: true });
  addTrackedListener(window, "scroll", schedulePanelAlignment, { capture: true, passive: true });
  addTrackedListener(window, "message", handleXMediaSnifferMessage);
  addTrackedListener(window, "pagehide", () => {
    releaseMediaSession(state.activePanel?.dataset?.asklocalMediaSessionId);
    destroyShell({ closeNative: false });
  }, { capture: true });
  addTrackedListener(document, "click", handleNativeGrokLaunch, true);
  requestXMediaSnifferCache();

  const onRuntimeMessage = (message, sender, sendResponse) => {
    if (state.disposed) return false;
    if (message?.type === "ASK_LOCAL_PROGRESS") {
      handleAskLocalProgress(message);
      return false;
    }

    if (message?.type === "ASKLOCAL_GET_X_SESSION") {
      safeSendResponse(sendResponse, { ok: true, session: collectXSessionContext() });
      return false;
    }

    if (message?.type === "ASKLOCAL_X_GRAPHQL_FETCH") {
      fetchXGraphQLForBackground(message.payload ?? {})
        .then((result) => safeSendResponse(sendResponse, result))
        .catch((error) => safeSendResponse(sendResponse, { ok: false, status: 0, text: "", error: error.message }));
      return true;
    }

    if (message?.type === "COLLECT_PROFILE_CONTEXT") {
      safeSendResponse(sendResponse, { ok: true, profile: collectProfileContext(message.payload?.maxPosts ?? 5) });
      return false;
    }

    if (message?.type === "COLLECT_THREAD_CONTEXT") {
      collectThreadContext(message.payload ?? {})
        .then((thread) => safeSendResponse(sendResponse, { ok: true, thread }))
        .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "COLLECT_SEARCH_CONTEXT") {
      collectSearchContext(message.payload ?? {})
        .then((search) => safeSendResponse(sendResponse, { ok: true, search }))
        .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "COLLECT_MEDIA_CAPTURE") {
      collectMediaCapture(message.payload ?? {})
        .then((capture) => safeSendResponse(sendResponse, { ok: true, capture }))
        .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message }));
      return true;
    }

    return false;
  };
  try {
    api.runtime.onMessage.addListener(onRuntimeMessage);
    state.cleanupCallbacks.push(() => api.runtime.onMessage.removeListener(onRuntimeMessage));
  } catch (error) {
    handleContentScriptError(error);
  }
}

main();
