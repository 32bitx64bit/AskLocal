// AskLocal — native Grok drawer control.
// Keeps the expanded drawer mounted for geometry, cloaks it while AskLocal owns
// the slot, and restores/collapses it cleanly on close.
//
// hideNative()  → cloak the native drawer (AskLocal mode)
// showNative()  → reveal it again (Grok mode / on close)
// ensureOpen()  → expand the floating launcher; awaits a valid rect
// collapse()    → click Collapse; awaits the collapsed state

import { AskLocalGrokGeometry } from "./geometry.js";

const HIDE_STYLE_ID = "asklocal-cloak-native-grok";
const OPEN_TIMEOUT_MS = 2000;
const OPEN_PROBE_MS = 500;
const COLLAPSE_TIMEOUT_MS = 1600;

let hideStyleEl = null;
let suppressLaunchUntil = 0;

function isOpen() {
  return Boolean(AskLocalGrokGeometry.getGrokRect());
}

function drawerEl() {
  return document.querySelector(AskLocalGrokGeometry.GROK_DRAWER_SELECTOR || '[data-testid="GrokDrawer"]');
}

function launcherEl() {
  const sel = AskLocalGrokGeometry.GROK_DRAWER_HEADER_SELECTOR || '[data-testid="GrokDrawerHeader"]';
  return [...document.querySelectorAll(sel)].find((el) => !el.closest("article")) ?? null;
}

/** Native body sibling of GrokDrawerHeader (welcome / conversation surface). */
function nativeBodyEl() {
  const drawer = drawerEl();
  if (!drawer) return null;
  const header = drawer.querySelector(AskLocalGrokGeometry.GROK_DRAWER_HEADER_SELECTOR || '[data-testid="GrokDrawerHeader"]');
  return header?.nextElementSibling ?? null;
}

function collapseButton() {
  const drawer = drawerEl();
  if (!drawer) return null;
  return [...drawer.querySelectorAll('button, [role="button"]')].find((c) => {
    const name = (c.getAttribute("aria-label") || "").toLowerCase();
    return name.includes("collapse") || name.includes("close") || name.includes("dismiss") || name.includes("minimize");
  }) ?? null;
}

function isLaunchSuppressed() {
  return performance.now() < suppressLaunchUntil;
}

function suppressLaunchHandling(ms = 800) {
  suppressLaunchUntil = performance.now() + ms;
}

/**
 * Click a native control. Prefer element.click() (React on X handles it reliably);
 * fall back to a tagged MouseEvent so our capture listener can ignore internals.
 */
function clickEl(el) {
  if (!el) return false;
  suppressLaunchHandling();
  try {
    el.click();
    return true;
  } catch {
    /* fall through */
  }
  try {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });
    event.askLocalInternal = true;
    el.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (performance.now() - start >= timeoutMs) {
        resolve(predicate());
        return;
      }
      window.requestAnimationFrame(tick);
    };
    tick();
  });
}

