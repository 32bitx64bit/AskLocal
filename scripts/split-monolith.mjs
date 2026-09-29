#!/usr/bin/env node
/**
 * Mechanically split a classic-script monolith into ESM modules.
 * Assigns top-level function/const/let declarations to modules via a map,
 * then wires cross-module imports from identifier usage.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function extractTopLevelDecls(source) {
  const lines = source.split("\n");
  const decls = [];
  let i = 0;

  function skipBlankAndComments(start) {
    let j = start;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("//")) {
        j += 1;
        continue;
      }
      if (t.startsWith("/*")) {
        while (j < lines.length && !lines[j].includes("*/")) j += 1;
        j += 1;
        continue;
      }
      break;
    }
    return j;
  }

  while (i < lines.length) {
    const commentStart = i;
    i = skipBlankAndComments(i);
    if (i >= lines.length) break;

    const line = lines[i];
    const trimmed = line.trim();

    // Skip pure listener registrations and other statements — handled later
    let kind = null;
    let name = null;
    let match;

    if ((match = trimmed.match(/^(?:export\s+)?async\s+function\s+(\w+)\s*\(/))) {
      kind = "function";
      name = match[1];
    } else if ((match = trimmed.match(/^(?:export\s+)?function\s+(\w+)\s*\(/))) {
      kind = "function";
      name = match[1];
    } else if ((match = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=/))) {
      kind = "const";
      name = match[1];
    } else if ((match = trimmed.match(/^(?:export\s+)?let\s+(\w+)\s*=/))) {
      kind = "let";
      name = match[1];
    } else {
      // Non-decl statement (e.g. api.runtime.onMessage...) — treat as "stmt" block until blank+next decl or EOF of contiguous stmts
      const start = commentStart < i ? commentStart : i;
      let end = i;
      while (end + 1 < lines.length) {
        const next = lines[end + 1];
        const nt = next.trim();
        if (
          /^(?:export\s+)?(?:async\s+)?function\s+\w+/.test(nt) ||
          /^(?:export\s+)?(?:const|let)\s+\w+\s*=/.test(nt)
        ) {
          break;
        }
        end += 1;
      }
      decls.push({
        kind: "stmt",
        name: `__stmt_${start}`,
        start,
        end,
        text: lines.slice(start, end + 1).join("\n")
      });
      i = end + 1;
      continue;
    }

    const start = commentStart < i ? commentStart : i;
    let end = i;
    if (kind === "function") {
      // Brace match from first { on this or following lines
      let depth = 0;
      let seen = false;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth += 1;
            seen = true;
          } else if (ch === "}") {
            depth -= 1;
          }
        }
        end = j;
        if (seen && depth === 0) break;
      }
    } else {
      // const/let — may be object/array literal or single expression
      let depthParen = 0;
      let depthBrace = 0;
      let depthBracket = 0;
      let inStr = null;
      let done = false;
      for (let j = i; j < lines.length && !done; j++) {
        const L = lines[j];
        for (let k = 0; k < L.length; k++) {
          const ch = L[k];
          const prev = L[k - 1];
          if (inStr) {
            if (ch === inStr && prev !== "\\") inStr = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") {
            inStr = ch;
            continue;
          }
          if (ch === "(") depthParen += 1;
          else if (ch === ")") depthParen -= 1;
          else if (ch === "{") depthBrace += 1;
          else if (ch === "}") depthBrace -= 1;
          else if (ch === "[") depthBracket += 1;
          else if (ch === "]") depthBracket -= 1;
          else if (ch === ";" && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
            end = j;
            done = true;
            break;
          }
        }
        end = j;
        // Heuristic: if line ends with `;` and depths zero
        if (!done && /;\s*$/.test(L) && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
          done = true;
        }
        // Multi-line object ending with `};`
        if (!done && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && j > i && /};\s*$/.test(L)) {
          done = true;
        }
      }
    }

    decls.push({
      kind,
      name,
      start,
      end,
      text: lines.slice(start, end + 1).join("\n")
    });
    i = end + 1;
  }

  return decls;
}

