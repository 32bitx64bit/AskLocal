// DOM stub helpers for the SERP extractor challenge tests.
// jsdom gives real querySelectorAll/matches/attachShadow; visibility still needs
// patching because getBoundingClientRect returns zeros.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

export function makeDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html || ""}</body></html>`, {
    url: "https://search.brave.com/search?q=test",
    pretendToBeVisual: true,
    runScripts: "dangerously"
  });
  const { window } = dom;
  // Every element gets a real box unless the test says otherwise, including
  // elements rendered inside shadow roots (querySelectorAll cannot reach them).
  const patch = (el) => {
    if (el.getBoundingClientRect && !el.__patched) {
      el.__patched = true;
      el.getBoundingClientRect = () => ({ x: 10, y: 10, width: 120, height: 32, left: 10, top: 10, right: 130, bottom: 42 });
    }
  };
  const patchAll = (root) => {
    for (const el of root.querySelectorAll("*")) {
      patch(el);
      if (el.shadowRoot) patchAll(el.shadowRoot);
    }
  };
  const observer = new window.MutationObserver(() => patchAll(window.document));
  observer.observe(window.document, { childList: true, subtree: true });
  patchAll(window.document);
  return { dom, window, patch, refresh: () => patchAll(window.document) };
}

export function loadSerp(window) {
  const code = readFileSync(new URL("../../src/serp-extractor.js", import.meta.url), "utf8");
  window.eval(code);
  return window.AskLocalSerp;
}

// Build a Brave-style full-page 429 slider challenge (verified live: no shadow
// DOM, two canvases, .captcha-wrapper[data-state], self-reloading page).
export function braveSliderChallenge() {
  return `
    <div class="captcha-wrapper" data-state="idle">
      <div class="waves-top"></div>
      <div class="captcha-content">
        <div class="captcha-card-wrapper">
          <div class="captcha-card">
            <div class="captcha-icon"><div class="captcha-glyph"></div></div>
            <div class="captcha-text">
              <div class="captcha-title-line"><h1 class="captcha-title">Verifying you're not a bot</h1></div>
              <div class="captcha-subtitle-line"><div class="captcha-subtitle">Quick check before you continue searching.</div></div>
              <div class="captcha-canvas-wrapper">Drag the slider
                <div class="captcha-canvas">
                  <canvas class="captcha-image-canvas" width="310" height="155"></canvas>
                  <canvas class="captcha-slider-canvas" width="310" height="155"></canvas>
                </div>
                <div class="captcha-slider">
                  <button class="captcha-slider-button" aria-label="Drag the slider" style="transform: translateX(0px);"></button>
                  <span class="captcha-slider-text">Drag the slider</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <a href="/">Home</a>`;
}

// Brave's proof-of-work modal over a normal results page.
export function bravePowModal({ disabled = false } = {}) {
  return `
    <main>
      <div class="snippet" data-pos="1"><a class="title" href="https://example.com/a">Example result</a><div class="snippet-description">A description long enough to count as a snippet.</div></div>
      <div class="snippet" data-pos="2"><a class="title" href="https://example.com/b">Another result</a><div class="snippet-description">Another description long enough to count as a snippet.</div></div>
    </main>
    <dialog open>
      <div class="captcha-button-wrap">
        <h2>Why do I have to confirm being human?</h2>
        <button name="captcha-button" class="pow-button"${disabled ? " disabled" : ""}>I'm not a robot</button>
      </div>
    </dialog>`;
}

export function cloudflareInterstitial() {
  return `
    <div id="challenge-running" data-state="verifying">
      <h1>Just a moment...</h1>
      <p>Checking your browser before accessing search.brave.com</p>
    </div>`;
}
