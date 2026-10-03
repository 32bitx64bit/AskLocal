/*
 * Universal SERP (search-engine results page) link extractor.
 *
 * Engine-agnostic: given a rendered SERP document (or any root element) it
 * returns organic results as { url, title, snippet, hostname, position }.
 * Known engines pass optional `hints` (CSS selectors) for precision, but the
 * heuristic backbone works on any search engine, known or unknown, because it
 * looks for the universal SERP shape: a card containing an external link (the
 * title), a URL line, and a description block.
 *
 * This file is injected into hidden search tabs by the background service
 * worker (chrome.scripting) and runs against the live document.
 */
(function (global) {
  "use strict";

  const MAX_TITLE = 240;
  const MAX_SNIPPET = 520;
  const MIN_TITLE_TEXT = 6;
  const MIN_SNIPPET_TEXT = 40;

  // Text that is never a result title. Single-phrase, anchored.
  const BOILERPLATE_RE =
    /^(cached|similar(\s+pages)?|translate(\s+this\s+page)?|view\s+cache|more(\s+results)?|all\s+results|next(\s+page)?|previous(\s+page)?|prev|images?|videos?|news|maps|shopping|web|books|flights|finance|sign\s+in|log\s+in|login|sign\s+up|feedback|report|share|save|bookmark|visit\s+(site|page|website)?|go\s+to\s+(site|website)|anonymous\s+view|open\s+(in\s+new\s+tab|link)|remove|not\s+interested|why\s+this\s+ad|sponsored|ad|menu|search|filter|tools|settings)$/i;

  // Class/id fragments that mark non-organic regions. Nodes matching these are
  // dropped before extraction so sidebars, carousels and knowledge panels do
  // not leak in as results.
  const NOISE_CLASS_RE =
    /\b(menu|sidebar|side-bar|footer|header|navbar|navigation|pagination|pager|related|related-searches|people-also|trending|carousel|cookie|consent|gdpr|promo|advert|advertisement|sponsor|sponsored|social|comment|breadcrumb|knowledge|weather|stock|calculator|local-results|maps-and-directions|image-result|video-result|news-card|story-card|top-stories|discover|explore)\b/i;

  const NOISE_TAG_SELECTOR =
    "script,style,noscript,template,svg,canvas,iframe,form,button,select,aside,nav,header,footer";

  // Query params whose value is the real destination URL (redirect unwrapping).
  const REDIRECT_PARAM_KEYS = [
    "uddg", "url", "u", "q", "rurl", "goto", "dest", "destination",
    "redirect", "redirect_url", "redirect_to", "to", "target", "href"
  ];

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // Light cleanup for titles captured in universal (no-hint) mode: drop a
  // trailing URL breadcrumb (" ... › a › b") that some engines append to the
  // title link. Hinted engines use a dedicated title element so skip there.
  function cleanTitleNoise(title) {
    const chevron = title.indexOf("\u203a");
    if (chevron > 0) return title.slice(0, chevron).trim();
    return title;
  }

  // Last-resort title built from the URL when no readable title text is present.
  // The link itself is the valuable part; a derived title keeps it usable.
  function deriveTitleFromUrl(href, host) {
    try {
      const url = new URL(href);
      const segment = url.pathname.split("/").filter(Boolean).pop() || "";
      let title = decodeURIComponent(segment).replace(/[_+]+/g, " ").trim();
      if (title.length < MIN_TITLE_TEXT) title = host || url.hostname;
      return cleanText(title).slice(0, MAX_TITLE);
    } catch {
      return cleanText(host).slice(0, MAX_TITLE);
    }
  }

  function isBoilerplate(text) {
    const t = cleanText(text);
    if (!t) return true;
    if (BOILERPLATE_RE.test(t)) return true;
    // Pure URL / path strings are not titles.
    if (/^https?:\/\/\S+$/i.test(t)) return true;
    if (/^\/[a-z0-9_\-./?=&%]+$/i.test(t) && t.length < 80) return true;
    return false;
  }

  function normalizeHost(value) {
    return String(value || "").replace(/^www\./, "").toLowerCase();
  }

  function isInternalLink(url, originHosts) {
    const host = normalizeHost(url.hostname);
    if (!host) return true;
    return originHosts.some((origin) => {
      const o = normalizeHost(origin);
      return host === o || host.endsWith("." + o) || o.endsWith("." + host);
    });
  }

  function isNoiseHost(host, originHosts) {
    const h = normalizeHost(host);
    // Drop the engine's own hosts plus generic noise hosts that appear in nav.
    const noise = ["google", "bing", "duckduckgo", "brave", "startpage",
      "microsoft", "msn", "live", "yahoo", "baidu", "yandex", "ecosia"];
    if (noise.some((n) => h === n || h.endsWith("." + n))) return true;
    return isInternalLink({ hostname: h }, originHosts);
  }

  function unwrapRedirect(href, baseUrl) {
    let url;
    try {
      url = new URL(href, baseUrl || undefined);
    } catch {
      return href;
    }
    for (const key of REDIRECT_PARAM_KEYS) {
      const value = url.searchParams.get(key);
      if (!value) continue;
      if (/^https?:\/\//i.test(value)) {
        try {
          return new URL(value).href;
        } catch {
          /* ignore malformed inner url */
        }
        continue;
      }
      // Bing wraps destinations as base64url inside `u` (with an `a1` marker).
      if (key === "u") {
        const decoded = decodeBingRedirectValue(value);
        if (decoded) return decoded;
      }
    }
    return url.href;
  }

  // Bing encodes the real destination as base64url in the `u` query param,
  // prefixed with a version marker such as "a1". This reverses that so the
  // extractor sees the real result URL.
  function decodeBingRedirectValue(value) {
    let v = String(value || "").replace(/^a\d+/, "");
    v = v.replace(/-/g, "+").replace(/_/g, "/");
    while (v.length % 4) v += "=";
    try {
      const decoded = atob(v);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* not base64 */
    }
    return null;
  }

  function looksLikeResultClass(el) {
    const cls = `${el.className || ""} ${el.id || ""}`;
    return /(^|\s|_)(result|snippet|item|card|organic|web-?result|algo|search-?result|link|entry)(\s|$|[-_])/i.test(cls);
  }

  function nodeHasManyLinks(el, limit) {
    return el.querySelectorAll ? el.querySelectorAll("a[href]").length > limit : false;
  }

  // Climb from an anchor to its enclosing result card. Prefer an ancestor whose
  // class signals a result card; otherwise climb a few levels so the card
  // usually includes the title, URL and description together.
  function findCard(anchor, maxDepth) {
    let node = anchor.parentElement;
    let fallback = node;
    let depth = 0;
    while (node && depth < (maxDepth || 6) && node.tagName !== "BODY" && node.tagName !== "HTML") {
      if (looksLikeResultClass(node)) return node;
      fallback = node;
      node = node.parentElement;
      depth += 1;
    }
    return fallback || anchor;
  }

  function pickTitleFromHeading(card, current) {
    if (current && current.length >= 24) return current;
    const heading = card.querySelector
      ? card.querySelector("h1,h2,h3,h4,h5,[role='heading']")
      : null;
    if (heading) {
      const text = cleanText(heading.textContent);
      if (text.length > current.length && !isBoilerplate(text)) return text.slice(0, MAX_TITLE);
    }
    return current;
  }

  // Find the largest descriptive text block in the card that is not the title,
  // not a URL line, and not a link-heavy nav strip.
  function pickSnippet(card, titleText, hints) {
    if (hints && hints.snippet && card.querySelector) {
      const node = card.querySelector(hints.snippet);
      if (node) {
        const text = cleanText(node.textContent);
        if (text.length >= MIN_SNIPPET_TEXT) return text.slice(0, MAX_SNIPPET);
      }
    }
    let best = "";
    const candidates = card.querySelectorAll
      ? card.querySelectorAll("p,span,div,section,li,blockquote")
      : [];
    for (const el of candidates) {
      if (nodeHasManyLinks(el, 1)) continue;
      const text = cleanText(el.textContent);
      if (text.length < MIN_SNIPPET_TEXT || text.length > MAX_SNIPPET + 160) continue;
      if (titleText && text.length <= titleText.length + 4) {
        if (text.includes(titleText) || titleText.includes(text)) continue;
      }
      if (/^https?:\/\/\S+$/i.test(text)) continue;
      if (NOISE_CLASS_RE.test(`${el.className || ""} ${el.id || ""}`)) continue;
      if (text.length > best.length) best = text;
    }
    return best.slice(0, MAX_SNIPPET);
  }

  function resolveCandidates(root, hints) {
    if (!root.querySelectorAll) return [];
    if (hints && hints.container) {
      let containers = [];
      try {
        containers = Array.from(root.querySelectorAll(hints.container));
      } catch {
        containers = [];
      }
      if (containers.length) return containers;
    }
    // No (or no matching) hint: build cards from every external anchor.
    const anchors = Array.from(root.querySelectorAll("a[href]"));
    const cards = [];
    const seen = new Set();
    for (const anchor of anchors) {
      const card = findCard(anchor, 6);
      if (!card || seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }
    return cards;
  }

  function collectCard(card, baseUrl, originHosts, hints) {
    const linkEls = card.matches && card.matches("a[href]")
      ? [card]
      : Array.from(card.querySelectorAll ? card.querySelectorAll("a[href]") : []);

    const scored = [];
    for (const a of linkEls) {
      const raw = a.getAttribute("href") || "";
      if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) continue;
      const resolved = unwrapRedirect(raw, baseUrl);
      let url;
      try {
        url = new URL(resolved);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (isNoiseHost(url.hostname, originHosts)) continue;
      if (isInternalLink(url, originHosts)) continue;
      const text = cleanText(a.textContent);
      // Skip empty/boilerplate anchors but keep them as URL sources for the card
      // (e.g. an icon link may carry the destination even if title text is elsewhere).
      scored.push({ a, url: url.href, host: normalizeHost(url.hostname), text, len: text.length, boilerplate: isBoilerplate(text) });
    }
    if (!scored.length) return null;

    // Prefer a non-boilerplate anchor with the longest text (the title link).
    let chosen = null;
    for (const item of scored) {
      if (item.boilerplate) continue;
      if (item.len < MIN_TITLE_TEXT) continue;
      if (!chosen || item.len > chosen.len) chosen = item;
    }
    // Fallback: any anchor with usable text.
    if (!chosen) {
      chosen = scored
        .filter((item) => item.len >= MIN_TITLE_TEXT)
        .sort((a, b) => b.len - a.len)[0];
    }
    if (!chosen) return null;

    // Prefer an explicit title element when hints name one (authoritative),
    // otherwise fall back to the title link's own text.
    let title = "";
    if (hints && hints.title && card.querySelector) {
      const node = card.querySelector(hints.title);
      if (node) title = cleanText(node.textContent);
    }
    if (!title || title.length < MIN_TITLE_TEXT || isBoilerplate(title)) {
      title = cleanText(chosen.text);
    }
    title = pickTitleFromHeading(card, title);
    title = cleanTitleNoise(title).slice(0, MAX_TITLE);
    // The link is the priority. If the title is still weak (a raw URL, a nav
    // label that slipped through, etc.) derive a readable title from the URL
    // rather than discarding the result.
    if (title.length < MIN_TITLE_TEXT || isBoilerplate(title)) {
      title = deriveTitleFromUrl(chosen.url, chosen.host);
    }
    if (title.length < MIN_TITLE_TEXT) return null;

    const snippet = pickSnippet(card, title, hints);

    return {
      url: chosen.url,
      title,
      snippet,
      hostname: chosen.host,
      position: 0
    };
  }

  function normalizeResultKey(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href.replace(/\/$/, "").toLowerCase();
    } catch {
      return String(url || "").toLowerCase();
    }
  }

  function extract(root, options) {
    const opts = options || {};
    const baseUrl = opts.origin || (typeof location !== "undefined" && location.href) || "";
    const originHosts = Array.isArray(opts.originHosts) ? opts.originHosts : [];
    const hints = opts.hints && typeof opts.hints === "object" ? opts.hints : null;
    const maxResults = Math.max(1, Number(opts.maxResults) || 10);

    const doc = (root && (root.ownerDocument || (root.nodeType === 9 ? root : null))) || (typeof document !== "undefined" ? document : null);
    const source = root || doc;

    if (!source || !source.querySelectorAll) return [];
    // Clone so extraction never strips the live page (captcha widgets, PoW buttons).
    const workingRoot = source.cloneNode(true);

    // Strip obviously non-content nodes up front.
    workingRoot.querySelectorAll(NOISE_TAG_SELECTOR).forEach((node) => {
      const parent = node.parentElement;
      if (parent) parent.removeChild(node);
    });
    // Drop nodes whose class/id mark noise regions (best effort, depth-limited).
    workingRoot.querySelectorAll("[class],[id]").forEach((node) => {
      if (NOISE_CLASS_RE.test(`${node.className || ""} ${node.id || ""}`)) {
        const parent = node.parentElement;
        if (parent && !looksLikeResultClass(node)) parent.removeChild(node);
      }
    });

    const candidates = resolveCandidates(workingRoot, hints);
    const results = [];
    const seen = new Set();
    for (const card of candidates) {
      if (results.length >= maxResults * 2) break;
      const result = collectCard(card, baseUrl, originHosts, hints);
      if (!result) continue;
      const key = normalizeResultKey(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      result.position = results.length + 1;
      results.push(result);
    }
    return results.slice(0, maxResults);
  }

  const CHALLENGE_TEXT_RE = /i.?m not a robot|verify (?:you are|you.?re)(?: a)? human|confirm you.?re (?:a )?human|prove you(?: are|.?re)(?: a)? human|checking your browser|just a moment|attention required|unusual traffic|enable javascript(?: and cookies)?|making sure you.?re not a bot|please (?:verify|complete)(?: the)?(?: security)?(?: check)?|bot (?:check|detection)|are you (?:a )?human|human verification|solve (?:the )?(?:pow )?challenge|confirm you.?re a human being|you.?re not a bot|quick check before you continue/i;
  // Stricter subset used for dialogs: a modal over a normal page is only a challenge
  // when it says so unambiguously (cookie banners and sign-in prompts must not match).
  const MODAL_CHALLENGE_TEXT_RE = /i.?m not a robot|not a (?:robot|bot)\b|prove you(?: are|.?re)(?: a)? human|verify (?:you are|you.?re)(?: a)? human|confirm you.?re (?:a )?human|human verification|bot (?:check|detection)/i;
  const SOLVING_TEXT_RE = /\bverifying\b|verification complete|redirected to/i;
  const AUTO_SOLVE_TEXT_RE = /checking your browser|just a moment|verifying(?: you are human)?|making sure you.?re not a bot|performing security (?:check|verification)|this (?:may|won.?t) take (?:a )?few seconds|proof of work/i;
  const CLICK_TEXT_RE = /i.?m not a robot|verify (?:you are|you.?re)(?: a)? human|verify(?: to continue)?|^verify$|begin(?: verification)?|start(?: verification)?|^continue$|confirm(?: you.?re human)?|pass(?: the)? check/i;
  const CLICK_SKIP_RE = /traditional captcha|privacy|terms|cookie|accept all|reject all|manage (?:cookies|options)|learn more|switch to|sign in|log in|subscribe/i;
  const PUZZLE_SELECTOR = [
    ".rc-imageselect", "#rc-imageselect", ".rc-imageselect-challenge",
    ".geetest_panel", ".geetest_fullpage_click",
    "[class*='hcaptcha'] [class*='task']", ".challenge-container .task-grid"
  ].join(",");
  const WIDGET_SELECTOR = [
    ".cf-turnstile", "#cf-turnstile", "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='turnstile']", ".g-recaptcha", "#g-recaptcha", "iframe[src*='recaptcha']",
    ".h-captcha", "iframe[src*='hcaptcha.com']", "altcha-widget",
    "#challenge-form", "#challenge-running", "#cf-challenge-running",
    "#captcha", ".pow-captcha", "[data-pow]", "[name='cf-turnstile-response']",
    "iframe[src*='captcha']"
  ].join(",");
  // Brave Search shows its proof-of-work check as a modal <dialog> over the fully
  // rendered results page: there is no widget markup and the page is not "thin", so
  // it has to be recognised by the dialog and its verify button.
  const MODAL_SELECTOR = "dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']";
  const POW_BUTTON_SELECTOR = "button[name='captcha-button'], [data-captcha-button]";
  // A click starts the in-page proof-of-work; do not click the same control again
  // while it is still working (a second click would start a second computation).
  const CLICK_COOLDOWN_MS = 20000;
  const clickLog = global.__asklocalSerpClicks || (global.__asklocalSerpClicks = new WeakMap());

  function pageText(doc) {
    const title = doc.title || "";
    const heading = doc.querySelector ? Array.from(doc.querySelectorAll("h1,h2,[role='heading']"))
      .slice(0, 4)
      .map((el) => el.textContent || "")
      .join(" ") : "";
    const body = (doc.body && doc.body.innerText) || "";
    return `${title}\n${heading}\n${body}`.slice(0, 6000);
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style && (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)) {
      return false;
    }
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
    return rect.width >= 2 && rect.height >= 2;
  }

  // Like isVisible, but for containers: ignore opacity (modals fade in) and size
  // rules that only make sense for clickable controls.
  function isRendered(el) {
    if (!el) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    return !(style && (style.visibility === "hidden" || style.display === "none"));
  }

  function findModalChallenge(doc) {
    let modals = [];
    try {
      modals = Array.from(doc.querySelectorAll(MODAL_SELECTOR));
    } catch {
      return null;
    }
    for (const modal of modals) {
      if (!isRendered(modal)) continue;
      if (modal.querySelector && modal.querySelector(POW_BUTTON_SELECTOR)) return modal;
      const text = cleanText(modal.innerText || modal.textContent);
      if (text.length <= 800 && MODAL_CHALLENGE_TEXT_RE.test(text)) return modal;
    }
    return null;
  }

  // True once the page is already computing (or has finished) the check, so the
  // caller should wait instead of clicking again.
  function isChallengeSolving(scope) {
    if (!scope || !scope.querySelector) return false;
    if (scope.matches && scope.matches("[data-state='verifying'], [data-state='solved']")) return true;
    if (scope.querySelector("[data-state='verifying'], [data-state='solved'], [aria-busy='true']")) return true;
    const button = scope.querySelector(POW_BUTTON_SELECTOR);
    if (button && (button.disabled || button.querySelector("[role='progressbar']"))) return true;
    return SOLVING_TEXT_RE.test(cleanText(scope.innerText || scope.textContent).slice(0, 600));
  }

  function elementLabel(el) {
    if (!el) return "";
    const labelled = el.getAttribute && (
      el.getAttribute("aria-label")
      || el.getAttribute("title")
      || el.getAttribute("value")
      || el.getAttribute("name")
    );
    return cleanText([el.innerText, el.textContent, labelled, el.value].filter(Boolean).join(" ")).slice(0, 180);
  }

  function challengeUrlHint() {
    try {
      const href = String((typeof location !== "undefined" && location.href) || "");
      return /\/captcha\b|\/challenge\b|cdn-cgi\/challenge|\/sorry\b|\/sorry\/|challenge-platform|bot[-_]?check/i.test(href);
    } catch {
      return false;
    }
  }

  function inspectChallenge(root) {
    const doc = (root && (root.ownerDocument || (root.nodeType === 9 ? root : null)))
      || (typeof document !== "undefined" ? document : null)
      || root;
    if (!doc || !doc.querySelector) {
      return { detected: false, kind: "", requiresHuman: false, clickable: false, autoSolving: false, label: "" };
    }

    const text = pageText(doc);
    const linkCount = doc.querySelectorAll("a[href]").length;
    const thinPage = text.length < 2800 && linkCount < 16;
    const puzzle = doc.querySelector(PUZZLE_SELECTOR);
    const widget = doc.querySelector(WIDGET_SELECTOR);
    const strongText = CHALLENGE_TEXT_RE.test(doc.title || "") || CHALLENGE_TEXT_RE.test(text);
    const urlHint = challengeUrlHint();
    const modal = findModalChallenge(doc);
    const detected = Boolean(puzzle || widget || urlHint || modal || (thinPage && strongText));
    // Over a normal results page the full page text says nothing about the check
    // ("verifying" is an ordinary word), so judge progress by the dialog alone.
    const scope = modal || doc.body || doc;
    const scopeText = modal ? cleanText(modal.innerText || modal.textContent) : text;
    const solving = Boolean(detected && !puzzle && isChallengeSolving(scope));
    const autoSolving = Boolean(detected && !puzzle && (solving || AUTO_SOLVE_TEXT_RE.test(scopeText)));
    const clickTarget = detected && !puzzle && !autoSolving ? findChallengeClickTarget(modal || doc) : null;

    let kind = "";
    if (puzzle) kind = "puzzle";
    else if (widget && /turnstile|cloudflare/i.test(widget.outerHTML || widget.className || "")) kind = "turnstile";
    else if (widget && /recaptcha/i.test(widget.outerHTML || widget.className || widget.src || "")) kind = "recaptcha";
    else if (modal || clickTarget || /not a robot|proof of work|pow/i.test(scopeText)) kind = "pow";
    else if (autoSolving) kind = "interstitial";
    else if (detected) kind = "challenge";

    return {
      detected,
      kind,
      requiresHuman: Boolean(puzzle),
      clickable: Boolean(clickTarget),
      autoSolving,
      label: elementLabel(clickTarget) || (detected ? cleanText((doc.title || text).slice(0, 120)) : "")
    };
  }

  function findChallengeClickTarget(doc) {
    const nodes = Array.from(doc.querySelectorAll(
      "button, input[type=submit], input[type=button], input[type=checkbox], a[role=button], [role=button], [role=checkbox], label, .mark, .cb-lb"
    ));
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = elementLabel(el) || elementLabel(el.closest && el.closest("label,button,.cb-lb"));
      if (CLICK_SKIP_RE.test(label)) continue;
      let score = 0;
      if (el.matches && el.matches(POW_BUTTON_SELECTOR)) score += 8;
      if (CLICK_TEXT_RE.test(label)) score += 6;
      if (/not a robot/i.test(label)) score += 4;
      if (el.matches && el.matches("input[type=checkbox], [role=checkbox]")) score += 2;
      if (el.tagName === "BUTTON" || (el.getAttribute && el.getAttribute("type") === "submit")) score += 1;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore >= 6 ? best : null;
  }

  function realClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ block: "center", inline: "center" });
    } catch {
      /* ignore */
    }
    const opts = { bubbles: true, cancelable: true, view: el.ownerDocument?.defaultView || undefined };
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch { /* ignore */ }
    // Exactly one click. Dispatching a click event and then calling click() fires two
    // before the page has disabled the button, which starts the proof-of-work twice.
    try {
      if (typeof el.click === "function") el.click();
      else el.dispatchEvent(new MouseEvent("click", opts));
    } catch { /* ignore */ }
    if (el.tagName === "INPUT" && el.type === "checkbox" && !el.checked) {
      try {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  function tryPassChallenge(root) {
    const info = inspectChallenge(root);
    if (!info.detected || info.requiresHuman) return { ...info, clicked: false };
    // The page is already computing the check (or auto-starts it): just wait.
    if (info.autoSolving) return { ...info, clicked: false };
    const doc = (root && (root.ownerDocument || (root.nodeType === 9 ? root : null)))
      || (typeof document !== "undefined" ? document : null)
      || root;
    const scope = findModalChallenge(doc) || doc;
    const target = findChallengeClickTarget(scope) || fallbackChallengeClickTarget(scope);
    if (!target) return { ...info, clickable: false, clicked: false };
    const lastClick = clickLog.get(target);
    if (lastClick && Date.now() - lastClick < CLICK_COOLDOWN_MS) {
      return { ...info, clickable: true, clicked: false, autoSolving: true };
    }
    clickLog.set(target, Date.now());
    // A click starts the in-page work, so from here on the caller is waiting on it.
    return { ...info, clickable: true, clicked: realClick(target), autoSolving: true };
  }

  function fallbackChallengeClickTarget(doc) {
    const nodes = Array.from(doc.querySelectorAll(
      "input[type=checkbox], [role=checkbox], button, input[type=submit], input[type=button], .mark, .cb-lb"
    ));
    return nodes.find((el) => isVisible(el) && !CLICK_SKIP_RE.test(elementLabel(el))) || null;
  }

  global.AskLocalSerp = { extract, inspectChallenge, tryPassChallenge };
})(typeof globalThis !== "undefined" ? globalThis : this);
