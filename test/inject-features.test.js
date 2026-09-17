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

function loadInferenceWithFeatureBridge() {
  const filename = join(
    dirname(fileURLToPath(import.meta.url)),
    "../content/inject.js"
  );
  let initListener;
  const window = {
    addEventListener(type, listener) {
      if (type === "message") initListener = listener;
    },
    removeEventListener() {},
  };
  window.top = window;
  const pagePort = {};
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
  initListener({
    source: window,
    data: { channel: "__ipa_inference__", direction: "init" },
    ports: [pagePort],
  });
  return {
    inference: window.inference,
    setSpeechEnabled(enabled) {
      pagePort.onmessage({
        data: {
          type: "feature-state",
          experimentalSpeechEnabled: enabled,
        },
      });
    },
  };
}

describe("window.inference.getFeatures", () => {
  it("returns a snapshot with tools, images, and options flags", () => {
    const inference = loadInference();
    expect(typeof inference.getFeatures).toBe("function");
    expect(inference.getFeatures()).toEqual({
      toolCalling: true,
      webSearch: true,
      imageInput: true,
      imageOutput: true,
      options: { reasoningEffort: true, temperature: true },
    });
  });

  it("returns a synchronous fail-closed experimental method snapshot", () => {
    const { inference, setSpeechEnabled } = loadInferenceWithFeatureBridge();
    expect(inference.experimental.getFeatures()).toEqual({
      methods: {
        chat: true,
        transcribe: false,
        synthesize: false,
      },
    });

    setSpeechEnabled(true);
    const enabled = inference.experimental.getFeatures();
    expect(enabled).toEqual({
      methods: {
        chat: true,
        transcribe: true,
        synthesize: true,
      },
    });
    enabled.methods.transcribe = false;
    expect(inference.experimental.getFeatures().methods.transcribe).toBe(true);

    setSpeechEnabled(false);
    expect(inference.experimental.getFeatures().methods.synthesize).toBe(false);
  });
});

describe("experimental.request deprecation", () => {
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

  it("warns once for experimental chat requests", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    // Iteration starts the request; without a port it fails after the warn.
    const iter = inference.experimental.request({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/experimental\.request is deprecated/);
    expect(warnings[0]).toMatch(/prefer window\.inference\.request/);

    const iter2 = inference.experimental.request({
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
      tools: [{ type: "web_search" }],
    })[Symbol.asyncIterator]();
    await expect(iter2.next()).rejects.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("uses a separate one-time notice for speech requests", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    const transcribe = inference.experimental.request({
      method: "transcribe",
      audio: { mediaType: "audio/wav", data: "Zm9v" },
    })[Symbol.asyncIterator]();
    await expect(transcribe.next()).rejects.toMatchObject({
      code: "invalid_request",
    });
    const synthesize = inference.experimental.request({
      method: "synthesize",
      text: "hello",
    })[Symbol.asyncIterator]();
    await expect(synthesize.next()).rejects.toMatchObject({
      code: "invalid_request",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/experimental, non-normative/);
    expect(warnings[0]).not.toMatch(/deprecated/);
  });

  it("rejects unknown methods lazily without falling through to chat", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });
    const iterable = inference.experimental.request({ method: "embeddings" });
    expect(warnings).toHaveLength(0);
    await expect(iterable[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(warnings).toHaveLength(0);
  });

  it("does not warn for stable request", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    const iter = inference.request({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
    })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow();
    expect(warnings).toHaveLength(0);
  });
});

describe("experimental.runTools deprecation", () => {
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

  it("warns once toward ipa-tools, not the experimental.request message", async () => {
    const warnings = [];
    const inference = loadInferenceWithWarn({
      consoleWarn: (...args) => warnings.push(args.join(" ")),
    });

    await expect(
      inference.experimental.runTools({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x" } }],
        execute: { x: async () => "ok" },
      })
    ).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ipa-tools/);
    expect(warnings[0]).not.toMatch(/experimental\.request is deprecated/);

    await expect(
      inference.experimental.runTools({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x" } }],
        execute: { x: async () => "ok" },
      })
    ).rejects.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
