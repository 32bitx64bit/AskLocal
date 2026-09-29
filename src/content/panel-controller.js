import { api } from "./api.js";
import { AskLocalGrokStyles } from "../grok/styles.js";
import { AskLocalGrokShell } from "../grok/shell.js";
import { AskLocalGrokGeometry } from "../grok/geometry.js";
import { AskLocalGrokNative } from "../grok/native-control.js";
import {
  normalizePanelText
} from "./chat-ui.js";
import {
  GROK_PANEL_BOTTOM_GAP,
  GROK_PANEL_BOTTOM_GAP_MOBILE,
  GROK_PANEL_TOP,
  GROK_PANEL_TOP_MOBILE
} from "./constants.js";
import {
  sendMessage
} from "./runtime.js";
import {
  wireShell
} from "./shell-wiring.js";
import {
  state
} from "./state.js";

function geometryApi() {
  return AskLocalGrokGeometry;
}

function nativeApi() {
  return AskLocalGrokNative;
}

function promoteFromFallbackIfPossible() {
  if (!state.fallbackMode) return false;
  const geometry = geometryApi();
  if (!geometry?.drawerPresent?.() && !document.querySelector(geometry?.GROK_DRAWER_SELECTOR || '[data-testid="GrokDrawer"]')) {
    return false;
  }

  state.fallbackMode = false;
  const grokTab = state.activeShell?.els?.tabButtons?.find((button) => button.dataset.tab === "grok");
  if (grokTab) grokTab.hidden = false;

  if (state.activePanelMode === "asklocal" && !state.shellClosed) {
    cloakNativeIfOpen();
  }
  return true;
}

/** Cloak native Grok only while expanded; never hide the collapsed FAB. */
function cloakNativeIfOpen() {
  const native = nativeApi();
  if (!native) return;
  if (native.isOpen()) native.hideNative();
  else native.showNative();
}

async function ensureNativeDocked(options = {}) {
  const openNative = options.openNative !== false;
  const native = nativeApi();
  const geometry = geometryApi();
  if (!native || state.fallbackMode) return false;

  if (!openNative) {
    if (state.activePanelMode === "asklocal") cloakNativeIfOpen();
    positionPanel();
    return Boolean(geometry?.getGrokRect());
  }

  // Expand while uncloaked so the launcher remains clickable, then cloak for AskLocal.
  if (!native.isOpen()) {
    native.showNative();
    state.weOpenedGrok = await native.ensureOpen();
  }
  if (state.activePanelMode === "asklocal") cloakNativeIfOpen();
  positionPanel();
  return Boolean(geometry?.getGrokRect());
}

export function openPanel(article, anchor, options = {}) {
  // The shell persists for the page session: reopening (Ask button, Grok launcher)
  // reuses the existing host instead of rebuilding it, so a closed shell can be
  // brought back with its conversation intact.
  if (state.activePanel && state.activePanel.isConnected) {
    reopenShell(article, options);
    return;
  }
  if (state.activePanel) destroyShell();

  const initialMode = options.initialMode === "grok" ? "grok" : "asklocal";
  const openNative = options.openNative !== false;

  const host = document.createElement("div");
  host.dataset.asklocalPopout = "true";
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  host.style.visibility = "hidden";
  host.style.opacity = "0";
  host.style.transition = "opacity 140ms ease, top 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = AskLocalGrokStyles || "";
  shadow.appendChild(styleEl);
  const { root, els, setMode } = AskLocalGrokShell.create(article);
  shadow.appendChild(root);

  state.activePanel = host;
  state.activePanelMode = "asklocal";
  state.activeShell = { root, els, setMode };
  state.weOpenedGrok = false;
  state.shellClosed = false;

  const geometry = geometryApi();
  const native = nativeApi();
  state.fallbackMode = !document.querySelector(geometry?.GROK_DRAWER_SELECTOR || '[data-testid="GrokDrawer"]');

  wireShell(host, article, els);

  els.tabButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void setShellMode(button.dataset.tab, { openNative });
    });
  });
  state.switchPanelMode = (mode, opts) => setShellMode(mode, opts || {});
  els.newChat.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    root.__asklocalReset?.(null);
  });
  els.close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void closeMenu();
  });
  els.settings.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const { openAskLocalSettingsFromPanel } = await import("./asklocal-page/index.js");
    openAskLocalSettingsFromPanel();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    void closeMenu();
  });

  if (state.fallbackMode) {
    els.tabButtons.forEach((button) => { if (button.dataset.tab === "grok") button.hidden = true; });
  }

  state.geometrySub = (rect) => {
    if (state.activePanel !== host) return;
    const promoted = promoteFromFallbackIfPossible();
    if (promoted && state.activePanelMode === "asklocal" && !state.shellClosed) {
      void ensureNativeDocked({ openNative: true });
      return;
    }
    // Follow the drawer both ways: cloak it once it expands under us, uncloak it
    // when it collapses (cloaking a collapsed GrokDrawer hides the Grok button).
    if (state.activePanelMode === "asklocal" && !state.shellClosed) cloakNativeIfOpen();
    // Keep every visibility decision in positionPanel(). A late null geometry
    // signal must not permanently override a later successful dock.
    positionPanel();
  };
  geometry?.subscribe(state.geometrySub);

  void setShellMode(initialMode, { openNative, waitForNativeCollapse: true });
}

