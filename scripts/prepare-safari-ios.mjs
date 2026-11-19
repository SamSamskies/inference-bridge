#!/usr/bin/env node
/** Prepare the local iOS wrapper and its setup screen for Xcode. */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
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
const resources = join(wrapper, appName, "Resources");
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
  join(resources, "Base.lproj", "Main.html"),
  join(resources, "Style.css"),
];
for (const path of requiredGenerated) {
  if (!existsSync(path)) throw new Error(`The generated Safari wrapper is missing ${path}`);
}

const synced = syncEmbeddedExtensionResources();

// Main.html references ../Icon.png from Base.lproj — copy brand mark into Resources/.
const setupFiles = [
  join(resources, "Base.lproj", "Main.html"),
  join(resources, "Style.css"),
  join(resources, "Icon.png"),
];
for (const destination of setupFiles) {
  copyFileSync(join(root, "safari", "ios-app", basename(destination)), destination);
}

console.log(
  synced > 0
    ? `Refreshed ${synced} embedded extension Resource folder(s) and setup screen.`
    : "Refreshed build/safari (Xcode references it) and the setup screen.",
);
console.log(`Ready to build in Xcode: ${project}`);
