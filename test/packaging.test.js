import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function command(bin, args) {
  const result = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${bin} failed`);
  }
  return result.stdout;
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("browser packages", () => {
  it("stages distinct, allowlisted, deterministic Chrome and Firefox ZIP roots", () => {
    const chromeZip = join(root, `dist/inference-bridge-${packageJson.version}.zip`);
    const firefoxZip = join(root, `dist/inference-bridge-firefox-${packageJson.version}.zip`);
    command(process.execPath, ["scripts/package.mjs", "all"]);

    for (const [browser, zip] of [["chrome", chromeZip], ["firefox", firefoxZip]]) {
      const files = command("unzip", ["-Z1", zip]).trim().split("\n");
      expect(files).toContain("manifest.json");
      expect(files).toContain("background/service-worker.js");
      expect(files).toContain("src/runtime-browser.js");
      expect(files).toEqual([...files].sort());
      expect(files.every((file) =>
        /^(manifest\.json|(?:background|content|src|ui|icons|offscreen)\/[^/].*)$/.test(file)
      )).toBe(true);
      expect(files.some((file) => /(?:test|\.git|\.env|node_modules|package-lock)/.test(file))).toBe(false);
      const manifest = JSON.parse(command("unzip", ["-p", zip, "manifest.json"]));
      expect(manifest.version).toBe(packageJson.version);
      expect(manifest.name).toBe("Inference Bridge");
      if (browser === "firefox") {
        expect(files.some((file) => file.startsWith("offscreen/"))).toBe(false);
        expect(manifest.permissions).not.toContain("offscreen");
        expect(manifest.background).toEqual({ scripts: ["background/service-worker.js"], type: "module" });
        expect(manifest.host_permissions).toContain("http://localhost/*");
        expect(manifest.host_permissions).not.toContain("http://localhost:11434/*");
        expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe("140.0");
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).not.toContain("none");
        expect(manifest.browser_specific_settings.gecko_android).toBeUndefined();
        expect(manifest.incognito).toBe("not_allowed");
        expect(manifest.content_security_policy.extension_pages).not.toContain("upgrade-insecure-requests");
        expect(command("unzip", ["-p", zip, "src/prompt-api-offscreen.js"])).not.toContain("chrome.offscreen");
      } else {
        expect(manifest.permissions).toContain("offscreen");
        expect(manifest.background.service_worker).toBe("background/service-worker.js");
      }
    }

    const first = [hash(chromeZip), hash(firefoxZip)];
    command(process.execPath, ["scripts/package.mjs", "all"]);
    expect([hash(chromeZip), hash(firefoxZip)]).toEqual(first);
  });
});
