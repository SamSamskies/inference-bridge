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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
if (!["chrome", "firefox", "all"].includes(mode)) {
  throw new Error("Usage: node scripts/package.mjs [chrome|firefox|all]");
}

const RUNTIME_DIRS = ["background", "content", "src", "ui", "icons"];
const FIXED_TIME = new Date("1980-01-01T00:00:00Z");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

function firefoxManifest() {
  const manifest = structuredClone(chromeManifest);
  manifest.permissions = manifest.permissions.filter((name) => name !== "offscreen");
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
      // Speech and the Chrome Prompt API are disabled in this artifact.
      // Chat messages, page text/images, credentials and hosted search terms
      // can leave the browser only for the provider the user selects.
      data_collection_permissions: {
        required: [
          "authenticationInfo",
          "personalCommunications",
          "websiteContent",
          "searchTerms",
        ],
      },
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
  } else {
    cpSync(
      join(root, "firefox", "prompt-api-offscreen.js"),
      join(stage, "src", "prompt-api-offscreen.js")
    );
  }
  writeFileSync(
    join(stage, "manifest.json"),
    `${JSON.stringify(browser === "chrome" ? chromeManifest : firefoxManifest(), null, 2)}\n`
  );

  const files = walkFiles(stage);
  for (const file of files) utimesSync(file, FIXED_TIME, FIXED_TIME);
  const zipName =
    browser === "chrome"
      ? `inference-bridge-${chromeManifest.version}.zip`
      : `inference-bridge-firefox-${chromeManifest.version}.zip`;
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

if (mode === "all") {
  build("chrome");
  build("firefox");
} else {
  build(mode);
}
