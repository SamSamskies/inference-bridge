#!/usr/bin/env node
/** Build the AMO reviewer source archive for the current HEAD. */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`
    );
  }
  return result.stdout.trim();
}

const tag = run("git", ["describe", "--tags", "--exact-match", "HEAD"]);
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(
    `HEAD must be an exact vX.Y.Z tag to build reviewer source (got ${tag || "untagged"})`
  );
}

const infoPath = join(outDir, "firefox-build-info.txt");
const zipVersion = run("zip", ["-v"]);
const zipHeader = zipVersion.split("\n").slice(0, 2).join("\n");
writeFileSync(
  infoPath,
  [
    run("node", ["--version"]),
    run("npm", ["--version"]),
    zipHeader,
    run("uname", ["-srm"]),
    "",
  ].join("\n")
);

const outZip = join(outDir, `inference-bridge-firefox-source-${tag}.zip`);
run("git", [
  "archive",
  "--format=zip",
  `--add-file=${infoPath}`,
  `--output=${outZip}`,
  "HEAD",
]);

console.log(`Created ${outZip}`);
