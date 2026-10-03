import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bravePowModal,
  braveSliderChallenge,
  cloudflareInterstitial,
  loadSerp,
  makeDom
} from "./helpers/dom-stub.js";

function setup(html) {
  const { window } = makeDom(html);
  const serp = loadSerp(window);
  return { window, serp, doc: window.document };
}

test("Brave's full-page slider check is a puzzle that needs a person", () => {
  const { serp, doc } = setup(braveSliderChallenge());
  doc.title = "Captcha - Brave Search";
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true);
  assert.equal(info.requiresHuman, true);
  // The page says "Verifying" but nothing is computing: it must not be read as
  // auto-solving, or the search waits out its whole timeout for nothing.
  assert.equal(info.autoSolving, false);
  assert.equal(info.clickable, false);
  const attempt = serp.tryPassChallenge(doc);
  assert.equal(attempt.requiresHuman, true);
  assert.equal(attempt.clicked, false);
});

test("a click never fires on the slider check", () => {
  const { serp, doc } = setup(braveSliderChallenge());
  doc.title = "Captcha - Brave Search";
  let clicks = 0;
  const button = doc.querySelector(".captcha-slider-button");
  button.addEventListener("click", () => { clicks += 1; });
  serp.tryPassChallenge(doc);
  assert.equal(clicks, 0);
  // A recorded click would make the retry report cooldown; it must not.
  const retry = serp.tryPassChallenge(doc);
  assert.equal(retry.clicked, false);
  assert.equal(retry.autoSolving, false);
});

test("Brave's proof-of-work dialog is clicked even while its button is disabled", () => {
  const { serp, doc } = setup(bravePowModal({ disabled: true }));
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true);
  // Disabled-until-ready must not look like already-solving.
  assert.equal(info.autoSolving, false);
  assert.equal(info.clickable, true);
  assert.equal(info.kind, "pow");

  let clicks = 0;
  const button = doc.querySelector("button[name='captcha-button']");
  button.addEventListener("click", () => { clicks += 1; });
  const attempt = serp.tryPassChallenge(doc);
  assert.equal(attempt.clicked, true);
  assert.equal(attempt.clickable, true);
  assert.equal(attempt.autoSolving, true);
  assert.equal(clicks, 1, "exactly one click, not a double fire");
});

test("the click lifts the disabled gate and the page keeps control", () => {
  const { serp, doc } = setup(bravePowModal({ disabled: true }));
  const button = doc.querySelector("button[name='captcha-button']");
  const seen = [];
  button.addEventListener("click", () => { seen.push(`disabled=${button.disabled}`); });
  serp.tryPassChallenge(doc);
  // The handler ran with the gate lifted, so Brave's own logic (re)disabling the
  // control afterwards is never fought.
  assert.deepEqual(seen, ["disabled=false"]);
});

test("a disabled button after our click reads as solving, so it is not re-clicked", () => {
  const { serp, doc } = setup(bravePowModal({ disabled: true }));
  const button = doc.querySelector("button[name='captcha-button']");
  serp.tryPassChallenge(doc);
  const again = serp.tryPassChallenge(doc);
  assert.equal(again.clicked, false, "cooldown prevents a second click");
  assert.equal(again.autoSolving, true);
  const solving = serp.inspectChallenge(doc);
  assert.equal(solving.autoSolving, true);
  assert.equal(solving.clickable, false);
  assert.equal(button.disabled, true);
});

test("a challenge hidden in a shadow root is still detected and clicked", () => {
  const { window, refresh } = makeDom(`<main><div class="snippet"><a href="https://example.com/x">Example</a></div></main>`);
  const serp = loadSerp(window);
  const doc = window.document;
  const host = doc.createElement("brave-pow-check");
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<dialog open><button name="captcha-button">I'm not a robot</button></dialog>`;
  refresh();
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true, "modal found through the shadow boundary");
  assert.equal(info.kind, "pow");

  let clicks = 0;
  const button = shadow.querySelector("button[name='captcha-button']");
  button.addEventListener("click", () => { clicks += 1; });
  const attempt = serp.tryPassChallenge(doc);
  assert.equal(attempt.clicked, true);
  assert.equal(clicks, 1);
  assert.ok(window.__asklocalSerpClicks instanceof window.WeakMap);
});

