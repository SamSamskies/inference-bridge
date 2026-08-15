#!/usr/bin/env node
/**
 * Build a Chrome Web Store ZIP containing only runtime extension files.
 * Excludes tests, docs, dependencies, repo metadata, and secrets.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const version = manifest.version;
const outDir = join(root, "dist");
const zipName = `inference-bridge-${version}.zip`;
const zipPath = join(outDir, zipName);

const ALLOWLIST = [
  "manifest.json",
  "background",
  "content",
  "src",
  "ui",
  "icons",
  "offscreen",
];

mkdirSync(outDir, { recursive: true });
if (existsSync(zipPath)) {
  rmSync(zipPath);
}

const result = spawnSync(
  "zip",
  ["-r", "-X", zipPath, ...ALLOWLIST, "-x", "*.DS_Store", "*__MACOSX*"],
  {
    cwd: root,
    encoding: "utf8",
  }
);

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "zip failed");
  process.exit(result.status ?? 1);
}

console.log(`Created ${zipPath}`);