export async function setShellMode(mode, options = {}) {
  if (!state.activeShell) return;
  state.shellClosed = false;
  state.activePanelMode = mode;
  state.activeShell.setMode(mode);
  const host = state.activePanel;
  if (host) host.dataset.asklocalMode = mode;
  const native = nativeApi();
  const openNative = options.openNative !== false;
  const pendingCollapse = options.waitForNativeCollapse
    ? state.nativeCollapsePromise
    : null;

  if (pendingCollapse) await pendingCollapse;
  // The host may have been destroyed while a close transition was settling.
  if (state.shellClosed || !state.activeShell || state.activePanel !== host) return;

  if (mode === "grok") {
    collapseShell();
    native?.showNative();
    if (openNative && native && !native.isOpen()) {
      const opened = await native.ensureOpen();
      state.weOpenedGrok = opened;
      if (!opened && state.activePanel === host && !state.shellClosed) {
        // The Grok tab is just the uncloaked native drawer; with no drawer to
        // show it would render as an empty slot the user cannot escape from.
        await setShellMode("asklocal", { openNative: false });
        return;
      }
    }
  } else if (!state.fallbackMode) {
    // Show at the drawer's slot straight away — AskLocal must not stay invisible
    // while we negotiate with X's launcher, which can refuse a synthetic click.
    positionPanel();
    if (openNative && native && !native.isOpen()) {
      native.showNative();
      state.weOpenedGrok = await native.ensureOpen();
    }
    // Never cloak if expand failed — that would hide the collapsed Grok FAB forever.
    cloakNativeIfOpen();
  }

  if (state.activePanel !== host || state.shellClosed) return;
  positionPanel();
  window.requestAnimationFrame(() => {
    if (state.activePanel === host && !state.shellClosed) positionPanel();
  });
  if (mode === "asklocal" && host?.style.visibility === "visible") {
    window.setTimeout(() => state.activeShell?.els.textarea.focus(), 0);
  }
}

export function positionPanel() {
  const host = state.activePanel;
  if (!host) return;
  if (state.shellClosed || isXMediaViewerOpen()) {
    host.style.visibility = "hidden";
    host.style.opacity = "0";
    return;
  }
  const geometry = geometryApi();
  const liveRect = geometry?.getGrokRect() ?? null;
  if (liveRect) state.lastGrokRect = liveRect;
  const grokRect = liveRect ?? undockedRect();
  if (!grokRect) {
    host.style.visibility = "hidden";
    host.style.opacity = "0";
    return;
  }
  // When actively chatting the shell grows taller than Grok's default slot so the
  // user can read more of the response — same width/horizontal position, just a
  // smaller top margin and a larger height extending toward the viewport bottom.
  const rect = (state.shellExpanded && state.activePanelMode === "asklocal")
    ? expandedShellRect(grokRect)
    : grokRect;
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
  host.style.visibility = "visible";
  host.style.opacity = "1";
}

/**
 * Where AskLocal sits while the native drawer is collapsed — e.g. X refused the
 * synthetic launcher click after a close. Reusing the drawer's last real rect
 * keeps the shell correctly sized, so docking later is a no-op rather than a
 * resize. Grok mode has nothing to show without the drawer, so it stays hidden.
 */
