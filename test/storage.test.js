import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  getSettings,
  grantOriginAlways,
  normalizeProviderId,
  saveSettings,
} from "../src/storage.js";

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
});

describe("normalizeProviderId", () => {
  it("trims valid ids and defaults blanks to openai", () => {
    expect(normalizeProviderId("ollama")).toBe("ollama");
    expect(normalizeProviderId("  openai  ")).toBe("openai");
    expect(normalizeProviderId("openrouter")).toBe("openrouter");
    expect(normalizeProviderId("")).toBe("openai");
    expect(normalizeProviderId("   ")).toBe("openai");
    expect(normalizeProviderId(undefined)).toBe("openai");
  });
});

describe("getSettings", () => {
  it("returns defaults when storage is empty", async () => {
    await expect(getSettings()).resolves.toMatchObject({
      apiKeys: {},
      defaultProviderId: "openai",
      defaultModel: "gpt-5.6-luna",
      defaultModels: { openai: "gpt-5.6-luna", openrouter: "openrouter/auto" },
      allowedOrigins: {},
      blockedOrigins: {},
    });
  });

  it("migrates a legacy openaiApiKey into apiKeys.openai", async () => {
    chromeMock.store.set("openaiApiKey", " sk-legacy ");

    const settings = await getSettings();
    expect(settings.apiKeys).toEqual({ openai: "sk-legacy" });
    expect(chromeMock.store.get("apiKeys")).toEqual({ openai: "sk-legacy" });
    expect(chromeMock.store.has("openaiApiKey")).toBe(false);

    // Idempotent: a later read does not overwrite a user-updated key, and still
    // removes any leftover legacy credential.
    chromeMock.store.set("apiKeys", { openai: "sk-new" });
    chromeMock.store.set("openaiApiKey", "sk-stale");
    const again = await getSettings();
    expect(again.apiKeys.openai).toBe("sk-new");
    expect(chromeMock.store.has("openaiApiKey")).toBe(false);
  });

  it("migrates a flat defaultModel into defaultModels and removes the legacy key", async () => {
    chromeMock.store.set("defaultProviderId", "openai");
    chromeMock.store.set("defaultModel", "gpt-4.1-nano");

    const settings = await getSettings();
    expect(settings.defaultModels).toEqual({ openai: "gpt-4.1-nano" });
    expect(settings.defaultModel).toBe("gpt-4.1-nano");
    expect(chromeMock.store.has("defaultModel")).toBe(false);
  });

  it("scrubs an OpenAI model stored under openrouter", async () => {
    chromeMock.store.set("defaultProviderId", "openrouter");
    chromeMock.store.set("defaultModels", {
      openai: "gpt-5.6-luna",
      openrouter: "gpt-5.6-luna",
    });

    const settings = await getSettings();
    expect(settings.defaultModels.openrouter).toBeUndefined();
    expect(settings.defaultModels.openai).toBe("gpt-5.6-luna");
    expect(settings.defaultModel).toBe("openrouter/auto");
  });

  it("does not migrate a flat OpenAI model onto openrouter", async () => {
    chromeMock.store.set("defaultProviderId", "openrouter");
    chromeMock.store.set("defaultModel", "gpt-5.6-luna");

    const settings = await getSettings();
    expect(settings.defaultModels.openrouter).not.toBe("gpt-5.6-luna");
    expect(settings.defaultModel).toBe("openrouter/auto");
  });

  it("scrubs opaque and file origins from stored grants/blocks", async () => {
    chromeMock.store.set("allowedOrigins", {
      "https://ok.example": { allowedAt: 1, providerId: "openai", model: "gpt-4o-mini" },
      null: { allowedAt: 2, providerId: "openai", model: "gpt-4o-mini" },
      "file://": { allowedAt: 3 },
      "file:///tmp/x": { allowedAt: 4 },
    });
    chromeMock.store.set("blockedOrigins", {
      "https://blocked.example": { blockedAt: 5 },
      null: { blockedAt: 6 },
    });

    const settings = await getSettings();
    expect(Object.keys(settings.allowedOrigins)).toEqual(["https://ok.example"]);
    expect(Object.keys(settings.blockedOrigins)).toEqual([
      "https://blocked.example",
    ]);
    expect(chromeMock.store.get("allowedOrigins")).toEqual({
      "https://ok.example": {
        allowedAt: 1,
        providerId: "openai",
        model: "gpt-4o-mini",
      },
    });
  });
});

describe("saveSettings apiKeys and defaultModels", () => {
  it("merges per-provider keys and clears blanks", async () => {
    await saveSettings({
      apiKeys: { openai: " sk-oai ", openrouter: "sk-or" },
      defaultProviderId: "openrouter",
      defaultModel: "openrouter/free",
    });
    let settings = await getSettings();
    expect(settings).toMatchObject({
      defaultProviderId: "openrouter",
      defaultModel: "openrouter/free",
      defaultModels: { openrouter: "openrouter/free" },
      apiKeys: { openai: "sk-oai", openrouter: "sk-or" },
    });

    await saveSettings({ apiKeys: { openrouter: "  " } });
    settings = await getSettings();
    expect(settings.apiKeys).toEqual({ openai: "sk-oai" });
  });

  it("keeps per-provider default models when switching the active provider", async () => {
    await saveSettings({
      defaultProviderId: "openai",
      defaultModel: "gpt-4.1-nano",
      defaultModels: { openai: "gpt-4.1-nano" },
    });
    await saveSettings({
      defaultProviderId: "openrouter",
      defaultModel: "openrouter/free",
      defaultModels: {
        openai: "gpt-4.1-nano",
        openrouter: "openrouter/free",
      },
    });
    const settings = await getSettings();
    expect(settings.defaultProviderId).toBe("openrouter");
    expect(settings.defaultModel).toBe("openrouter/free");
    expect(settings.defaultModels).toEqual({
      openai: "gpt-4.1-nano",
      openrouter: "openrouter/free",
    });
  });

  it("does not overwrite defaultModel with blank saveSettings patches", async () => {
    await saveSettings({
      defaultProviderId: "ollama",
      defaultModel: "gemma4",
      apiKeys: { openai: " sk-test " },
    });
    let settings = await getSettings();
    expect(settings).toMatchObject({
      defaultProviderId: "ollama",
      defaultModel: "gemma4",
      defaultModels: { ollama: "gemma4" },
      apiKeys: { openai: "sk-test" },
    });

    await saveSettings({ defaultModel: "   " });
    settings = await getSettings();
    expect(settings.defaultModel).toBe("gemma4");
  });

  it("does not wipe a saved model when an implausible defaultModel is patched", async () => {
    await saveSettings({
      defaultProviderId: "openrouter",
      defaultModel: "openrouter/free",
    });

    await saveSettings({
      defaultProviderId: "openrouter",
      defaultModel: "gpt-5.6-luna",
      defaultModels: { openrouter: "gpt-5.6-luna" },
    });

    const settings = await getSettings();
    expect(settings.defaultModels.openrouter).toBe("openrouter/free");
    expect(settings.defaultModel).toBe("openrouter/free");
  });
});

describe("origin grants still work with openrouter", () => {
  it("grants an openrouter origin", async () => {
    await grantOriginAlways("https://app.example", {
      providerId: "openrouter",
      model: "openrouter/free",
    });
    const settings = await getSettings();
    expect(settings.allowedOrigins["https://app.example"]).toMatchObject({
      providerId: "openrouter",
      model: "openrouter/free",
    });
  });
});
