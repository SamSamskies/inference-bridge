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
  it("stages distinct, allowlisted, deterministic browser ZIP roots", () => {
    const chromeZip = join(root, `dist/inference-bridge-${packageJson.version}.zip`);
    const firefoxZip = join(root, `dist/inference-bridge-firefox-${packageJson.version}.zip`);
    const safariZip = join(root, `dist/inference-bridge-safari-${packageJson.version}.zip`);
    const packages = [["chrome", chromeZip], ["firefox", firefoxZip], ["safari", safariZip]];
    command(process.execPath, ["scripts/package.mjs", "all"]);

    for (const [browser, zip] of packages) {
      const files = command("unzip", ["-Z1", zip]).trim().split("\n");
      expect(files).toContain("manifest.json");
      expect(files).toContain("background/service-worker.js");
      expect(files).toContain("src/runtime-browser.js");
      expect(files).toContain("ui/chat.html");
      expect(files).toContain("ui/vendor/marked.js");
      expect(files).toContain("ui/vendor/purify.js");
      expect(files).toEqual([...files].sort());
      expect(files.every((file) =>
        /^(manifest\.json|(?:background|content|src|ui|icons|offscreen)\/[^/].*)$/.test(file)
      )).toBe(true);
      expect(files.some((file) => /(?:test|\.git|\.env|node_modules|package-lock)/.test(file))).toBe(false);
      const manifest = JSON.parse(command("unzip", ["-p", zip, "manifest.json"]));
      expect(manifest.version).toBe(packageJson.version);
      expect(manifest.name).toBe("Inference Bridge");
      expect(manifest.host_permissions).toContain("https://generativelanguage.googleapis.com/*");
      expect(manifest.host_permissions).toContain("https://api.ppq.ai/*");
      expect(files).toContain("src/providers/gemini.js");
      for (const permission of ["tabs", "history", "webNavigation"]) {
        expect(manifest.permissions).not.toContain(permission);
        expect(manifest.optional_permissions || []).not.toContain(permission);
      }
      expect(manifest.host_permissions.some((pattern) => pattern.includes("127.0.0.1"))).toBe(false);
      if (browser === "firefox") {
        expect(manifest.side_panel).toBeUndefined();
        expect(manifest.permissions).not.toContain("sidePanel");
        expect(manifest.sidebar_action.default_panel).toBe("ui/chat.html");
        expect(command("unzip", ["-p", zip, "src/open-chat.js"])).not.toContain("sidePanel");
        expect(files.some((file) => file.startsWith("offscreen/"))).toBe(false);
        expect(manifest.permissions).not.toContain("offscreen");
        expect(manifest.background).toEqual({ scripts: ["background/service-worker.js"], type: "module" });
        expect(manifest.host_permissions).toContain("http://localhost/*");
        expect(manifest.host_permissions).not.toContain("http://localhost:11434/*");
        expect(manifest.optional_host_permissions).toContain("http://[::1]/*");
        expect(manifest.optional_host_permissions).not.toContain("http://*/*");
        expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe("140.0");
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).not.toContain("none");
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).toContain("personallyIdentifyingInfo");
        expect(manifest.browser_specific_settings.gecko_android).toBeUndefined();
        expect(manifest.incognito).toBe("not_allowed");
        expect(manifest.content_security_policy.extension_pages).not.toContain("upgrade-insecure-requests");
        expect(command("unzip", ["-p", zip, "src/prompt-api-offscreen.js"])).not.toContain("chrome.offscreen");
      } else if (browser === "chrome") {
        expect(manifest.side_panel.default_path).toBe("ui/chat.html");
        expect(manifest.permissions).toContain("sidePanel");
        expect(manifest.permissions).toContain("offscreen");
        expect(manifest.background.service_worker).toBe("background/service-worker.js");
      } else {
        expect(manifest.manifest_version).toBe(3);
        expect(manifest.permissions).toEqual(["storage"]);
        expect(manifest.host_permissions.every((pattern) => pattern.startsWith("https://"))).toBe(true);
        expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
        expect(manifest.side_panel).toBeUndefined();
        expect(manifest.sidebar_action).toBeUndefined();
        expect(manifest.browser_specific_settings).toEqual({ safari: { strict_min_version: "18.0" } });
        expect(manifest.background).toEqual({ service_worker: "background/service-worker.js", type: "module" });
        expect(manifest.content_scripts.map(({ js, world = "ISOLATED", run_at, all_frames }) =>
          ({ js, world, run_at, all_frames })
        )).toEqual([
          { js: ["content/inject.js"], world: "MAIN", run_at: "document_start", all_frames: false },
          { js: ["content/content-script.js"], world: "ISOLATED", run_at: "document_start", all_frames: false },
        ]);
        expect(files.some((file) => file.startsWith("offscreen/"))).toBe(false);
        for (const file of ["content/inject.js", "content/content-script.js", "background/service-worker.js"]) {
          expect(command("unzip", ["-p", zip, file])).toBe(readFileSync(join(root, file), "utf8"));
        }
      }
    }

    const first = packages.map(([, zip]) => hash(zip));
    command(process.execPath, ["scripts/package.mjs", "all"]);
    expect(packages.map(([, zip]) => hash(zip))).toEqual(first);
  });
});