function undockedRect() {
  if (state.activePanelMode !== "asklocal") return null;
  if (state.fallbackMode) return fallbackRect();
  return state.lastGrokRect ? clampPanelRect(state.lastGrokRect) : null;
}

export function expandedShellRect(grokRect) {
  const gap = 12;
  const top = 56;
  const width = grokRect.width;
  const height = Math.max(grokRect.height, window.innerHeight - top - gap);
  return { left: grokRect.left, top, width, height };
}

export function hideShell() {
  const host = state.activePanel;
  if (!host) return;
  host.style.visibility = "hidden";
  host.style.opacity = "0";
}

/**
 * Close the tabbed shell. AskLocal hides; native Grok is uncloaked and
 * collapsed back to the floating launcher so the Grok button returns.
 */
export async function closeMenu() {
  collapseShell();
  state.shellClosed = true;
  hideShell();

  const native = nativeApi();
  if (state.fallbackMode || !native) {
    destroyShell({ closeNative: false });
    return;
  }

  // Do not leave the drawer cloaked — GrokDrawer is also the collapsed
  // launcher, so hideNative() would make the Grok button vanish forever.
  state.weOpenedGrok = false;
  const collapsePromise = native.collapse();
  state.nativeCollapsePromise = collapsePromise;
  // The first open works because it builds a fresh shell. Tear this one down
  // on close too, so reopening never reuses stale hidden host/styles/listeners.
  destroyShell({ closeNative: false });
  try {
    await collapsePromise;
  } finally {
    // A subsequent close may have started a newer transition.
    if (state.nativeCollapsePromise === collapsePromise) {
      state.nativeCollapsePromise = null;
    }
  }
}

export function reopenShell(article, options = {}) {
  const host = state.activePanel;
  if (!host || !host.isConnected) {
    destroyShell();
    openPanel(article, null, options);
    return;
  }
  const initialMode = options.initialMode === "grok" ? "grok" : "asklocal";
  const openNative = options.openNative !== false;

  state.shellClosed = false;
  collapseShell();
  promoteFromFallbackIfPossible();

  if (article !== null && article !== undefined) {
    state.activeShell?.root.__asklocalReset?.(article);
  }

  // A close click starts an async native collapse. Wait for that transition
  // before opening again, otherwise its late collapse hides this new shell.
  void setShellMode(initialMode, { openNative, waitForNativeCollapse: true });
}

export function expandAskLocalPanel() {
  if (state.shellExpanded) return;
  state.shellExpanded = true;
  positionPanel();
}

export function collapseShell() {
  if (!state.shellExpanded) return;
  state.shellExpanded = false;
  positionPanel();
}

/**
 * Floating collapsed Grok launcher or per-tweet Grok actions. Sidebar Grok nav
 * and expanded-header controls (Collapse, history, …) are ignored.
 */
export function handleNativeGrokLaunch(event) {
  if (event.askLocalInternal) return;
  const native = nativeApi();
  if (native?.isLaunchSuppressed?.()) return;
  if (performance.now() < state.ignoreNativeGrokClickUntil) return;
  if (event.target?.closest?.("[data-asklocal-popout]") || event.target?.closest?.(".asklocal-action-wrapper")) return;

  const floating = Boolean(native?.isFloatingLauncherEvent?.(event));
  const perTweet = !floating && Boolean(native?.isPerTweetGrokEvent?.(event));
  if (!floating && !perTweet) return;

  state.ignoreNativeGrokClickUntil = performance.now() + 600;

  // Let X finish opening/updating native Grok from this click, then attach our
  // tabbed chrome. openNative:false — the user's click already drives the drawer.
  window.setTimeout(() => {
    if (state.activePanel && state.switchPanelMode) {
      if (state.shellClosed) {
        reopenShell(null, { initialMode: "grok", openNative: false });
        return;
      }
      void state.switchPanelMode?.("grok", { openNative: false });
      return;
    }
    if (!state.activePanel) openPanel(null, null, { initialMode: "grok", openNative: false });
  }, floating ? 40 : 80);
}

export function schedulePanelAlignment() {
  if (!state.activePanel || state.alignTimer) return;
  state.alignTimer = window.setTimeout(() => {
    state.alignTimer = null;
    alignActivePanel();
  }, 50);
}

