export const ASKLOCAL_PATH = "/i/asklocal";

export function isAskLocalPath(pathname = location.pathname) {
  return pathname === ASKLOCAL_PATH || pathname.startsWith(`${ASKLOCAL_PATH}/`);
}

export function getAskLocalView() {
  try {
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    return view === "settings" ? "settings" : "chat";
  } catch {
    return "chat";
  }
}

export function askLocalUrl(view = "chat") {
  if (view === "settings") return `${ASKLOCAL_PATH}?view=settings`;
  return ASKLOCAL_PATH;
}

export function navigateAskLocal(view = "chat", { replace = false } = {}) {
  const url = askLocalUrl(view);
  const method = replace ? "replaceState" : "pushState";
  try {
    history[method]({ asklocal: true, view }, "", url);
  } catch {
    location.assign(url);
    return;
  }
  window.dispatchEvent(new CustomEvent("asklocal:route", { detail: { view } }));
}

/**
 * Leave the fake /i/asklocal route for a real X path without a full reload.
 * Primary-nav clicks are intercepted (X never registered AskLocal), so we
 * step the URL off AskLocal first, then either replay the nav link click
 * (so X's router handles it) or fire popstate as a fallback.
 */
export function leaveAskLocal(href = "/home", { fromLink = null } = {}) {
  let next = "/home";
  try {
    const url = new URL(href, location.origin);
    if (url.origin === location.origin) next = `${url.pathname}${url.search}${url.hash}`;
  } catch {
    if (typeof href === "string" && href.startsWith("/")) next = href;
  }
  if (isAskLocalPath(next.split("?")[0])) next = "/home";

  try {
    const state = { ...(history.state && typeof history.state === "object" ? history.state : {}), asklocal: false };
    history.replaceState(state, "", next);
    window.dispatchEvent(new CustomEvent("asklocal:route", { detail: { leaving: true } }));

    if (fromLink && typeof fromLink.click === "function") {
      // After replaceState, isAskLocalPath() is false so our nav interceptor
      // won't swallow this — X can handle the navigation itself.
      queueMicrotask(() => {
        try {
          fromLink.click();
        } catch {
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        }
      });
      return;
    }

    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  } catch {
    location.assign(next);
  }
}

export function leaveAskLocalIfNeeded() {
  if (!isAskLocalPath()) return;
  leaveAskLocal("/home");
}
