#!/usr/bin/env node
/** Prepare the local iOS wrapper and its setup screen for Xcode. */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = join(root, "build");
const appName = "Inference Bridge";
const wrapperLocation = join(build, "safari-xcode");
const wrapper = join(wrapperLocation, appName);
const project = join(wrapper, `${appName}.xcodeproj`);
const resources = join(wrapper, appName, "Resources");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.signal ?? result.status})`);
  }
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
// Main.html references ../Icon.png from Base.lproj — copy brand mark into Resources/.
const setupFiles = [
  join(resources, "Base.lproj", "Main.html"),
  join(resources, "Style.css"),
  join(resources, "Icon.png"),
];
for (const destination of setupFiles) {
  copyFileSync(join(root, "safari", "ios-app", basename(destination)), destination);
}

console.log(`Ready to build in Xcode: ${project}`);