export function alignActivePanel() {
  if (!state.activePanel) return;
  promoteFromFallbackIfPossible();
  positionPanel();
}

export function isXMediaViewerOpen() {
  if (/\/status\/\d+\/(?:photo|video)\/\d+/i.test(location.pathname)) return true;

  return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    .some(isXMediaViewerElement);
}

export function isXMediaViewerElement(element) {
  if (!element || element.closest?.("[data-asklocal-popout]")) return false;
  const rect = element.getBoundingClientRect();
  if (!isVisibleRect(rect)) return false;

  const coversMostViewport = rect.width >= window.innerWidth * 0.55
    && rect.height >= window.innerHeight * 0.55;
  if (!coversMostViewport) return false;

  const hasViewerMedia = Boolean(element.querySelector([
    '[data-testid="swipe-to-dismiss"]',
    '[data-testid="tweetPhoto"]',
    'img[src*="twimg.com/media"]',
    'img[src*="pbs.twimg.com/media"]',
    'video'
  ].join(",")));
  if (!hasViewerMedia) return false;

  const text = normalizePanelText(element.innerText);
  return !text.includes("ask anything") && !text.includes("grok");
}

export function fallbackRect() {
  const desktop = window.innerWidth >= 900;
  const gap = 12;
  const bottomGap = desktop ? GROK_PANEL_BOTTOM_GAP : GROK_PANEL_BOTTOM_GAP_MOBILE;
  const width = desktop ? Math.min(368, window.innerWidth - gap * 2) : Math.min(420, window.innerWidth - gap * 2);
  const left = desktop
    ? window.innerWidth - width - gap
    : Math.round((window.innerWidth - width) / 2);
  const top = desktop ? GROK_PANEL_TOP : GROK_PANEL_TOP_MOBILE;
  return clampPanelRect({
    left,
    top,
    width,
    height: window.innerHeight - top - bottomGap
  });
}

export function isVisibleRect(rect) {
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth;
}

export function clampPanelRect(rect) {
  const gap = 12;
  const maxWidth = Math.min(420, window.innerWidth - gap * 2);
  const width = Math.round(Math.max(300, Math.min(rect.width, maxWidth)));
  const left = Math.round(Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap)));
  const defaultTop = window.innerWidth >= 900 ? GROK_PANEL_TOP : GROK_PANEL_TOP_MOBILE;
  const rawTop = rect.top > window.innerHeight - 300 ? defaultTop : rect.top;
  const top = Math.round(Math.max(56, Math.min(rawTop, window.innerHeight - 180)));
  const maxHeight = Math.max(180, window.innerHeight - top - gap);
  const height = Math.round(Math.max(Math.min(360, maxHeight), Math.min(rect.height, maxHeight)));
  return { left, top, width, height };
}

export function destroyShell(options = {}) {
  const shouldCloseNative = options.closeNative !== false;
  const geometry = geometryApi();
  const native = nativeApi();
  const shouldCollapse = shouldCloseNative && state.weOpenedGrok;

  if (state.geometrySub) {
    geometry?.unsubscribe(state.geometrySub);
    state.geometrySub = null;
  }
  native?.showNative();
  releaseMediaSession(state.activePanel?.dataset?.asklocalMediaSessionId);
  state.activePanel?.remove();
  state.activePanel = null;
  state.activeShell = null;
  state.shellExpanded = false;
  state.shellClosed = false;
  state.activePanelMode = "asklocal";
  state.fallbackMode = false;
  state.ignoreNativeGrokClickUntil = 0;
  state.switchPanelMode = null;
  if (state.alignTimer) {
    window.clearTimeout(state.alignTimer);
    state.alignTimer = null;
  }
  if (shouldCollapse) {
    state.weOpenedGrok = false;
    window.setTimeout(() => { void native?.collapse?.(); }, 140);
  } else {
    state.weOpenedGrok = false;
  }
}

export function releaseMediaSession(mediaSessionId) {
  const id = String(mediaSessionId || "").trim();
  if (!id) return;
  sendMessage({ type: "CLEAR_MEDIA_SESSION", payload: { mediaSessionId: id } }).catch(() => {});
}