test("a challenge announced only inside shadow text is detected", () => {
  const { window } = makeDom(`<main></main>`);
  const serp = loadSerp(window);
  const doc = window.document;
  const host = doc.createElement("check-widget");
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<div class="notice">Are you a human? Please complete the security check</div>`;
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true);
  assert.equal(info.requiresHuman, false);
});

test("an interstitial that computes on its own is waited on, not clicked", () => {
  const { serp, doc } = setup(cloudflareInterstitial());
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true);
  assert.equal(info.autoSolving, true);
  assert.equal(info.clickable, false);
  const attempt = serp.tryPassChallenge(doc);
  assert.equal(attempt.clicked, false);
  assert.equal(attempt.autoSolving, true);
});

test("a page that merely contains the word verifying is not a challenge", () => {
  const { serp, doc } = setup(`
    <h1>Verifying your configuration</h1>
    <p>${"Word ".repeat(300)}</p>
    <a href="https://example.com/1">One</a><a href="https://example.com/2">Two</a>
    <a href="https://example.com/3">Three</a><a href="https://example.com/4">Four</a>
    <a href="https://example.com/5">Five</a><a href="https://example.com/6">Six</a>
    <a href="https://example.com/7">Seven</a><a href="https://example.com/8">Eight</a>
    <a href="https://example.com/9">Nine</a><a href="https://example.com/10">Ten</a>
    <a href="https://example.com/11">Eleven</a><a href="https://example.com/12">Twelve</a>
    <a href="https://example.com/13">Thirteen</a><a href="https://example.com/14">Fourteen</a>
    <a href="https://example.com/15">Fifteen</a><a href="https://example.com/16">Sixteen</a>`);
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, false);
  assert.equal(info.autoSolving, false);
});

test("a thin verification prompt with a verify button is clicked once", () => {
  const { serp, doc } = setup(`
    <h1>Verifying you're not a bot</h1>
    <p>Quick check before you continue.</p>
    <button type="button">Verify you are human</button>
    <a href="/">Home</a>`);
  const info = serp.inspectChallenge(doc);
  assert.equal(info.detected, true);
  assert.equal(info.autoSolving, false);
  assert.equal(info.clickable, true);
  let clicks = 0;
  const button = doc.querySelector("button");
  button.addEventListener("click", () => { clicks += 1; });
  const attempt = serp.tryPassChallenge(doc);
  assert.equal(attempt.clicked, true);
  assert.equal(clicks, 1);
});

test("the click carries pointer and mouse events with coordinates", () => {
  const { serp, doc } = setup(bravePowModal());
  const button = doc.querySelector("button[name='captcha-button']");
  const seen = [];
  for (const type of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
    button.addEventListener(type, (event) => {
      seen.push({ type, composed: event.composed, x: event.clientX, y: event.clientY });
    });
  }
  serp.tryPassChallenge(doc);
  assert.deepEqual(seen.map((e) => e.type), ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown", "mouseup", "pointerup", "click"]);
  for (const entry of seen) {
    assert.equal(entry.composed, true, `${entry.type} must be composed to cross a shadow boundary`);
  }
  // The mousedown/mouseup/pointer stream lands on the control; the final click
  // carries no coordinates, which is exactly what a real click() does.
  for (const entry of seen.slice(0, 7)) {
    assert.ok(entry.x > 0 && entry.y > 0, `${entry.type} must carry the control's coordinates`);
  }
});

test("a hidden or zero-size control is never clicked", () => {
  const { serp, doc } = setup(`
    <h1>I'm not a robot check</h1>
    <button type="button" style="display:none">Verify you are human</button>
    <button type="button" style="visibility:hidden">Verify you are human</button>
    <a href="/">Home</a>`);
  let clicks = 0;
  for (const button of doc.querySelectorAll("button")) {
    button.addEventListener("click", () => { clicks += 1; });
  }
  const info = serp.inspectChallenge(doc);
  assert.equal(info.clickable, false);
  serp.tryPassChallenge(doc);
  assert.equal(clicks, 0);
});
