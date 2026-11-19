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

it("generates the iOS wrapper once and refreshes its assets without replacing signing settings", () => {
  const root = mkdtempSync(join(tmpdir(), "inference-bridge-ios-"));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const source = join(root, "safari", "ios-app");
    for (const path of [scripts, bin, source]) mkdirSync(path, { recursive: true });
    const prepare = join(scripts, "prepare-safari-ios.mjs");
    copyFileSync(new URL("../scripts/prepare-safari-ios.mjs", import.meta.url), prepare);
    copyFileSync(new URL("../safari/ios-app/Icon.png", import.meta.url), join(source, "Icon.png"));
    copyFileSync(new URL("../safari/ios-app/ViewController.swift", import.meta.url), join(source, "ViewController.swift"));
    writeFileSync(join(scripts, "package.mjs"), `
      import assert from "node:assert/strict";
      import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
      assert.equal(process.argv[2], "safari");
      mkdirSync("build/safari", { recursive: true });
      let n = 0;
      try { n = Number(readFileSync("build/package-count", "utf8")) || 0; } catch {}
      n += 1;
      writeFileSync("build/package-count", String(n));
      writeFileSync("build/safari/manifest.json", JSON.stringify({ package: n }));
      writeFileSync("build/safari/background.js", "bg-" + n);
      // Only the first package ships old.js, simulating a file dropped later.
      if (n === 1) writeFileSync("build/safari/old.js", "old");
      else rmSync("build/safari/old.js", { force: true });
      appendFileSync("build/stages", "safari\\n");
    `);
    writeFileSync(join(bin, "xcrun"), `#!/usr/bin/env node
      const assert = require("node:assert/strict");
      const { mkdirSync, readFileSync, writeFileSync, cpSync } = require("node:fs");
      const { join } = require("node:path");
      const args = process.argv.slice(2);
      assert.equal(args[0], "safari-web-extension-packager");
      assert.equal(JSON.parse(readFileSync(join(args[1], "manifest.json"), "utf8")).package, 1);
      assert.ok(args.includes("--no-open"));
      assert.ok(!args.includes("--force"));
      const name = args[args.indexOf("--app-name") + 1];
      const wrapper = join(args[args.indexOf("--project-location") + 1], name);
      const project = join(wrapper, name + ".xcodeproj");
      const resources = join(wrapper, name, "Resources");
      const extensionResources = join(wrapper, name + " Extension", "Resources");
      const appIcon = join(wrapper, name, "Assets.xcassets", "AppIcon.appiconset");
      mkdirSync(project, { recursive: true });
      mkdirSync(join(resources, "Base.lproj"), { recursive: true });
      mkdirSync(extensionResources, { recursive: true });
      mkdirSync(appIcon, { recursive: true });
      writeFileSync(join(appIcon, "Contents.json"), JSON.stringify({ images: [
        { filename: "generated.png", size: "1024x1024" },
        { filename: "generated.png", size: "1024x1024", appearances: [{ appearance: "luminosity", value: "dark" }] },
        { filename: "missing-size.png" },
        { filename: "malformed-size.png", size: "invalid" },
      ] }));
      writeFileSync(join(appIcon, "generated.png"), "template icon");
      writeFileSync(join(project, "project.pbxproj"), "generated project");
      writeFileSync(join(wrapper, name, "ViewController.swift"), "generated controller");
      writeFileSync(join(resources, "Base.lproj", "Main.html"), "template");
      writeFileSync(join(resources, "Style.css"), "template");
      // Simulate --copy-resources: embed a snapshot of the packaged extension.
      cpSync(args[1], extensionResources, { recursive: true });
    `, { mode: 0o755 });
    writeFileSync(join(bin, "sips"), `#!/usr/bin/env node
      const assert = require("node:assert/strict");
      const { copyFileSync } = require("node:fs");
      const { join } = require("node:path");
      const [flag, height, width, source, outputFlag, output] = process.argv.slice(2);
      assert.deepEqual([flag, height, width, outputFlag], ["--resampleHeightWidth", "1024", "1024", "--out"]);
      assert.equal(source, join(process.cwd(), "safari", "ios-app", "Icon.png"));
      copyFileSync(source, output);
    `, { mode: 0o755 });

    const env = {
      ...process.env,
      DEVELOPER_DIR: "/test/Xcode.app/Contents/Developer",
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    };
    const wrapper = join(root, "build", "safari-xcode", "Inference Bridge");
    const project = join(wrapper, "Inference Bridge.xcodeproj", "project.pbxproj");
    const controller = join(wrapper, "Inference Bridge", "ViewController.swift");
    const resources = join(wrapper, "Inference Bridge", "Resources");
    const extensionResources = join(wrapper, "Inference Bridge Extension", "Resources");
    const appIcon = join(wrapper, "Inference Bridge", "Assets.xcassets", "AppIcon.appiconset", "generated.png");
    const run = () => {
      const result = spawnSync(process.execPath, [prepare], { cwd: root, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };

    writeFileSync(join(source, "Main.html"), "setup screen");
    writeFileSync(join(source, "Style.css"), "setup styles");
    run();
    expect(readFileSync(join(resources, "Base.lproj", "Main.html"), "utf8")).toBe("setup screen");
    expect(readFileSync(join(resources, "Style.css"), "utf8")).toBe("setup styles");
    expect(readFileSync(controller)).toEqual(readFileSync(join(source, "ViewController.swift")));
    expect(existsSync(join(resources, "Icon.png"))).toBe(true);
    expect(readFileSync(appIcon)).toEqual(readFileSync(join(source, "Icon.png")));
    expect(JSON.parse(readFileSync(join(extensionResources, "manifest.json"), "utf8"))).toEqual({
      package: 1,
    });

    expect(existsSync(join(extensionResources, "old.js"))).toBe(true);

    writeFileSync(project, "configured signing");
    writeFileSync(controller, "stale controller");
    writeFileSync(appIcon, "stale icon");
    writeFileSync(join(source, "Main.html"), "updated setup screen");
    run();
    expect(readFileSync(project, "utf8")).toBe("configured signing");
    expect(readFileSync(controller)).toEqual(readFileSync(join(source, "ViewController.swift")));
    expect(readFileSync(join(resources, "Base.lproj", "Main.html"), "utf8")).toBe("updated setup screen");
    expect(existsSync(join(resources, "Icon.png"))).toBe(true);
    expect(readFileSync(appIcon)).toEqual(readFileSync(join(source, "Icon.png")));
    expect(readFileSync(join(root, "build", "stages"), "utf8")).toBe("safari\nsafari\n");
    // Second prepare rebuilds build/safari and syncs the embedded Extension Resources.
    expect(JSON.parse(readFileSync(join(extensionResources, "manifest.json"), "utf8"))).toEqual({
      package: 2,
    });
    expect(readFileSync(join(extensionResources, "background.js"), "utf8")).toBe("bg-2");
    // Files dropped from the package must not linger in the embedded copy.
    expect(existsSync(join(extensionResources, "old.js"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
