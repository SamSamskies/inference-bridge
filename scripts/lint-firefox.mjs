#!/usr/bin/env node
/** Run web-ext with warnings as errors, allowing one known desktop-only false positive. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "build/firefox/manifest.json"), "utf8"));
const result = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/web-ext/bin/web-ext.js"),
    "lint",
    "--source-dir",
    join(root, "build/firefox"),
    "--warnings-as-errors",
    "--output",
    "json",
    "--no-input",
  ],
  { cwd: root, encoding: "utf8" }
);
if (result.error || result.signal) {
  throw result.error || new Error(`web-ext lint stopped by ${result.signal}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout || "web-ext lint failed\n");
  process.exit(result.status || 1);
}

// Mozilla web-ext #3561: the linter checks Android 140 even when gecko_android
// is absent, which is exactly how a desktop-only add-on is declared.
const desktopOnlyAndroidWarning = (warning) =>
  warning.code === "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION" &&
  warning.file === "manifest.json" &&
  manifest.browser_specific_settings?.gecko?.strict_min_version === "140.0" &&
  !Object.hasOwn(manifest.browser_specific_settings, "gecko_android");

const unexpectedWarnings = report.warnings.filter(
  (warning) => !desktopOnlyAndroidWarning(warning)
);
if (report.errors.length || unexpectedWarnings.length || report.notices.length) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
if (result.status !== 0 && report.warnings.length !== 1) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(result.status || 1);
}
console.log(
  `Firefox staged artifact: ${report.summary.errors} errors, ${unexpectedWarnings.length} actionable warnings` +
    (report.warnings.length ? " (known desktop-only Android linter warning ignored)" : "")
);
