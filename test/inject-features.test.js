import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Load content/inject.js in a fake window. Classic MAIN-world script cannot
 * be imported; this is the object pages actually call.
 */
function loadInference() {
  const filename = join(
    dirname(fileURLToPath(import.meta.url)),
    "../content/inject.js"
  );
  const window = {
    addEventListener() {},
    removeEventListener() {},
  };
  window.top = window;
  vm.runInNewContext(readFileSync(filename, "utf8"), {
    window,
    Object,
    Math,
    Map,
    Set,
    Promise,
    Error,
    Symbol,
  }, { filename });
  return window.inference;
}

describe("window.inference.getFeatures", () => {
  it("returns a snapshot with toolCalling, webSearch, and options flags", () => {
    const inference = loadInference();
    expect(typeof inference.getFeatures).toBe("function");
    expect(inference.getFeatures()).toEqual({
      toolCalling: true,
      webSearch: true,
      options: { reasoningEffort: true, temperature: true },
    });
  });
});

describe("experimental.request tools deprecation", () => {
  /**
   * @param {{ consoleWarn?: (...args: unknown[]) => void }} [opts]
   */
  function loadInferenceWithWarn(opts = {}) {
    const filename = join(
      dirname(fileURLToPath(import.meta.url)),
      "../content/inject.js"
    );
    const window = {
      addEventListener() {},
      removeEventListener() {},
      isSecureContext: true,
    };
    window.top = window;
    const consoleWarn = opts.consoleWarn || (() => {});
    vm.runInNewContext(
      readFileSync(filename, "utf8"),
      {
        window,
        Object,
        Math,
        Map,
        Set,
        Promise,
        Error,
        Symbol,
        console: { warn: consoleWarn },
      },
      { filename }
    );
    return window.inference;
  }

  it("warns once when experimental.request uses tools", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    // Iteration starts the request; without a port it fails after the warn.
    const iter = inference.experimental.request({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/graduated to window\.inference\.request/);

    const iter2 = inference.experimental.request({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x" } }],
    })[Symbol.asyncIterator]();
    await expect(iter2.next()).rejects.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("does not warn for image-only experimental.request", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    const iter = inference.experimental.request({
      method: "chat",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", mediaType: "image/png", data: "aaa" },
          ],
        },
      ],
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow();
    expect(warnings).toHaveLength(0);
  });
});
