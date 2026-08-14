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
  it("returns a snapshot with toolCalling false", () => {
    const inference = loadInference();
    expect(typeof inference.getFeatures).toBe("function");
    expect(inference.getFeatures()).toEqual({ toolCalling: false });
  });
});
