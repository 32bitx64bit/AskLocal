#!/usr/bin/env node
// Flags identifiers that are used but never declared or imported (esbuild bundles those silently).
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync } from "node:fs";
const globals = new Set(Object.getOwnPropertyNames(globalThis).concat(["window","document","location","indexedDB","chrome","browser","DOMException","AbortController","URL","URLSearchParams","fetch","navigator","HTMLElement","Node","MutationObserver","requestAnimationFrame","Blob","FileReader","Image","OffscreenCanvas","createImageBitmap","AudioContext","OfflineAudioContext","getComputedStyle","customElements","ResizeObserver","IntersectionObserver","CSS","Element","ShadowRoot","Event","CustomEvent","KeyboardEvent","MouseEvent","alert","confirm","self","btoa","atob","TextEncoder","TextDecoder","structuredClone","queueMicrotask","performance","crypto","console","arguments","undefined","NaN","Infinity","HTMLVideoElement","HTMLImageElement","HTMLCanvasElement","DOMParser","XMLSerializer","Response","Request","Headers","FormData","WebSocket","matchMedia","scrollTo","innerWidth","innerHeight","screen","history","caches","importScripts","PerformanceObserver","Audio","speechSynthesis","SpeechSynthesisUtterance","CSSStyleSheet","NodeFilter","Range","Selection","getSelection","Text","HTMLInputElement","HTMLTextAreaElement","HTMLAnchorElement","devicePixelRatio","VideoDecoder","EncodedVideoChunk","VideoFrame","XMLHttpRequest","PointerEvent","HTMLMediaElement","PopStateEvent"]));
const files = process.argv.slice(2);
let problems = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const declared = new Set();
  walk.full(ast, (node) => {
    if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") declared.add(node.local.name);
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) declared.add(node.id.name);
    if (node.type === "VariableDeclarator") walk.full(node.id, (n) => { if (n.type === "Identifier") declared.add(n.name); });
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id) declared.add(node.id.name);
      for (const p of node.params) walk.full(p, (n) => { if (n.type === "Identifier") declared.add(n.name); });
    }
    if (node.type === "CatchClause" && node.param) walk.full(node.param, (n) => { if (n.type === "Identifier") declared.add(n.name); });
  });
  const missing = new Map();
  walk.ancestor(ast, {
    Identifier(node, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed && !parent.shorthand) return;
      if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return;
      if (parent.type === "ExportSpecifier") return;
      if (declared.has(node.name) || globals.has(node.name)) return;
      missing.set(node.name, node.loc.start.line);
    }
  });
  for (const [name, line] of missing) {
    problems += 1;
    console.log(`${file}:${line} ${name} is not defined`);
  }
}
if (problems) process.exit(1);
