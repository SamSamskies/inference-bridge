#!/usr/bin/env node
/** Run web-ext with warnings as errors; allow narrowly checked false positives. */

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

// DOMPurify must parse untrusted markup inside its inert document to sanitize
// it. web-ext flags the sanitizer's own innerHTML assignment. Only allow the
// pinned, unmodified upstream library, never application innerHTML writes.
const sanitizerSource = readFileSync(join(root, "node_modules/dompurify/dist/purify.es.mjs"));
const sanitizerUnmodified = sanitizerSource.equals(readFileSync(join(root, "build/firefox/ui/vendor/purify.js")));
const sanitizerWarning = (warning) => sanitizerUnmodified &&
  warning.code === "UNSAFE_VAR_ASSIGNMENT" && warning.file === "ui/vendor/purify.js" &&
  warning.line === 1845;

const unexpectedWarnings = report.warnings.filter(
  (warning) => !desktopOnlyAndroidWarning(warning) && !sanitizerWarning(warning)
);
if (report.errors.length || unexpectedWarnings.length || report.notices.length) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
if (result.status !== 0 && report.warnings.length === 0) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(result.status || 1);
}
console.log(
  `Firefox staged artifact: ${report.summary.errors} errors, ${unexpectedWarnings.length} actionable warnings` +
    (report.warnings.length ? " (known Android and verified upstream sanitizer warnings ignored)" : "")
);
