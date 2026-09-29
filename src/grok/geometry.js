// AskLocal — single source of truth for the native Grok drawer's geometry.
// Replaces the legacy cache/prime/fallback-rect guesswork with one live reader.
//
// getGrokRect() returns the expanded drawer's viewport rect (or null when Grok
// is collapsed/absent). subscribe(cb) fires cb(rect) on changes. Signals:
//   - body-level MutationObserver: GrokDrawer may be remounted or restyled by
//     React; watching document.body subtree catches mount/replacement so we
//     re-bind element observers.
//   - ResizeObserver on the current drawer: catches same-element resizes
//     (e.g. expand animation frames, content growing while a message streams).
//   - MutationObserver on the current drawer: catches attr/childList re-renders.
//   - window resize/scroll: reposition when the viewport moves.
// All signals are rAF-debounced and deduped by rect key so cb only fires on
// actual geometry changes.
//
// Live layout note (x.com): GrokDrawer itself is often position:relative inside
// a fixed bottom dock — use getBoundingClientRect(), not assumed fixed offsets.
// Native body is GrokDrawerHeader.nextElementSibling.

const GROK_DRAWER_SELECTOR = '[data-testid="GrokDrawer"]';
const GROK_DRAWER_HEADER_SELECTOR = '[data-testid="GrokDrawerHeader"]';
const EXPANDED_MIN_HEIGHT = 150;

const subs = new Set();
let started = false;
let frame = null;
let lastKey = "\u0000";
let bodyObserver = null;
let resizeObserver = null;
let mutationObserver = null;
let observedDrawer = null;

function getGrokRect() {
  const drawer = document.querySelector(GROK_DRAWER_SELECTOR);
  if (!drawer) return null;
  const r = drawer.getBoundingClientRect();
  if (r.width <= 0 || r.height < EXPANDED_MIN_HEIGHT) return null;
  if (r.bottom <= 0 || r.right <= 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
    return null;
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function getNativeBodyEl() {
  const drawer = document.querySelector(GROK_DRAWER_SELECTOR);
  if (!drawer) return null;
  const header = drawer.querySelector(GROK_DRAWER_HEADER_SELECTOR);
  return header?.nextElementSibling ?? null;
}

function drawerPresent() {
  return Boolean(document.querySelector(GROK_DRAWER_SELECTOR));
}

function keyOf(rect) {
  return rect
    ? `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`
    : "none";
}

function flush() {
  frame = null;
  const rect = getGrokRect();
  const k = keyOf(rect);
  if (k === lastKey) return;
  lastKey = k;
  for (const cb of subs) {
    try { cb(rect); } catch { /* a subscriber throwing must not break others */ }
  }
}

function schedule() {
  if (frame) return;
  frame = window.requestAnimationFrame(() => { frame = null; rebindIfNeeded(); flush(); });
}

function rebindIfNeeded() {
  const drawer = document.querySelector(GROK_DRAWER_SELECTOR);
  if (drawer === observedDrawer) return;
  observedDrawer = drawer;
  if (resizeObserver) { try { resizeObserver.disconnect(); } catch { /* ignore */ } }
  if (mutationObserver) { try { mutationObserver.disconnect(); } catch { /* ignore */ } }
  if (!drawer) return;
  if (!resizeObserver) resizeObserver = new ResizeObserver(schedule);
  if (!mutationObserver) mutationObserver = new MutationObserver(schedule);
  try { resizeObserver.observe(drawer); } catch { /* ignore */ }
  try {
    mutationObserver.observe(drawer, {
      attributes: true,
      attributeFilter: ["style", "class"],
      childList: true,
      subtree: true
    });
  } catch { /* ignore */ }
}

function start() {
  if (started) return;
  started = true;
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  bodyObserver = new MutationObserver(schedule);
  try {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  } catch { /* ignore */ }
  rebindIfNeeded();
}

function subscribe(cb) {
  subs.add(cb);
  start();
  schedule();
}

function unsubscribe(cb) {
  subs.delete(cb);
  if (subs.size === 0) teardown();
}

function teardown() {
  if (bodyObserver) { try { bodyObserver.disconnect(); } catch { /* ignore */ } bodyObserver = null; }
  if (resizeObserver) { try { resizeObserver.disconnect(); } catch { /* ignore */ } resizeObserver = null; }
  if (mutationObserver) { try { mutationObserver.disconnect(); } catch { /* ignore */ } mutationObserver = null; }
  if (started) {
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, { capture: true });
  }
  if (frame) {
    try { window.cancelAnimationFrame(frame); } catch { /* ignore */ }
    frame = null;
  }
  observedDrawer = null;
  started = false;
  lastKey = "\u0000";
}

export const AskLocalGrokGeometry = {
  getGrokRect,
  getNativeBodyEl,
  drawerPresent,
  subscribe,
  unsubscribe,
  teardown,
  GROK_DRAWER_SELECTOR,
  GROK_DRAWER_HEADER_SELECTOR,
  EXPANDED_MIN_HEIGHT
};
