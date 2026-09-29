// Firefox content scripts run in an isolated world, so the fetch/XHR hooks in
// x-media-sniffer.js never see X's real network traffic unless we inject them
// into the page (MAIN) world. Chrome already loads the sniffer with world:MAIN.
(function injectAskLocalXMediaSniffer() {
  try {
    if (window.__ASKLOCAL_X_MEDIA_SNIFFER__ || window.__ASKLOCAL_X_MEDIA_SNIFFER_INJECTED__) return;
    window.__ASKLOCAL_X_MEDIA_SNIFFER_INJECTED__ = true;
    const api = globalThis.browser ?? globalThis.chrome;
    const src = api?.runtime?.getURL?.("x-media-sniffer.js");
    if (!src) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.documentElement || document.head || document).appendChild(script);
  } catch {
    // Best-effort; URL resolution can still use performance entries / fxtwitter.
  }
})();
