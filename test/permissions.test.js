import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  cancelApproval,
  ensurePermission,
  getPendingApproval,
  handleApprovalWindowClosed,
  resolveApproval,
} from "../src/permissions.js";
import {
  blockOrigin,
  grantOriginAlways,
  getOriginGrant,
  getOriginLastUsed,
  isOriginBlocked,
  saveSettings,
  setOriginLastUsed,
} from "../src/storage.js";

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
  vi.restoreAllMocks();
});

/**
 * @param {string} requestId
 */
async function waitForPending(requestId) {
  await vi.waitFor(() => {
    expect(getPendingApproval(requestId)).not.toBeNull();
  });
}

describe("ensurePermission", () => {
  it("denies blocked origins without prompting", async () => {
    await blockOrigin("https://blocked.example");

    await expect(
      ensurePermission({
        requestId: "r1",
        origin: "https://blocked.example",
        messages: [{ role: "user", content: "hi" }],
      })
    ).resolves.toEqual({
      allowed: false,
      providerId: "openai",
      model: "gpt-5.6-luna",
      once: false,
    });
    expect(getPendingApproval("r1")).toBeNull();
  });

  it("reuses an existing always-allow grant without prompting", async () => {
    await grantOriginAlways("https://app.example", {
      providerId: "ollama",
      model: "gemma4",
    });

    await expect(
      ensurePermission({
        requestId: "r2",
        origin: "https://app.example",
        messages: [{ role: "user", content: "hi" }],
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: false,
    });
    expect(getPendingApproval("r2")).toBeNull();
  });

  it("reuses a compat grant when host permission is still present", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    globalThis.chrome.permissions = {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    };
    await grantOriginAlways("https://compat-grant.example", {
      providerId: "compat:lm",
      model: "local-model",
    });

    await expect(
      ensurePermission({
        requestId: "r2compat-ok",
        origin: "https://compat-grant.example",
        messages: [{ role: "user", content: "hi" }],
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "compat:lm",
      model: "local-model",
      once: false,
    });
    expect(getPendingApproval("r2compat-ok")).toBeNull();
  });

  it("re-prompts when a compat grant exists but host permission was revoked", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    await saveSettings({
      defaultProviderId: "openai",
      defaultModels: { openai: "gpt-4o" },
    });
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    globalThis.chrome.permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    };
    await grantOriginAlways("https://compat-grant.example", {
      providerId: "compat:lm",
      model: "local-model",
    });

    const pending = ensurePermission({
      requestId: "r2compat-revoked",
      origin: "https://compat-grant.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r2compat-revoked");

    // Prefill the stored grant — not global defaults — so Always allow cannot
    // silently overwrite the compat grant with OpenAI / another default.
    expect(getPendingApproval("r2compat-revoked")).toMatchObject({
      providerId: "compat:lm",
      model: "local-model",
    });

    resolveApproval("r2compat-revoked", {
      decision: "deny",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("falls back to the grant provider default model, not settings.defaultModel", async () => {
    await saveSettings({
      defaultProviderId: "openai",
      defaultModel: "gpt-4o",
    });
    await grantOriginAlways("https://app.example", {
      providerId: "ollama",
      model: "",
    });

    await expect(
      ensurePermission({
        requestId: "r3",
        origin: "https://app.example",
        messages: [{ role: "user", content: "hi" }],
      })
    ).resolves.toMatchObject({
      allowed: true,
      providerId: "ollama",
      // ollamaProvider.defaultModel
      model: expect.any(String),
    });

    const result = await ensurePermission({
      requestId: "r3b",
      origin: "https://app.example",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.model).not.toBe("gpt-4o");
  });

  it("does not reuse settings.defaultModel when preferred provider differs", async () => {
    await saveSettings({
      defaultProviderId: "ollama",
      defaultModel: "gemma4",
    });

    const pending = ensurePermission({
      requestId: "r4",
      origin: "https://app.example",
      messages: [{ role: "user", content: "hi" }],
      preferredProviderId: "openai",
    });
    await waitForPending("r4");

    const request = getPendingApproval("r4");
    expect(request).toMatchObject({
      providerId: "openai",
      model: "gpt-5.6-luna",
    });
    expect(request.model).not.toBe("gemma4");

    resolveApproval("r4", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-5.6-luna",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("allow_once does not persist a grant", async () => {
    const pending = ensurePermission({
      requestId: "r5",
      origin: "https://once.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r5");

    resolveApproval("r5", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    await expect(pending).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });
    await expect(getOriginGrant("https://once.example")).resolves.toBeNull();
    await expect(getOriginLastUsed("https://once.example")).resolves.toMatchObject({
      providerId: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("prefills the next prompt from the last allow_once choice", async () => {
    await saveSettings({
      defaultProviderId: "openai",
      defaultModel: "gpt-5.6-luna",
    });
    await setOriginLastUsed("https://cache.example", {
      providerId: "openrouter",
      model: "openrouter/free",
    });

    const pending = ensurePermission({
      requestId: "r5b",
      origin: "https://cache.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r5b");

    expect(getPendingApproval("r5b")).toMatchObject({
      providerId: "openrouter",
      model: "openrouter/free",
    });

    resolveApproval("r5b", {
      decision: "deny",
      providerId: "openrouter",
      model: "openrouter/free",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("prefills last-used OpenAI-compatible endpoints", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    await saveSettings({
      defaultProviderId: "openai",
      defaultModel: "gpt-5.6-luna",
      defaultModels: { "compat:lm": "local-model" },
    });
    await setOriginLastUsed("https://compat-cache.example", {
      providerId: "compat:lm",
      model: "local-model",
    });

    const pending = ensurePermission({
      requestId: "r5compat",
      origin: "https://compat-cache.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r5compat");

    expect(getPendingApproval("r5compat")).toMatchObject({
      providerId: "compat:lm",
      model: "local-model",
    });

    resolveApproval("r5compat", {
      decision: "deny",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("prefers explicit preferredProviderId over last-used", async () => {
    await setOriginLastUsed("https://pref.example", {
      providerId: "openrouter",
      model: "openrouter/free",
    });

    const pending = ensurePermission({
      requestId: "r5c",
      origin: "https://pref.example",
      messages: [{ role: "user", content: "hi" }],
      preferredProviderId: "openai",
      preferredModel: "gpt-4o",
    });
    await waitForPending("r5c");

    expect(getPendingApproval("r5c")).toMatchObject({
      providerId: "openai",
      model: "gpt-4o",
    });

    resolveApproval("r5c", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("always persists provider + model", async () => {
    const pending = ensurePermission({
      requestId: "r6",
      origin: "https://always.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r6");

    resolveApproval("r6", {
      decision: "always",
      providerId: "ollama",
      model: "gemma4",
    });

    await expect(pending).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: false,
    });
    await expect(getOriginGrant("https://always.example")).resolves.toMatchObject({
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(getOriginLastUsed("https://always.example")).resolves.toMatchObject({
      providerId: "ollama",
      model: "gemma4",
    });
  });

  it("never blocks the origin", async () => {
    await setOriginLastUsed("https://never.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    const pending = ensurePermission({
      requestId: "r7",
      origin: "https://never.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r7");

    resolveApproval("r7", {
      decision: "never",
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    await expect(pending).resolves.toMatchObject({ allowed: false, once: false });
    await expect(isOriginBlocked("https://never.example")).resolves.toBe(true);
    await expect(getOriginLastUsed("https://never.example")).resolves.toBeNull();
  });

  it("uses the chosen provider default when switching providers in the prompt", async () => {
    await saveSettings({
      defaultProviderId: "openai",
      defaultModel: "gpt-4o",
    });

    const pending = ensurePermission({
      requestId: "r8",
      origin: "https://switch.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r8");

    // User picks Ollama but leaves model blank — must not keep gpt-4o.
    resolveApproval("r8", {
      decision: "allow_once",
      providerId: "ollama",
      model: "",
    });

    const result = await pending;
    expect(result).toMatchObject({
      allowed: true,
      providerId: "ollama",
      once: true,
    });
    // Ollama has no static defaultModel; never keep the OpenAI settings model.
    expect(result.model).not.toBe("gpt-4o");
  });

  it("honors a free-typed OpenRouter model from the approval UI", async () => {
    await saveSettings({
      defaultProviderId: "openrouter",
      defaultModel: "openrouter/auto",
    });

    const pending = ensurePermission({
      requestId: "r8b",
      origin: "https://free-type.example",
      messages: [{ role: "user", content: "hi" }],
      preferredProviderId: "openrouter",
    });
    await waitForPending("r8b");

    // Approval UI accepts any non-blank OpenRouter slug via isModelValid;
    // ensurePermission must not drop it for lacking a "/".
    resolveApproval("r8b", {
      decision: "allow_once",
      providerId: "openrouter",
      model: "my-custom-endpoint",
    });

    await expect(pending).resolves.toEqual({
      allowed: true,
      providerId: "openrouter",
      model: "my-custom-endpoint",
      once: true,
    });
  });
});

describe("resolveApproval", () => {
  it("keeps the pending request provider when providerId is blank", async () => {
    const pending = ensurePermission({
      requestId: "r9",
      origin: "https://blank.example",
      messages: [{ role: "user", content: "hi" }],
      preferredProviderId: "ollama",
      preferredModel: "gemma4",
    });
    await waitForPending("r9");

    resolveApproval("r9", {
      decision: "allow_once",
      providerId: "   ",
      model: "gemma4",
    });

    await expect(pending).resolves.toMatchObject({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
    });
  });

  it("treats unknown decisions as deny", async () => {
    const pending = ensurePermission({
      requestId: "r10",
      origin: "https://bad.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r10");

    resolveApproval("r10", {
      // @ts-expect-error intentional bad decision
      decision: "maybe",
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    await expect(pending).resolves.toMatchObject({ allowed: false });
  });
});

describe("cancelApproval and window close", () => {
  it("denies when cancelApproval is called", async () => {
    const pending = ensurePermission({
      requestId: "r11",
      origin: "https://cancel.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r11");

    cancelApproval("r11");
    await expect(pending).resolves.toMatchObject({ allowed: false });
    expect(getPendingApproval("r11")).toBeNull();
  });

  it("denies when the approval window is closed", async () => {
    const pending = ensurePermission({
      requestId: "r12",
      origin: "https://closed.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r12");

    // chrome-mock assigns window id 1001
    handleApprovalWindowClosed(1001);
    await expect(pending).resolves.toMatchObject({ allowed: false });
    expect(getPendingApproval("r12")).toBeNull();
  });
});
