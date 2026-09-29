#!/usr/bin/env node
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const browserArg = [...args].find((a) => a.startsWith("--browser="));
const browserFilter = browserArg ? browserArg.split("=")[1] : "all";

const ENTRY_POINTS = [
  { in: "src/background/index.js", out: "background" },
  { in: "src/content/index.js", out: "content" },
  { in: "src/video-capture.js", out: "video-capture" },
  { in: "src/x-media-sniffer.js", out: "x-media-sniffer" },
  { in: "src/x-media-sniffer-inject.js", out: "x-media-sniffer-inject" },
  { in: "src/serp-extractor.js", out: "serp-extractor" },
  { in: "src/popup.js", out: "popup" },
  { in: "src/options.js", out: "options" }
];

const ICON_PATHS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
};

function buildChromeManifest(meta) {
  return {
    manifest_version: 3,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    icons: ICON_PATHS,
    action: {
      default_title: "AskLocal",
      default_popup: "popup.html",
      default_icon: ICON_PATHS
    },
    background: { service_worker: "background.js" },
    content_scripts: [
      {
        matches: ["https://x.com/*", "https://twitter.com/*"],
        js: ["x-media-sniffer.js"],
        run_at: "document_start",
        world: "MAIN"
      },
      {
        matches: ["https://x.com/*", "https://twitter.com/*"],
        js: ["content.js"],
        run_at: "document_idle"
      }
    ],
    options_page: "options.html",
    permissions: meta.permissions.includes("unlimitedStorage")
      ? meta.permissions
      : [...meta.permissions, "unlimitedStorage"],
    host_permissions: ["http://*/*", "https://*/*"],
    web_accessible_resources: [
      {
        resources: ["options.html", "settings.css", "icons/*", "x-media-sniffer.js"],
        matches: ["https://x.com/*", "https://twitter.com/*"]
      }
    ]
  };
}

function buildFirefoxManifest(meta) {
  const permissions = [
    ...new Set([
      ...meta.permissions.filter((p) => p !== "scripting" && p !== "offscreen"),
      "http://*/*",
      "https://*/*",
      "https://x.com/*",
      "https://twitter.com/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "https://api.openai.com/*",
      "https://api.anthropic.com/*",
      "https://openrouter.ai/*"
    ])
  ];
  return {
    manifest_version: 2,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    icons: ICON_PATHS,
    browser_action: {
      default_title: "AskLocal",
      default_popup: "popup.html",
      default_icon: ICON_PATHS
    },
    background: { scripts: ["background.js"] },
    content_scripts: [
      {
        matches: ["https://x.com/*", "https://twitter.com/*"],
        js: ["x-media-sniffer-inject.js"],
        run_at: "document_start"
      },
      {
        matches: ["https://x.com/*", "https://twitter.com/*"],
        js: ["content.js"],
        run_at: "document_idle"
      }
    ],
    options_ui: { page: "options.html", open_in_tab: true },
    permissions,
    web_accessible_resources: [
      "options.html",
      "settings.css",
      "icons/icon-16.png",
      "icons/icon-32.png",
      "icons/icon-48.png",
      "icons/icon-128.png",
      "x-media-sniffer.js"
    ],
    browser_specific_settings: {
      gecko: {
        id: "asklocal-dev@example.local",
        data_collection_permissions: { required: ["none"] }
      }
    }
  };
}

function readMeta() {
  const base = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  return {
    name: base.name,
    description: base.description,
    version: base.version,
    permissions: base.permissions
  };
}

function copyAssets(outDir) {
  mkdirSync(join(outDir, "icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const src = join(ROOT, "icons", `icon-${size}.png`);
    if (!existsSync(src)) {
      console.warn(`Missing icon: ${src}`);
      continue;
    }
    cpSync(src, join(outDir, "icons", `icon-${size}.png`));
  }
  for (const file of ["popup.html", "options.html", "settings.css", "video-capture.html"]) {
    cpSync(join(ROOT, "src", file), join(outDir, file));
  }
}

function zipDir(dir, zipPath) {
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dir });
}

function esbuildOptions(outdir) {
  return {
    entryPoints: Object.fromEntries(ENTRY_POINTS.map((e) => [e.out, join(ROOT, e.in)])),
    bundle: true,
    outdir,
    format: "iife",
    platform: "browser",
    target: ["chrome110", "firefox115"],
    logLevel: "info",
    write: true
  };
}

function wipeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    execFileSync("rm", ["-rf", dir]);
  }
}

async function packageBrowser(browser) {
  const outDir = join(ROOT, "build", browser);
  wipeDir(outDir);
  mkdirSync(outDir, { recursive: true });

  await esbuild.build(esbuildOptions(outDir));
  copyAssets(outDir);

  const meta = readMeta();
  const manifest = browser === "firefox" ? buildFirefoxManifest(meta) : buildChromeManifest(meta);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const zipPath = join(ROOT, "build", `asklocal-${browser}.zip`);
  zipDir(outDir, zipPath);
  console.log(`Packaged ${browser} → ${outDir}`);
  console.log(`Zip → ${zipPath}`);
}

async function watchChrome() {
  const outDir = join(ROOT, "build", "chrome");
  wipeDir(outDir);
  mkdirSync(outDir, { recursive: true });
  copyAssets(outDir);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(buildChromeManifest(readMeta()), null, 2) + "\n"
  );

  const ctx = await esbuild.context(esbuildOptions(outDir));
  await ctx.watch();
  console.log(`Watching → ${outDir} (reload the extension after rebuilds)`);
}

async function main() {
  if (watch) {
    if (browserFilter !== "chrome" && browserFilter !== "all") {
      throw new Error("--watch is only supported for Chrome (use --browser=chrome)");
    }
    await watchChrome();
    return;
  }

  const browsers =
    browserFilter === "all" ? ["chrome", "firefox"] :
    browserFilter === "chrome" || browserFilter === "firefox" ? [browserFilter] :
    (() => { throw new Error(`Unknown browser: ${browserFilter}`); })();

  for (const browser of browsers) {
    await packageBrowser(browser);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