function isVisibleEl(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function drawerHeight() {
  const drawer = drawerEl();
  return drawer ? drawer.getBoundingClientRect().height : 0;
}

function firstControl(root) {
  if (!root) return null;
  return [...root.querySelectorAll('button, [role="button"]')].find(isVisibleEl) ?? null;
}

/**
 * Nodes that can expand the collapsed drawer, innermost first. X binds the
 * expand handler to a button *inside* GrokDrawerHeader in some renders and to
 * the header (or the drawer container) in others — the markup after a
 * programmatic collapse is not the same as the never-expanded markup, which is
 * why a single header click reopens Grok on a fresh page but not afterwards.
 * Resolved lazily because each attempt can make React remount the drawer.
 */
const LAUNCH_TARGETS = [
  () => firstControl(launcherEl()),
  () => launcherEl(),
  () => firstControl(drawerEl()),
  () => drawerEl()
];

/**
 * Full pointer + mouse press. Only used after plain clicks fail: a handler
 * bound to both mousedown and click would otherwise toggle the drawer twice.
 */
function pressEl(el) {
  if (!el) return false;
  suppressLaunchHandling();
  const rect = el.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  const fire = (Ctor, type, extra) => {
    const event = new Ctor(type, { ...base, ...extra });
    event.askLocalInternal = true;
    el.dispatchEvent(event);
  };
  try {
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    fire(PointerEvent, "pointerdown", { ...pointer, button: 0, buttons: 1 });
    fire(MouseEvent, "mousedown", { button: 0, buttons: 1, detail: 1 });
    fire(PointerEvent, "pointerup", { ...pointer, button: 0, buttons: 0 });
    fire(MouseEvent, "mouseup", { button: 0, buttons: 0, detail: 1 });
    fire(MouseEvent, "click", { button: 0, buttons: 0, detail: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand native Grok if collapsed. Resolves true when getGrokRect() is valid.
 * Tries each launch target with a plain click, then with a full press, backing
 * off as soon as the drawer starts growing so a second click cannot re-collapse
 * a drawer that is still animating open.
 */
async function ensureOpen() {
  if (isOpen()) return true;
  if (!drawerEl() && !launcherEl()) return false;

  for (const activate of [clickEl, pressEl]) {
    const tried = new Set();
    for (const resolveTarget of LAUNCH_TARGETS) {
      if (isOpen()) return true;
      const target = resolveTarget();
      if (!isVisibleEl(target) || tried.has(target)) continue;
      tried.add(target);

      const baseline = drawerHeight();
      activate(target);
      if (await waitFor(isOpen, OPEN_PROBE_MS)) return true;
      // Growing but not tall enough yet: let the expand animation finish rather
      // than clicking again, which would toggle the drawer straight back shut.
      if (drawerHeight() > baseline + 4) return waitFor(isOpen, OPEN_TIMEOUT_MS);
    }
  }
  return isOpen();
}

function hideNative() {
  // Never cloak a collapsed drawer — GrokDrawer is also the floating launcher,
  // so cloaking it makes the Grok button vanish and leaves AskLocal with no slot.
  // Also drop any stale cloak left behind after an unexpected collapse.
  if (!isOpen()) {
    showNative();
    return;
  }
  if (!hideStyleEl) {
    hideStyleEl = document.createElement("style");
    hideStyleEl.id = HIDE_STYLE_ID;
    // visibility:hidden (not display:none) so the drawer keeps its expanded
    // layout and AskLocalGrokGeometry keeps returning a valid rect. The whole
    // drawer is cloaked because AskLocal owns the full slot (header + body).
    hideStyleEl.textContent =
      '[data-testid="GrokDrawer"] { visibility: hidden !important; pointer-events: none !important; }';
    document.documentElement.appendChild(hideStyleEl);
  }
}

function showNative() {
  hideStyleEl?.remove();
  hideStyleEl = null;
}

function isCloaked() {
  return Boolean(hideStyleEl?.isConnected);
}

/**
 * Collapse the expanded drawer. Uncloaks first so Collapse remains clickable.
 * Resolves true when the drawer is no longer "open" by our geometry rules.
 */
async function collapse() {
  showNative();
  if (!isOpen()) return true;

  if (clickEl(collapseButton())) {
    if (await waitFor(() => !isOpen(), COLLAPSE_TIMEOUT_MS)) return true;
  }

  const opts = { bubbles: true, cancelable: true, key: "Escape", code: "Escape" };
  document.dispatchEvent(new KeyboardEvent("keydown", opts));
  window.dispatchEvent(new KeyboardEvent("keydown", opts));
  return waitFor(() => !isOpen(), 800);
}

/**
 * True when the event targets the floating collapsed Grok launcher only —
 * not per-tweet Grok actions, sidebar nav, or expanded-header controls.
 */
function isFloatingLauncherEvent(event) {
  if (!event?.target || isLaunchSuppressed()) return false;
  if (isOpen()) return false;

  const launcher = launcherEl();
  if (!launcher) return false;
  if (launcher.closest("article")) return false;

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const hit = path.includes(launcher) || launcher === event.target || launcher.contains(event.target);
  if (!hit) return false;

  // Collapsed launcher is the header button itself (or a button inside it).
  const control = event.target.closest?.('button, [role="button"]');
  if (!control) return false;
  if (control.closest("article")) return false;
  return control === launcher || launcher.contains(control);
}

/**
 * True when the event targets a per-tweet Grok control (not the floating launcher).
 */
function isPerTweetGrokEvent(event) {
  if (!event?.target) return false;
  const control = event.target.closest?.('button, [role="button"]');
  if (!control) return false;
  if (!control.closest?.("article")) return false;
  if (control.closest?.(".asklocal-action-wrapper")) return false;

  const name = [
    control.getAttribute("aria-label"),
    control.getAttribute("title"),
    control.textContent
  ].filter(Boolean).join(" ").trim().toLowerCase();
  const testId = (control.getAttribute("data-testid") || "").toLowerCase();
  return name.includes("grok") || testId.includes("grok");
}

export const AskLocalGrokNative = {
  isOpen,
  ensureOpen,
  hideNative,
  showNative,
  isCloaked,
  collapse,
  launcherEl,
  nativeBodyEl,
  collapseButton,
  clickEl,
  isLaunchSuppressed,
  isFloatingLauncherEvent,
  isPerTweetGrokEvent,
  suppressLaunchHandling
};
