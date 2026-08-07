import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  getDefaultProvider,
  getProvider,
  getProviderAsync,
  listAllProviders,
  listProviders,
  resolveProviderModels,
} from "../src/providers/registry.js";
import { saveCompatEndpoints } from "../src/storage.js";

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
});

describe("provider registry", () => {
  it("registers openai, ollama, and openrouter", () => {
    const ids = listProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["ollama", "openai", "openrouter"]);
    expect(getDefaultProvider().id).toBe("openai");
    expect(getProvider("missing")).toBeUndefined();
  });

  it("merges saved compat endpoints into listAllProviders", async () => {
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    const all = await listAllProviders();
    const ids = all.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("compat:lm");
    const compat = await getProviderAsync("compat:lm");
    expect(compat?.label).toContain("LM Studio");
    expect(getProvider("compat:lm")).toBeUndefined();
  });

  it("still returns built-ins when settings fail to load", async () => {
    const originalGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = async () => {
      throw new Error("storage unavailable");
    };
    try {
      const all = await listAllProviders();
      expect(all.map((p) => p.id).sort()).toEqual([
        "ollama",
        "openai",
        "openrouter",
      ]);
    } finally {
      globalThis.chrome.storage.local.get = originalGet;
    }
  });

  it("resolves static OpenAI models as ModelInfo entries", async () => {
    const openai = getProvider("openai");
    expect(openai).toBeDefined();
    expect(openai.defaultModel).toBe("gpt-5.6-luna");
    const models = await resolveProviderModels(openai);
    expect(models).toContainEqual({ id: "gpt-5.6-luna" });
    expect(models).toContainEqual({ id: "gpt-5-nano" });
    expect(models).toContainEqual({ id: "gpt-4.1" });
    expect(models).toEqual(openai.models.map((id) => ({ id })));
  });

  it("exposes OpenRouter with listModels and requiresApiKey", () => {
    const openrouter = getProvider("openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.requiresApiKey).toBe(true);
    expect(openrouter.label).toBe("OpenRouter");
    expect(typeof openrouter.listModels).toBe("function");
    expect(openrouter.defaultModel).toBe("openrouter/auto");
  });
});
