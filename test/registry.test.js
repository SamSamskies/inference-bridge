import { describe, expect, it } from "vitest";
import {
  getDefaultProvider,
  getProvider,
  listProviders,
  resolveProviderModels,
} from "../src/providers/registry.js";

describe("provider registry", () => {
  it("registers openai, ollama, and openrouter", () => {
    const ids = listProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["ollama", "openai", "openrouter"]);
    expect(getDefaultProvider().id).toBe("openai");
    expect(getProvider("missing")).toBeUndefined();
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
