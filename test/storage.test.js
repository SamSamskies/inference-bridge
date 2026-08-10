import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  getSettings,
  grantOriginAlways,
  isPlausibleModelForProvider,
  normalizeProviderId,
  saveCompatEndpoints,
  saveSettings,
  setOriginLastUsed,
  getOriginLastUsed,
  blockOrigin,
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
      defaultModels: {
        openai: "gpt-5.6-luna",
        anthropic: "claude-sonnet-5",
        openrouter: "openrouter/auto",
      },
      compatEndpoints: [],
      allowedOrigins: {},
      blockedOrigins: {},
      originLastUsed: {},
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

  it("scrubs an OpenAI model stored under ollama", async () => {
    chromeMock.store.set("defaultProviderId", "ollama");
    chromeMock.store.set("defaultModels", {
      openai: "gpt-5.6-luna",
      ollama: "gpt-5.6-luna",
    });

    const settings = await getSettings();
    expect(settings.defaultModels.ollama).toBeUndefined();
    expect(settings.defaultModels.openai).toBe("gpt-5.6-luna");
    expect(settings.defaultModel).toBe("");
  });

  it("does not migrate a flat OpenAI model onto ollama", async () => {
    chromeMock.store.set("defaultProviderId", "ollama");
    chromeMock.store.set("defaultModel", "gpt-5.6-luna");

    const settings = await getSettings();
    expect(settings.defaultModels.ollama).not.toBe("gpt-5.6-luna");
    expect(settings.defaultModel).toBe("");
  });

  it("does not fall back to the OpenAI default when ollama has no model", async () => {
    chromeMock.store.set("defaultProviderId", "ollama");
    chromeMock.store.set("defaultModels", {
      openai: "gpt-5.6-luna",
      openrouter: "openrouter/auto",
    });

    const settings = await getSettings();
    expect(settings.defaultModel).toBe("");
    expect(settings.defaultModels.ollama).toBeUndefined();
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
    chromeMock.store.set("originLastUsed", {
      "https://ok.example": {
        providerId: "openai",
        model: "gpt-4o-mini",
        usedAt: 7,
      },
      null: { providerId: "openai", model: "gpt-4o", usedAt: 8 },
      "file:///tmp/x": { providerId: "ollama", model: "gemma4", usedAt: 9 },
    });

    const settings = await getSettings();
    expect(Object.keys(settings.allowedOrigins)).toEqual(["https://ok.example"]);
    expect(Object.keys(settings.blockedOrigins)).toEqual([
      "https://blocked.example",
    ]);
    expect(Object.keys(settings.originLastUsed)).toEqual(["https://ok.example"]);
    expect(chromeMock.store.get("allowedOrigins")).toEqual({
      "https://ok.example": {
        allowedAt: 1,
        providerId: "openai",
        model: "gpt-4o-mini",
      },
    });
    expect(chromeMock.store.get("originLastUsed")).toEqual({
      "https://ok.example": {
        providerId: "openai",
        model: "gpt-4o-mini",
        usedAt: 7,
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
      anthropic: "claude-sonnet-5",
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

describe("isPlausibleModelForProvider", () => {
  it("accepts any non-empty model for compat:* providers", () => {
    expect(isPlausibleModelForProvider("compat:abc", "local-model")).toBe(true);
    expect(isPlausibleModelForProvider("compat:abc", "org/model")).toBe(true);
    expect(isPlausibleModelForProvider("compat:abc", "")).toBe(false);
  });

  it("accepts Claude ids for Anthropic and rejects slash or OpenAI ids", () => {
    expect(isPlausibleModelForProvider("anthropic", "claude-sonnet-5")).toBe(
      true
    );
    expect(
      isPlausibleModelForProvider("anthropic", "claude-opus-4-20250514")
    ).toBe(true);
    expect(
      isPlausibleModelForProvider("anthropic", "anthropic/claude-sonnet-5")
    ).toBe(false);
    expect(isPlausibleModelForProvider("anthropic", "gpt-5.6-luna")).toBe(
      false
    );
    expect(isPlausibleModelForProvider("anthropic", "")).toBe(false);
  });
});

describe("compatEndpoints", () => {
  it("normalizes base URLs and persists named endpoints", async () => {
    await saveCompatEndpoints([
      {
        id: "compat:one",
        name: "  LM Studio ",
        baseUrl: "http://127.0.0.1:1234",
      },
    ]);
    const settings = await getSettings();
    expect(settings.compatEndpoints).toEqual([
      {
        id: "compat:one",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
  });

  it("scrubs orphaned apiKeys, defaultModels, and resets default provider", async () => {
    await saveCompatEndpoints([
      { id: "compat:keep", name: "Keep", baseUrl: "http://127.0.0.1:1111/v1" },
      { id: "compat:drop", name: "Drop", baseUrl: "http://127.0.0.1:2222/v1" },
    ]);
    await saveSettings({
      apiKeys: {
        openai: "sk-oai",
        "compat:keep": "key-keep",
        "compat:drop": "key-drop",
      },
      defaultProviderId: "compat:drop",
      defaultModels: {
        "compat:keep": "a",
        "compat:drop": "b",
      },
    });
    await grantOriginAlways("https://app.example", {
      providerId: "compat:drop",
      model: "b",
    });
    await setOriginLastUsed("https://other.example", {
      providerId: "compat:drop",
      model: "b",
    });

    await saveCompatEndpoints([
      { id: "compat:keep", name: "Keep", baseUrl: "http://127.0.0.1:1111/v1" },
    ]);

    const settings = await getSettings();
    expect(settings.compatEndpoints).toHaveLength(1);
    expect(settings.apiKeys["compat:drop"]).toBeUndefined();
    expect(settings.apiKeys["compat:keep"]).toBe("key-keep");
    expect(settings.defaultModels["compat:drop"]).toBeUndefined();
    expect(settings.defaultProviderId).toBe("openai");
    expect(settings.allowedOrigins["https://app.example"]).toBeUndefined();
    expect(settings.originLastUsed["https://other.example"]).toBeUndefined();
  });

  it("drops invalid endpoint entries on read", async () => {
    chromeMock.store.set("compatEndpoints", [
      { id: "compat:ok", name: "Ok", baseUrl: "http://127.0.0.1:1/v1" },
      { id: "bad", name: "No", baseUrl: "http://127.0.0.1:2/v1" },
      { id: "compat:x", name: "", baseUrl: "http://127.0.0.1:3/v1" },
      { id: "compat:y", name: "Y", baseUrl: "ftp://127.0.0.1:4" },
    ]);
    const settings = await getSettings();
    expect(settings.compatEndpoints).toEqual([
      { id: "compat:ok", name: "Ok", baseUrl: "http://127.0.0.1:1/v1" },
    ]);
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

describe("originLastUsed", () => {
  it("stores and reads the last approval choice without granting access", async () => {
    await setOriginLastUsed("https://app.example", {
      providerId: "openrouter",
      model: "openrouter/free",
    });

    await expect(getOriginLastUsed("https://app.example")).resolves.toMatchObject({
      providerId: "openrouter",
      model: "openrouter/free",
    });
    const settings = await getSettings();
    expect(settings.allowedOrigins["https://app.example"]).toBeUndefined();
    expect(settings.originLastUsed["https://app.example"]).toMatchObject({
      providerId: "openrouter",
      model: "openrouter/free",
    });
  });

  it("clears last-used when the origin is blocked", async () => {
    await setOriginLastUsed("https://app.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await blockOrigin("https://app.example");

    await expect(getOriginLastUsed("https://app.example")).resolves.toBeNull();
  });
});
