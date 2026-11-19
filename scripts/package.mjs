#!/usr/bin/env node
/** Stage and package reproducible browser-specific extension roots. */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareChat } from "./prepare-chat.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
prepareChat(root);
const chromeManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (chromeManifest.version !== packageJson.version) {
  throw new Error("manifest.json and package.json versions differ");
}
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${chromeManifest.version}`
) {
  throw new Error("Release tag and package version differ");
}

const mode = process.argv[2] || "chrome";
const browserManifests = { chrome: () => chromeManifest, firefox: firefoxManifest, safari: safariManifest };
if (mode !== "all" && !Object.hasOwn(browserManifests, mode)) {
  throw new Error("Usage: node scripts/package.mjs [chrome|firefox|safari|all]");
}

const RUNTIME_DIRS = ["background", "content", "src", "ui", "icons"];
const FIXED_TIME = new Date("1980-01-01T00:00:00Z");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

function firefoxManifest() {
  const manifest = structuredClone(chromeManifest);
  manifest.permissions = manifest.permissions.filter((name) => !["offscreen", "sidePanel"].includes(name));
  delete manifest.side_panel;
  manifest.sidebar_action = { default_title: "Inference Bridge Chat", default_panel: "ui/chat.html", default_icon: "icons/icon-48.png", open_at_install: false };
  manifest.host_permissions = manifest.host_permissions.map((pattern) =>
    pattern.replace(/^(https?:\/\/[^/:]+):\d+(\/.*)$/, "$1$2")
  );
  manifest.optional_host_permissions = [
    "http://localhost/*",
    "http://127.0.0.1/*",
    "http://[::1]/*",
    "https://*/*",
  ];
  manifest.background = {
    scripts: ["background/service-worker.js"],
    type: "module",
  };
  manifest.content_security_policy = {
    extension_pages: "script-src 'self'; object-src 'self'",
  };
  manifest.incognito = "not_allowed";
  manifest.browser_specific_settings = {
    gecko: {
      id: "inference-bridge@samsamskies.github.io",
      strict_min_version: "140.0",
      // Chat, page content, credentials, search terms, and separately approved speech
      // recordings can leave the browser only for the selected provider.
      data_collection_permissions: {
        required: [
          "authenticationInfo",
          "personallyIdentifyingInfo",
          "personalCommunications",
          "websiteContent",
          "searchTerms",
        ],
      },
    },
  };
  return manifest;
}

function safariManifest() {
  const manifest = structuredClone(chromeManifest);
  // Start with hosted providers. Safari on iOS has no Chrome side panel or
  // context menu, and this target does not install the Ollama header rules.
  manifest.permissions = ["storage"];
  delete manifest.side_panel;
  manifest.host_permissions = manifest.host_permissions.filter((pattern) => pattern.startsWith("https:"));
  manifest.optional_host_permissions = ["https://*/*"];
  manifest.browser_specific_settings = {
    safari: {
      // Minimum for static MAIN-world content scripts. Runtime support is
      // verified separately on the devices listed in docs/safari.md.
      strict_min_version: "18.0",
    },
  };
  return manifest;
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function build(browser) {
  const stage = join(root, "build", browser);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const directory of RUNTIME_DIRS) {
    cpSync(join(root, directory), join(stage, directory), { recursive: true });
  }
  if (browser === "chrome") {
    cpSync(join(root, "offscreen"), join(stage, "offscreen"), {
      recursive: true,
    });
  } else if (browser === "firefox") {
    cpSync(
      join(root, "firefox", "prompt-api-offscreen.js"),
      join(stage, "src", "prompt-api-offscreen.js")
    );
    cpSync(join(root, "firefox", "open-chat.js"), join(stage, "src", "open-chat.js"));
  }
  const manifest = browserManifests[browser]();
  writeFileSync(
    join(stage, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const files = walkFiles(stage);
  for (const file of files) utimesSync(file, FIXED_TIME, FIXED_TIME);
  const zipName =
    browser === "chrome"
      ? `inference-bridge-${chromeManifest.version}.zip`
      : `inference-bridge-${browser}-${chromeManifest.version}.zip`;
  const zipPath = join(outDir, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);
  const result = spawnSync(
    "zip",
    ["-X", "-q", zipPath, ...files.map((file) => relative(stage, file))],
    { cwd: stage, encoding: "utf8", env: { ...process.env, TZ: "UTC" } }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "zip failed");
  }
  console.log(`Created ${zipPath}`);
}

for (const browser of mode === "all" ? Object.keys(browserManifests) : [mode]) {
  build(browser);
}
