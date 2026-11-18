import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it } from "vitest";

it("generates the iOS wrapper once and refreshes the setup screen without replacing signing settings", () => {
  const root = mkdtempSync(join(tmpdir(), "inference-bridge-ios-"));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const source = join(root, "safari", "ios-app");
    for (const path of [scripts, bin, source]) mkdirSync(path, { recursive: true });
    const prepare = join(scripts, "prepare-safari-ios.mjs");
    copyFileSync(new URL("../scripts/prepare-safari-ios.mjs", import.meta.url), prepare);
    copyFileSync(new URL("../safari/ios-app/Icon.png", import.meta.url), join(source, "Icon.png"));
    writeFileSync(join(scripts, "package.mjs"), `
      import assert from "node:assert/strict";
      import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
      assert.equal(process.argv[2], "safari");
      mkdirSync("build/safari", { recursive: true });
      writeFileSync("build/safari/manifest.json", "{}");
      appendFileSync("build/stages", "safari\\n");
    `);
    writeFileSync(join(bin, "xcrun"), `#!/usr/bin/env node
      const assert = require("node:assert/strict");
      const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const args = process.argv.slice(2);
      assert.equal(args[0], "safari-web-extension-packager");
      assert.equal(readFileSync(join(args[1], "manifest.json"), "utf8"), "{}");
      assert.ok(args.includes("--no-open"));
      assert.ok(!args.includes("--force"));
      const name = args[args.indexOf("--app-name") + 1];
      const wrapper = join(args[args.indexOf("--project-location") + 1], name);
      const project = join(wrapper, name + ".xcodeproj");
      const resources = join(wrapper, name, "Resources");
      mkdirSync(project, { recursive: true });
      mkdirSync(join(resources, "Base.lproj"), { recursive: true });
      writeFileSync(join(project, "project.pbxproj"), "generated project");
      writeFileSync(join(resources, "Base.lproj", "Main.html"), "template");
      writeFileSync(join(resources, "Style.css"), "template");
    `, { mode: 0o755 });

    const env = {
      ...process.env,
      DEVELOPER_DIR: "/test/Xcode.app/Contents/Developer",
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    };
    const wrapper = join(root, "build", "safari-xcode", "Inference Bridge");
    const project = join(wrapper, "Inference Bridge.xcodeproj", "project.pbxproj");
    const resources = join(wrapper, "Inference Bridge", "Resources");
    const run = () => {
      const result = spawnSync(process.execPath, [prepare], { cwd: root, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };

    writeFileSync(join(source, "Main.html"), "setup screen");
    writeFileSync(join(source, "Style.css"), "setup styles");
    run();
    expect(readFileSync(join(resources, "Base.lproj", "Main.html"), "utf8")).toBe("setup screen");
    expect(readFileSync(join(resources, "Style.css"), "utf8")).toBe("setup styles");
    expect(existsSync(join(resources, "Icon.png"))).toBe(true);

    writeFileSync(project, "configured signing");
    writeFileSync(join(source, "Main.html"), "updated setup screen");
    run();
    expect(readFileSync(project, "utf8")).toBe("configured signing");
    expect(readFileSync(join(resources, "Base.lproj", "Main.html"), "utf8")).toBe("updated setup screen");
    expect(existsSync(join(resources, "Icon.png"))).toBe(true);
    expect(readFileSync(join(root, "build", "stages"), "utf8")).toBe("safari\nsafari\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
