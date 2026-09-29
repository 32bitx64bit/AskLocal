import {
  navigateAskLocal,
  isAskLocalPath,
  leaveAskLocal,
  ASKLOCAL_PATH
} from "./asklocal-page/router.js";
import {
  getRuntimeUrl
} from "./runtime.js";

const NAV_ATTR = "data-asklocal-nav";
const GROK_HREF = "/i/grok";
const ASKLOCAL_HREF = ASKLOCAL_PATH;

function primaryNav() {
  return document.querySelector('nav[aria-label="Primary"]');
}

function grokLink(nav = primaryNav()) {
  if (!nav) return null;
  return [...nav.querySelectorAll("a[href]")].find((a) => {
    const href = a.getAttribute("href") || "";
    return href === GROK_HREF || href.startsWith(`${GROK_HREF}?`);
  }) ?? null;
}

function fallbackNavLink(nav = primaryNav()) {
  if (!nav) return null;
  return [...nav.querySelectorAll("a[href]")].find((a) => {
    const href = a.getAttribute("href") || "";
    return href === "/home" || href === "/explore";
  }) ?? nav.querySelector("a[href]");
}

function existingNavLink(nav = primaryNav()) {
  return nav?.querySelector(`a[${NAV_ATTR}]`) ?? null;
}

function syncActiveState(link) {
  if (!link) return;
  const active = isAskLocalPath(location.pathname);
  link.classList.toggle("asklocal-nav-active", active);
  if (active) link.setAttribute("aria-current", "page");
  else link.removeAttribute("aria-current");
}

function applyNavIcon(link) {
  const iconUrl = getRuntimeUrl("icons/icon-32.png");
  if (!iconUrl) return;

  const makeImg = () => {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.width = 26;
    img.height = 26;
    img.decoding = "async";
    img.setAttribute("data-asklocal-nav-icon", "true");
    img.style.cssText = [
      "width:26.25px",
      "height:26.25px",
      "display:block",
      "border-radius:6px",
      "object-fit:contain",
      "flex-shrink:0"
    ].join(";");
    return img;
  };

  const svgs = [...link.querySelectorAll("svg")];
  if (svgs.length) {
    for (const svg of svgs) svg.replaceWith(makeImg());
    return;
  }

  const existing = link.querySelector("img[data-asklocal-nav-icon]");
  if (existing) {
    if (existing.getAttribute("src") !== iconUrl) existing.src = iconUrl;
    return;
  }

  // Fallback: insert before the label text if the template had no icon node.
  const label = [...link.querySelectorAll("span, div")].find((el) => /asklocal/i.test(el.textContent || ""));
  if (label?.parentElement) label.parentElement.insertBefore(makeImg(), label);
}

function buildNavLink(template) {
  const link = template.cloneNode(true);
  link.setAttribute(NAV_ATTR, "true");
  link.setAttribute("href", ASKLOCAL_HREF);
  link.setAttribute("aria-label", "AskLocal");
  link.removeAttribute("data-testid");

  // Replace visible label text nodes while keeping layout structure.
  const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.trim()) {
      texts.push(walker.currentNode);
    }
  }
  for (const node of texts) {
    if (/grok/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/grok/gi, "AskLocal");
    else if (node.nodeValue.trim().length <= 16) node.nodeValue = "AskLocal";
  }

  applyNavIcon(link);

  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    navigateAskLocal("chat");
  });

  return link;
}

function ensureNavStyles() {
  if (document.getElementById("asklocal-nav-style")) return;
  const style = document.createElement("style");
  style.id = "asklocal-nav-style";
  // X paints nav hover via React/testid selectors that our clone never hits.
  style.textContent = `
    a[data-asklocal-nav] {
      cursor: pointer;
    }
    a[data-asklocal-nav] > div {
      border-radius: 9999px;
      transition: background-color 0.2s ease;
    }
    a[data-asklocal-nav]:hover > div,
    a[data-asklocal-nav]:focus-visible > div {
      background-color: color-mix(in srgb, currentColor 10%, transparent);
    }
    a[data-asklocal-nav].asklocal-nav-active {
      font-weight: 700;
    }
    a[data-asklocal-nav] img[data-asklocal-nav-icon] {
      width: 26.25px;
      height: 26.25px;
      border-radius: 6px;
      object-fit: contain;
    }
  `;
  document.documentElement.appendChild(style);
}

export function injectAskLocalNav() {
  ensureNavStyles();
  const nav = primaryNav();
  if (!nav) return false;

  const anchor = grokLink(nav) || fallbackNavLink(nav);
  if (!anchor) return false;

  let link = existingNavLink(nav);
  if (link) {
    if (link.previousElementSibling !== anchor && anchor.nextElementSibling !== link) {
      anchor.insertAdjacentElement("afterend", link);
    }
    applyNavIcon(link);
    syncActiveState(link);
    return true;
  }

  link = buildNavLink(anchor);
  anchor.insertAdjacentElement("afterend", link);
  syncActiveState(link);
  return true;
}

export function startAskLocalNav() {
  injectAskLocalNav();

  const observer = new MutationObserver(() => {
    injectAskLocalNav();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const onNav = () => syncActiveState(existingNavLink());
  window.addEventListener("popstate", onNav);
  window.addEventListener("asklocal:route", onNav);

  // /i/asklocal is extension-owned. X's router will not leave it on its own when
  // Home/Grok/etc. are clicked — take over those exits ourselves.
  const onPrimaryNavClick = (event) => {
    if (!isAskLocalPath()) return;
    const nav = primaryNav();
    if (!nav) return;
    const link = event.target?.closest?.("a[href]");
    if (!link || !nav.contains(link)) return;
    if (link.hasAttribute(NAV_ATTR)) return;

    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
    if (href === ASKLOCAL_HREF || href.startsWith(`${ASKLOCAL_HREF}?`) || href.startsWith(`${ASKLOCAL_HREF}/`)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    leaveAskLocal(href, { fromLink: link });
  };
  document.addEventListener("click", onPrimaryNavClick, true);

  return () => {
    observer.disconnect();
    window.removeEventListener("popstate", onNav);
    window.removeEventListener("asklocal:route", onNav);
    document.removeEventListener("click", onPrimaryNavClick, true);
  };
}
