#!/usr/bin/env node
/** Prepare the local iOS wrapper and its assets for Xcode. */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = join(root, "build");
const appName = "Inference Bridge";
const wrapperLocation = join(build, "safari-xcode");
const wrapper = join(wrapperLocation, appName);
const project = join(wrapper, `${appName}.xcodeproj`);
const app = join(wrapper, appName);
const resources = join(app, "Resources");
const appIcon = join(app, "Assets.xcassets", "AppIcon.appiconset");
const safariPackage = join(build, "safari");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.signal ?? result.status})`);
  }
}

/**
 * Directories under the Xcode wrapper that contain a web-extension manifest
 * (copied Resources from --copy-resources or older packager layouts). Skip
 * build/safari itself when the project only references that path.
 * @param {string} dir
 * @param {string[]} found
 * @returns {string[]}
 */
function listEmbeddedExtensionDirs(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  if (existsSync(join(dir, "manifest.json"))) {
    found.push(dir);
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.endsWith(".xcodeproj") || entry.name === "xcuserdata") continue;
    listEmbeddedExtensionDirs(join(dir, entry.name), found);
  }
  return found;
}

/**
 * When the packager copied extension files into the wrapper, refresh them from
 * the latest build/safari package without re-running the packager (keeps
 * signing). Reference-only projects need no copy — Xcode points at build/safari.
 */
function syncEmbeddedExtensionResources() {
  if (!existsSync(join(safariPackage, "manifest.json"))) {
    throw new Error(`Missing packaged Safari extension at ${safariPackage}`);
  }
  const packaged = resolve(safariPackage);
  const targets = listEmbeddedExtensionDirs(wrapper).filter(
    (dir) => resolve(dir) !== packaged,
  );
  for (const dest of targets) {
    // cpSync never deletes, so clear first or files dropped from the package linger.
    rmSync(dest, { recursive: true, force: true });
    cpSync(safariPackage, dest, { recursive: true });
  }
  return targets.length;
}

run(process.execPath, [join(root, "scripts", "package.mjs"), "safari"]);

if (!existsSync(project)) {
  const xcode = "/Applications/Xcode.app/Contents/Developer";
  const env = !process.env.DEVELOPER_DIR && existsSync(xcode)
    ? { ...process.env, DEVELOPER_DIR: xcode }
    : process.env;
  run("xcrun", [
    "safari-web-extension-packager", join(build, "safari"),
    "--ios-only", "--swift", "--app-name", appName,
    "--bundle-identifier", "io.github.samsamskies.inferencebridge.safaritest",
    "--project-location", wrapperLocation, "--no-open", "--no-prompt",
  ], env);
}

const requiredGenerated = [
  project,
  join(app, "ViewController.swift"),
  join(resources, "Base.lproj", "Main.html"),
  join(resources, "Style.css"),
  join(appIcon, "Contents.json"),
];
for (const path of requiredGenerated) {
  if (!existsSync(path)) throw new Error(`The generated Safari wrapper is missing ${path}`);
}

const synced = syncEmbeddedExtensionResources();

// Main.html references ../Icon.png from Base.lproj — copy brand mark into Resources/.
const setupFiles = [
  join(app, "ViewController.swift"),
  join(resources, "Base.lproj", "Main.html"),
  join(resources, "Style.css"),
  join(resources, "Icon.png"),
];
for (const destination of setupFiles) {
  copyFileSync(join(root, "safari", "ios-app", basename(destination)), destination);
}

// Use the full-bleed brand image for the Home Screen icon. The packager's
// generated assets inset the extension icon on a white tile.
const { images = [] } = JSON.parse(readFileSync(join(appIcon, "Contents.json"), "utf8"));
const iconFiles = new Set();
for (const { filename, size, scale = "1x" } of images) {
  if (!filename || iconFiles.has(filename)) continue;
  const match = typeof size === "string" ? size.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/) : null;
  const density = typeof scale === "string" ? Number.parseInt(scale, 10) : Number(scale);
  if (!match || !Number.isFinite(density) || density <= 0) continue;
  const width = Math.round(Number(match[1]) * density);
  const height = Math.round(Number(match[2]) * density);
  if (width <= 0 || height <= 0) continue;
  run("sips", [
    "--resampleHeightWidth", String(height), String(width),
    join(root, "safari", "ios-app", "Icon.png"), "--out", join(appIcon, filename),
  ]);
  iconFiles.add(filename);
}

console.log(
  synced > 0
    ? `Refreshed ${synced} embedded extension Resource folder(s), setup screen, and app icon.`
    : "Refreshed build/safari (Xcode references it), the setup screen, and the app icon.",
);
console.log(`Ready to build in Xcode: ${project}`);