function assignModule(name, kind, text, maps) {
  if (kind === "stmt") {
    if (/onInstalled|onMessage|onConnect/.test(text)) return maps.entry;
    return maps.entry;
  }
  for (const [mod, names] of Object.entries(maps.byName)) {
    if (names.has(name)) return mod;
  }
  // Heuristic fallbacks
  if (/^[A-Z0-9_]+$/.test(name) && kind !== "function") {
    if (/TOOL|PROMPT_PRESETS|DEFAULT_SETTINGS|SEARCH_ENGINE|CONTEXT_TRIM|DONT_RETRY|ASKLOCAL_VERSION|OPENAI_|MEDIA_|X_|VIDEO_|PROVIDER_|SETTINGS_STORE|FAVICON|ACTIVE_ASKS|CLOSED_MEDIA|MIN_|MAX_|DEFAULT_VIDEO/.test(name)) {
      return "constants";
    }
  }
  return maps.defaultModule;
}

function exportify(text, kind) {
  if (kind === "stmt") return text;
  if (/^export\s/.test(text.trim())) return text;
  return text.replace(/^(async\s+function|function|const|let)\b/m, "export $1");
}

function findUsedSymbols(text, allNames) {
  const used = new Set();
  for (const name of allNames) {
    if (name.startsWith("__stmt_")) continue;
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(text)) used.add(name);
  }
  return used;
}

function splitFile({ sourcePath, outDir, moduleOf, entryModule, prelude, pathPrefix }) {
  const source = readFileSync(join(ROOT, sourcePath), "utf8");
  // Strip leading chrome/browser api const — replaced by prelude import
  let cleaned = source.replace(/^const api = .*?;\n/m, "");

  const decls = extractTopLevelDecls(cleaned);
  const allNames = new Set(decls.filter((d) => !d.name.startsWith("__stmt_")).map((d) => d.name));

  const modules = new Map();
  function ensure(mod) {
    if (!modules.has(mod)) modules.set(mod, []);
    return modules.get(mod);
  }

  for (const d of decls) {
    const mod = moduleOf(d);
    ensure(mod).push(d);
  }

  // Build name -> module
  const nameToMod = new Map();
  for (const [mod, list] of modules) {
    for (const d of list) {
      if (!d.name.startsWith("__stmt_")) nameToMod.set(d.name, mod);
    }
  }

  mkdirSync(join(ROOT, outDir), { recursive: true });

  for (const [mod, list] of modules) {
    const bodyParts = list.map((d) => exportify(d.text, d.kind));
    const bodyText = bodyParts.join("\n\n");
    const used = findUsedSymbols(bodyText, allNames);
    const importsByMod = new Map();

    for (const sym of used) {
      const from = nameToMod.get(sym);
      if (!from || from === mod) continue;
      // Don't import symbols we define
      if (list.some((d) => d.name === sym)) continue;
      if (!importsByMod.has(from)) importsByMod.set(from, new Set());
      importsByMod.get(from).add(sym);
    }

    const importLines = [];
    if (prelude) importLines.push(prelude);

    for (const [from, syms] of [...importsByMod.entries()].sort()) {
      const rel = relativeImport(mod, from, pathPrefix);
      const names = [...syms].sort();
      // Chunk large import lists
      for (let i = 0; i < names.length; i += 40) {
        const chunk = names.slice(i, i + 40);
        importLines.push(`import {\n  ${chunk.join(",\n  ")}\n} from "${rel}";`);
      }
    }

    const filePath = join(ROOT, outDir, `${mod}.js`);
    mkdirSync(dirname(filePath), { recursive: true });
    const content = [...importLines, "", ...bodyParts, ""].join("\n");
    writeFileSync(filePath, content);
    console.log(`Wrote ${filePath} (${list.length} decls)`);
  }

  return { modules, nameToMod, allNames };
}

function relativeImport(fromMod, toMod, prefix = ".") {
  // fromMod/toMod like "ask/pipeline" or "constants"
  const fromParts = fromMod.split("/");
  const toParts = toMod.split("/");
  const fromDirDepth = fromParts.length - 1;
  const up = fromDirDepth === 0 ? "." : Array(fromDirDepth).fill("..").join("/");
  return `${up}/${toMod}.js`.replace(/^\.\//, "./");
}

export { extractTopLevelDecls, splitFile, exportify };
