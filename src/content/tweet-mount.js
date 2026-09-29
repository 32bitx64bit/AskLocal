import { api } from "./api.js";
import {
  ASKLOCAL_ATTR,
  ASK_BUTTON_GROK_GAP,
  ASK_BUTTON_WIDTH,
  TWEET_ARTICLE_SELECTOR
} from "./constants.js";
import {
  openPanel,
  schedulePanelAlignment
} from "./panel-controller.js";
import {
  state
} from "./state.js";

export function queryTweetArticles(root = document) {
  const tagged = root.querySelectorAll(TWEET_ARTICLE_SELECTOR);
  return tagged.length ? [...tagged] : [...root.querySelectorAll("article")];
}
export function mountVisibleTweets() {
  if (state.settings?.enabled === false) return;
  for (const article of queryTweetArticles()) {
    if (shouldSkipArticle(article)) {
      removeMountedControls(article);
      article.removeAttribute(ASKLOCAL_ATTR);
      continue;
    }

    if (hasMountedControl(article)) {
      alignMountedControls(article);
      article.setAttribute(ASKLOCAL_ATTR, "true");
      continue;
    }

    const mountPoint = findHeaderMountPoint(article);
    if (!mountPoint) continue;

    const button = createActionButton(article, mountPoint.mode);
    mountPoint.container.insertBefore(button, mountPoint.before ?? null);
    article.setAttribute(ASKLOCAL_ATTR, "true");
  }
}
export function cleanupMountedControls() {
  document.querySelectorAll(".asklocal-action-wrapper").forEach((element) => element.remove());
  document.querySelectorAll(`[${ASKLOCAL_ATTR}]`).forEach((element) => element.removeAttribute(ASKLOCAL_ATTR));
}
export function hasMountedControl(article) {
  return [...article.querySelectorAll(".asklocal-action-wrapper")]
    .some((element) => element.closest("article") === article);
}
export function removeMountedControls(article) {
  [...article.querySelectorAll(".asklocal-action-wrapper")]
    .filter((element) => element.closest("article") === article)
    .forEach((element) => element.remove());
}
export function handleViewportChange() {
  schedulePanelAlignment();
  alignAllMountedControls();
}
export function alignAllMountedControls() {
  queryTweetArticles().forEach(alignMountedControls);
}
export function alignMountedControls(article) {
  const container = [...article.querySelectorAll(".asklocal-grok-offset")]
    .find((element) => element.closest("article") === article);
  if (!container) return;

  const anchor = container.__asklocalAnchor?.isConnected
    ? container.__asklocalAnchor
    : findTopGrokControl(article);
  if (anchor) alignContainerToControl(article, container, anchor);
}
export function findHeaderMountPoint(article) {
  if (shouldSkipArticle(article)) return null;

  const articleRect = article.getBoundingClientRect();
  const controls = [...article.querySelectorAll('button, [role="button"]')]
    .filter((control) => {
      const rect = control.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const isHeaderBand = rect.top >= articleRect.top && rect.top <= articleRect.top + 76;
      const isRightSide = rect.left >= articleRect.left + articleRect.width * 0.45;
      return isHeaderBand && isRightSide;
    });

  const grok = findTopGrokControl(article, controls);
  if (grok) {
    return createControlOffsetMountPoint(article, grok);
  }

  const inferredGrok = inferUnlabeledGrokControl(controls);
  if (inferredGrok) {
    return createControlOffsetMountPoint(article, inferredGrok);
  }

  return null;
}
export function shouldSkipArticle(article) {
  if (location.pathname.startsWith("/notifications")) return true;
  // X wraps ads in a placementTracking container (verified live); the "Promoted" text line
  // is kept as a locale-dependent fallback for older markup.
  if (article.closest('[data-testid="placementTracking"]')) return true;
  return article.innerText
    .split("\n")
    .some((line) => line.trim().toLowerCase() === "promoted");
}
export function inferUnlabeledGrokControl(controls) {
  const more = controls.find((control) => {
    const name = getControlName(control);
    const testId = control.getAttribute("data-testid") ?? "";
    return name.includes("more") || name.includes("overflow") || testId === "caret";
  });
  if (!more) return null;

  const moreRect = more.getBoundingClientRect();
  const candidates = controls
    .filter((control) => control !== more)
    .map((control) => ({ control, rect: control.getBoundingClientRect(), name: getControlName(control) }))
    .filter(({ control, rect, name }) => {
      if (control.closest(".asklocal-action-wrapper")) return false;
      if (name.includes("follow") || name.includes("subscribe") || name.includes("more") || name.includes("overflow")) {
        return false;
      }
      const sameRow = Math.abs((rect.top + rect.height / 2) - (moreRect.top + moreRect.height / 2)) <= 8;
      const closeToMore = moreRect.left - rect.right >= 0 && moreRect.left - rect.right <= 48;
      const iconSized = rect.width >= 20 && rect.width <= 48 && rect.height >= 20 && rect.height <= 48;
      return sameRow && closeToMore && iconSized;
    })
    .sort((a, b) => b.rect.left - a.rect.left);

  return candidates[0]?.control ?? null;
}
export function getControlName(control) {
  return [
    control.getAttribute("aria-label"),
    control.getAttribute("title"),
    control.textContent
  ].filter(Boolean).join(" ").trim().toLowerCase();
}
export function findTopGrokControl(article, controls = null) {
  const candidates = controls ?? [...article.querySelectorAll('button, [role="button"]')];
  return candidates.find((control) => {
    const name = getControlName(control);
    const testId = control.getAttribute("data-testid")?.toLowerCase() ?? "";
    return name.includes("grok") || testId.includes("grok");
  });
}
export function createControlOffsetMountPoint(article, anchor) {
  const computedPosition = getComputedStyle(article).position;
  if (computedPosition === "static") article.style.position = "relative";

  const container = document.createElement("div");
  container.className = "asklocal-action-wrapper asklocal-header-overlay asklocal-grok-offset";
  container.__asklocalAnchor = anchor;
  container.style.cssText = [
    "align-items:center",
    "display:flex",
    "height:34px",
    "justify-content:center",
    "pointer-events:auto",
    "position:absolute",
    `width:${ASK_BUTTON_WIDTH}px`,
    "z-index:30"
  ].join(";");

  article.appendChild(container);
  alignContainerToControl(article, container, anchor);
  return { container, before: null, mode: "overlay" };
}
export function alignContainerToControl(article, container, anchor) {
  const articleRect = article.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  if (anchorRect.width < 8 || anchorRect.height < 8) return;

  const left = Math.max(8, Math.round(anchorRect.left - articleRect.left - ASK_BUTTON_WIDTH - ASK_BUTTON_GROK_GAP));
  const top = Math.max(4, Math.round(anchorRect.top - articleRect.top + (anchorRect.height - 34) / 2));
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;
}
export function createHeaderOverlayMountPoint(article) {
  const computedPosition = getComputedStyle(article).position;
  if (computedPosition === "static") article.style.position = "relative";

  const container = document.createElement("div");
  container.className = "asklocal-action-wrapper asklocal-header-overlay";
  container.style.cssText = [
    "align-items:center",
    "display:flex",
    "justify-content:center",
    "pointer-events:auto",
    "position:absolute",
    "right:84px",
    "top:10px",
    `width:${ASK_BUTTON_WIDTH}px`,
    "z-index:30"
  ].join(";");

  article.appendChild(container);
  return { container, before: null, mode: "overlay" };
}
export function createActionButton(article, mode) {
  const isCompact = mode === "overlay" || mode === "header";
  const wrapper = document.createElement("div");
  wrapper.className = mode === "header" ? "asklocal-action-wrapper" : "";
  wrapper.style.cssText = [
    "align-items:center",
    "display:flex",
    "justify-content:center",
    isCompact ? `width:${ASK_BUTTON_WIDTH}px` : "margin:0 2px",
    "pointer-events:auto",
    "position:relative",
    "z-index:31"
  ].join(";");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = isCompact ? "Ask" : "AskLocal";
  button.setAttribute("aria-label", "AskLocal");
  button.setAttribute("title", "AskLocal");
  button.style.cssText = [
    "appearance:none",
    "border:0",
    "background:transparent",
    "color:rgb(113,118,123)",
    "cursor:pointer",
    "align-items:center",
    "display:inline-flex",
    "justify-content:center",
    "font:inherit",
    isCompact ? "font-size:12px" : "font-size:13px",
    "font-weight:700",
    "height:34px",
    "letter-spacing:0",
    "line-height:34px",
    isCompact ? "padding:0" : "padding:0 12px",
    "border-radius:999px",
    "pointer-events:auto",
    isCompact ? `width:${ASK_BUTTON_WIDTH}px` : "min-width:76px"
  ].join(";");

  const handleOpen = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    openPanel(article, button);
  };

  button.addEventListener("mouseenter", () => {
    button.style.color = "rgb(29,155,240)";
    button.style.background = "rgba(29,155,240,0.1)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.color = "rgb(113,118,123)";
    button.style.background = "transparent";
  });
  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }, true);
  wrapper.addEventListener("click", handleOpen, true);
  button.addEventListener("click", handleOpen, true);

  wrapper.appendChild(button);
  return wrapper;
}

