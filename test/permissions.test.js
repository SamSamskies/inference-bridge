import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  cancelApproval,
  clearToolEpisodes,
  ensurePermission,
  getPendingApproval,
  handleApprovalWindowClosed,
  onAllowedOriginsStorageChanged,
  resolveApproval,
} from "../src/permissions.js";
import {
  blockOrigin,
  grantOriginAlways,
  getOriginGrant,
  getOriginLastUsed,
  isOriginBlocked,
  revokeOrigin,
  saveSettings,
  setOriginLastUsed,
  setOriginProviderModel,
} from "../src/storage.js";

const chromeMock = installChromeMock();
chrome.storage.onChanged.addListener(onAllowedOriginsStorageChanged);

const weatherTools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

const weatherFollowUpMessages = [
  { role: "user", content: "Weather in Austin?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: '{"tempC":22}' },
];

beforeEach(() => {
  chromeMock.reset();
  clearToolEpisodes();
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

  it("re-prompts when a compat grant's provider no longer resolves", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    const registry = await import("../src/providers/registry.js");
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
    await grantOriginAlways("https://compat-missing.example", {
      providerId: "compat:lm",
      model: "local-model",
    });

    // Simulate endpoint disappearing between grant read and provider resolve.
    const realGetProviderAsync = registry.getProviderAsync;
    vi.spyOn(registry, "getProviderAsync").mockImplementation(async (id) => {
      if (id === "compat:lm") return undefined;
      return realGetProviderAsync(id);
    });

    const pending = ensurePermission({
      requestId: "r2compat-missing",
      origin: "https://compat-missing.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r2compat-missing");

    expect(getPendingApproval("r2compat-missing")).toMatchObject({
      providerId: "compat:lm",
      model: "local-model",
    });

    resolveApproval("r2compat-missing", {
      decision: "deny",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
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

  it("denies allow_once for compat when host permission is still missing", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
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
      requestId: "r2compat-approve-no-host",
      origin: "https://compat-grant.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r2compat-approve-no-host");

    resolveApproval("r2compat-approve-no-host", {
      decision: "allow_once",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(pending).resolves.toEqual({
      allowed: false,
      providerId: "compat:lm",
      model: "local-model",
      once: false,
      code: "unavailable",
      message: expect.stringMatching(/host permission/i),
    });
  });

  it("denies approval when the chosen compat provider no longer resolves", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    const registry = await import("../src/providers/registry.js");
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

    const pending = ensurePermission({
      requestId: "r2compat-chosen-gone",
      origin: "https://compat-chosen-gone.example",
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("r2compat-chosen-gone");

    const realGetProviderAsync = registry.getProviderAsync;
    vi.spyOn(registry, "getProviderAsync").mockImplementation(async (id) => {
      if (id === "compat:lm") return undefined;
      return realGetProviderAsync(id);
    });

    resolveApproval("r2compat-chosen-gone", {
      decision: "allow_once",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(pending).resolves.toEqual({
      allowed: false,
      providerId: "compat:lm",
      model: "local-model",
      once: false,
      code: "unavailable",
      message: expect.stringMatching(/unknown provider/i),
    });
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

describe("ensurePermission with tools", () => {
  it("re-prompts Always-allow origins when tools are present", async () => {
    await grantOriginAlways("https://tools.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const pending = ensurePermission({
      requestId: "rt1",
      origin: "https://tools.example",
      messages: [{ role: "user", content: "weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt1");

    expect(getPendingApproval("rt1")).toMatchObject({
      origin: "https://tools.example",
      tools: weatherTools,
    });

    resolveApproval("rt1", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("skips the prompt when Always-allow already covers the tool fingerprint", async () => {
    const pending = ensurePermission({
      requestId: "rt2a",
      origin: "https://tools-grant.example",
      messages: [{ role: "user", content: "weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt2a");
    resolveApproval("rt2a", {
      decision: "always",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(pending).resolves.toMatchObject({ allowed: true, once: false });

    const grant = await getOriginGrant("https://tools-grant.example");
    expect(grant?.toolFingerprint).toBe("fn:get_weather");

    await expect(
      ensurePermission({
        requestId: "rt2b",
        origin: "https://tools-grant.example",
        messages: [{ role: "user", content: "again?" }],
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: false,
    });
    expect(getPendingApproval("rt2b")).toBeNull();
  });

  it("re-prompts when Always-allow tools grant does not cover new tools", async () => {
    const pending = ensurePermission({
      requestId: "rt3a",
      origin: "https://tools-expand.example",
      messages: [{ role: "user", content: "weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt3a");
    resolveApproval("rt3a", {
      decision: "always",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(pending).resolves.toMatchObject({ allowed: true });

    const expanded = ensurePermission({
      requestId: "rt3b",
      origin: "https://tools-expand.example",
      messages: [{ role: "user", content: "time?" }],
      tools: [
        ...weatherTools,
        { type: "function", function: { name: "get_time" } },
      ],
    });
    await waitForPending("rt3b");
    expect(getPendingApproval("rt3b")?.tools).toHaveLength(2);
    resolveApproval("rt3b", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(expanded).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts tools Always-allow when omitted-tools continuation has no episode", async () => {
    await grantOriginAlways("https://tools-forge-plain.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
      toolFingerprint: "fn:get_weather",
    });
    clearToolEpisodes();

    const pending = ensurePermission({
      requestId: "rt3c",
      origin: "https://tools-forge-plain.example",
      messages: weatherFollowUpMessages,
    });
    await waitForPending("rt3c");
    resolveApproval("rt3c", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts plain Always-allow when omitted-tools continuation has no episode", async () => {
    await grantOriginAlways("https://plain-forge-tools.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    clearToolEpisodes();

    const pending = ensurePermission({
      requestId: "rt3d",
      origin: "https://plain-forge-tools.example",
      messages: weatherFollowUpMessages,
    });
    await waitForPending("rt3d");
    resolveApproval("rt3d", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("clears toolFingerprint when Always-allow is re-granted without tools", async () => {
    const withTools = ensurePermission({
      requestId: "rt4a",
      origin: "https://tools-clear.example",
      messages: [{ role: "user", content: "weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt4a");
    resolveApproval("rt4a", {
      decision: "always",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(withTools).resolves.toMatchObject({ allowed: true });
    await expect(getOriginGrant("https://tools-clear.example")).resolves.toMatchObject({
      toolFingerprint: "fn:get_weather",
    });

    clearToolEpisodes();
    const plain = ensurePermission({
      requestId: "rt4b",
      origin: "https://tools-clear.example",
      messages: [{ role: "user", content: "hi" }],
    });
    // Plain chat still uses the grant without prompting.
    await expect(plain).resolves.toMatchObject({ allowed: true, once: false });

    // Re-grant plain chat via a tools-less Always from a fresh prompt path:
    // force a prompt by using a different origin flow — grantOriginAlways directly.
    await grantOriginAlways("https://tools-clear.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(getOriginGrant("https://tools-clear.example")).resolves.toEqual({
      allowedAt: expect.any(Number),
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const again = ensurePermission({
      requestId: "rt4c",
      origin: "https://tools-clear.example",
      messages: [{ role: "user", content: "weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt4c");
    resolveApproval("rt4c", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(again).resolves.toMatchObject({ allowed: false });
  });

  it("forgets in-memory tool episodes when Always-allow is granted without tools", async () => {
    const origin = "https://tools-episode-clear.example";
    const opening = [{ role: "user", content: "Weather in Austin?" }];
    const followUp = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_ep_clear",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_ep_clear",
        content: '{"tempC":22}',
      },
    ];

    const turn1 = ensurePermission({
      requestId: "rt4d",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt4d");
    resolveApproval("rt4d", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true, once: true });

    const plain = ensurePermission({
      requestId: "rt4e",
      origin,
      messages: [{ role: "user", content: "hi" }],
    });
    await waitForPending("rt4e");
    resolveApproval("rt4e", {
      decision: "always",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(plain).resolves.toMatchObject({ allowed: true, once: false });
    await expect(getOriginGrant(origin)).resolves.toEqual({
      allowedAt: expect.any(Number),
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    // Old allow_once follow-up must re-prompt; episode should not survive the
    // tools-less Always-allow.
    const again = ensurePermission({
      requestId: "rt4f",
      origin,
      messages: followUp,
      tools: weatherTools,
    });
    await waitForPending("rt4f");
    resolveApproval("rt4f", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(again).resolves.toMatchObject({ allowed: false });
  });

  it("forgets broader in-memory episodes when tools Always-allow narrows the grant", async () => {
    const origin = "https://tools-episode-narrow.example";
    const searchTool = {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    };
    const broadTools = [...weatherTools, searchTool];
    const openerBroad = [{ role: "user", content: "Weather and search?" }];
    const openerNarrow = [{ role: "user", content: "Just weather?" }];
    const followUpBroad = [
      ...openerBroad,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_narrow_search",
            type: "function",
            function: {
              name: "search_web",
              arguments: '{"q":"austin"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_narrow_search",
        content: '{"hits":1}',
      },
    ];

    const broad = ensurePermission({
      requestId: "rt4g",
      origin,
      messages: openerBroad,
      tools: broadTools,
    });
    await waitForPending("rt4g");
    resolveApproval("rt4g", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(broad).resolves.toMatchObject({ allowed: true, once: true });

    // Same-length opener pushes a second episode; Always-allow must clear the
    // broader one so search_web cannot keep auto-approving after the narrow.
    const narrow = ensurePermission({
      requestId: "rt4h",
      origin,
      messages: openerNarrow,
      tools: weatherTools,
    });
    await waitForPending("rt4h");
    resolveApproval("rt4h", {
      decision: "always",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(narrow).resolves.toMatchObject({ allowed: true, once: false });
    await expect(getOriginGrant(origin)).resolves.toMatchObject({
      toolFingerprint: "fn:get_weather",
    });

    const again = ensurePermission({
      requestId: "rt4i",
      origin,
      messages: followUpBroad,
      tools: broadTools,
    });
    await waitForPending("rt4i");
    resolveApproval("rt4i", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(again).resolves.toMatchObject({ allowed: false });
  });

  it("skips the second turn of an allow_once tools episode", async () => {
    const turn1 = ensurePermission({
      requestId: "rt5a",
      origin: "https://episode.example",
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt5a");
    resolveApproval("rt5a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({
      allowed: true,
      once: true,
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    await expect(
      ensurePermission({
        requestId: "rt5b",
        origin: "https://episode.example",
        messages: weatherFollowUpMessages,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });
    expect(getPendingApproval("rt5b")).toBeNull();
  });

  it("keeps separate allow_once episodes per message history on one origin", async () => {
    const origin = "https://episode-parallel.example";
    const austinMessages = [{ role: "user", content: "Weather in Austin?" }];
    const seattleMessages = [{ role: "user", content: "Weather in Seattle?" }];
    const austinFollowUp = [
      ...austinMessages,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_austin",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_austin", content: '{"tempC":22}' },
    ];
    const seattleFollowUp = [
      ...seattleMessages,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_seattle",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Seattle"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_seattle", content: '{"tempC":14}' },
    ];

    const turnA = ensurePermission({
      requestId: "rt5parallel-a",
      origin,
      messages: austinMessages,
      tools: weatherTools,
    });
    await waitForPending("rt5parallel-a");
    resolveApproval("rt5parallel-a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA).resolves.toMatchObject({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const turnB = ensurePermission({
      requestId: "rt5parallel-b",
      origin,
      messages: seattleMessages,
      tools: weatherTools,
    });
    await waitForPending("rt5parallel-b");
    resolveApproval("rt5parallel-b", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB).resolves.toMatchObject({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
    });

    await expect(
      ensurePermission({
        requestId: "rt5parallel-a2",
        origin,
        messages: austinFollowUp,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });
    expect(getPendingApproval("rt5parallel-a2")).toBeNull();

    await expect(
      ensurePermission({
        requestId: "rt5parallel-b2",
        origin,
        messages: seattleFollowUp,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: true,
    });
    expect(getPendingApproval("rt5parallel-b2")).toBeNull();
  });

  it("keeps separate allow_once episodes when two tabs share the same opening message", async () => {
    const origin = "https://episode-parallel-same.example";
    const opening = [{ role: "user", content: "Weather in Austin?" }];
    const followUpA = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_tab_a",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"a"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_tab_a", content: '{"tempC":22}' },
    ];
    const followUpB = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_tab_b",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"b"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_tab_b", content: '{"tempC":23}' },
    ];

    const turnA = ensurePermission({
      requestId: "rt5same-a",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5same-a");
    resolveApproval("rt5same-a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA).resolves.toMatchObject({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const turnB = ensurePermission({
      requestId: "rt5same-b",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5same-b");
    resolveApproval("rt5same-b", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB).resolves.toMatchObject({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
    });

    // First follow-up is ambiguous while both episodes still share the opener —
    // re-prompt rather than binding the wrong provider. Remember must update
    // the openai episode only so tab B's opening slot stays intact.
    const turnA2 = ensurePermission({
      requestId: "rt5same-a2",
      origin,
      messages: followUpA,
      tools: weatherTools,
    });
    await waitForPending("rt5same-a2");
    resolveApproval("rt5same-a2", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA2).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });

    await expect(
      ensurePermission({
        requestId: "rt5same-b2",
        origin,
        messages: followUpB,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: true,
    });
    expect(getPendingApproval("rt5same-b2")).toBeNull();
  });

  it("does not auto-bind the wrong provider when same-opener follow-ups race", async () => {
    const origin = "https://episode-parallel-race.example";
    const opening = [{ role: "user", content: "Weather in Austin?" }];
    const followUpA = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_race_a",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"a"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_race_a", content: '{"tempC":22}' },
    ];
    const followUpB = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_race_b",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"b"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_race_b", content: '{"tempC":23}' },
    ];

    const turnA = ensurePermission({
      requestId: "rt5race-a",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5race-a");
    resolveApproval("rt5race-a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA).resolves.toMatchObject({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const turnB = ensurePermission({
      requestId: "rt5race-b",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5race-b");
    resolveApproval("rt5race-b", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB).resolves.toMatchObject({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
    });

    // B follows up first while both episodes still share the opening prefix.
    // Ambiguous provider binding must re-prompt rather than steal tab A's episode.
    const turnB2 = ensurePermission({
      requestId: "rt5race-b2",
      origin,
      messages: followUpB,
      tools: weatherTools,
    });
    await waitForPending("rt5race-b2");
    resolveApproval("rt5race-b2", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB2).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: true,
    });

    // Tab A's opening episode must still be intact for its follow-up.
    await expect(
      ensurePermission({
        requestId: "rt5race-a2",
        origin,
        messages: followUpA,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });
    expect(getPendingApproval("rt5race-a2")).toBeNull();
  });

  it("forgets in-memory tool episodes when a re-prompted continuation is denied", async () => {
    const origin = "https://episode-deny-clear.example";
    const opening = [{ role: "user", content: "Weather in Austin?" }];
    const followUpA = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_deny_a",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"a"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_deny_a", content: '{"tempC":22}' },
    ];
    const followUpB = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_deny_b",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin","tab":"b"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_deny_b", content: '{"tempC":23}' },
    ];

    const turnA = ensurePermission({
      requestId: "rt5deny-a",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5deny-a");
    resolveApproval("rt5deny-a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA).resolves.toMatchObject({ allowed: true, once: true });

    const turnB = ensurePermission({
      requestId: "rt5deny-b",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5deny-b");
    resolveApproval("rt5deny-b", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB).resolves.toMatchObject({ allowed: true, once: true });

    // Ambiguous same-opener follow-up — deny must clear both episodes.
    const denied = ensurePermission({
      requestId: "rt5deny-a2",
      origin,
      messages: followUpA,
      tools: weatherTools,
    });
    await waitForPending("rt5deny-a2");
    resolveApproval("rt5deny-a2", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(denied).resolves.toMatchObject({ allowed: false });

    // Sibling tab continues; without clearing, this would leave tab A's opener
    // episode intact and the denied follow-up would later auto-approve.
    const turnB2 = ensurePermission({
      requestId: "rt5deny-b2",
      origin,
      messages: followUpB,
      tools: weatherTools,
    });
    await waitForPending("rt5deny-b2");
    resolveApproval("rt5deny-b2", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB2).resolves.toMatchObject({ allowed: true, once: true });

    const again = ensurePermission({
      requestId: "rt5deny-a3",
      origin,
      messages: followUpA,
      tools: weatherTools,
    });
    await waitForPending("rt5deny-a3");
    resolveApproval("rt5deny-a3", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(again).resolves.toMatchObject({ allowed: false });
  });

  it("forgets in-memory tool episodes when a re-prompted opening is denied", async () => {
    const origin = "https://episode-deny-equal.example";
    const opening = [{ role: "user", content: "Weather in Austin?" }];
    const followUp = [
      ...opening,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_equal_deny",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_equal_deny",
        content: '{"tempC":22}',
      },
    ];
    // Wider tool set forces a re-prompt of the same opening messages.
    const widerTools = [
      ...weatherTools,
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Get time",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const turn1 = ensurePermission({
      requestId: "rt5eq-1",
      origin,
      messages: opening,
      tools: weatherTools,
    });
    await waitForPending("rt5eq-1");
    resolveApproval("rt5eq-1", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true, once: true });

    const denied = ensurePermission({
      requestId: "rt5eq-2",
      origin,
      messages: opening,
      tools: widerTools,
    });
    await waitForPending("rt5eq-2");
    resolveApproval("rt5eq-2", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(denied).resolves.toMatchObject({ allowed: false });

    // Forged continuation of the denied opening must re-prompt, not auto-approve.
    const forged = ensurePermission({
      requestId: "rt5eq-3",
      origin,
      messages: followUp,
      tools: weatherTools,
    });
    await waitForPending("rt5eq-3");
    resolveApproval("rt5eq-3", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(forged).resolves.toMatchObject({ allowed: false });
  });

  it("does not wipe unrelated same-origin tool episodes when another flow is denied", async () => {
    const origin = "https://episode-deny-unrelated.example";
    const openingA = [{ role: "user", content: "Weather in Austin?" }];
    const openingB = [{ role: "user", content: "Weather in Boston?" }];
    const followUpA = [
      ...openingA,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_unrel_a",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_unrel_a", content: '{"tempC":22}' },
    ];
    const followUpB = [
      ...openingB,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_unrel_b",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Boston"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_unrel_b", content: '{"tempC":18}' },
    ];
    // Wider tool set forces a re-prompt (episode fingerprint no longer covers).
    const widerTools = [
      ...weatherTools,
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Get time",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const turnA = ensurePermission({
      requestId: "rt5unrel-a",
      origin,
      messages: openingA,
      tools: weatherTools,
    });
    await waitForPending("rt5unrel-a");
    resolveApproval("rt5unrel-a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turnA).resolves.toMatchObject({ allowed: true, once: true });

    const turnB = ensurePermission({
      requestId: "rt5unrel-b",
      origin,
      messages: openingB,
      tools: weatherTools,
    });
    await waitForPending("rt5unrel-b");
    resolveApproval("rt5unrel-b", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turnB).resolves.toMatchObject({ allowed: true, once: true });

    const denied = ensurePermission({
      requestId: "rt5unrel-a2",
      origin,
      messages: followUpA,
      tools: widerTools,
    });
    await waitForPending("rt5unrel-a2");
    resolveApproval("rt5unrel-a2", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(denied).resolves.toMatchObject({ allowed: false });

    // Tab B's distinct message history must still auto-continue.
    await expect(
      ensurePermission({
        requestId: "rt5unrel-b2",
        origin,
        messages: followUpB,
        tools: weatherTools,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: true,
    });
    expect(getPendingApproval("rt5unrel-b2")).toBeNull();
  });

  it("skips allow_once episode follow-ups that omit tools", async () => {
    const turn1 = ensurePermission({
      requestId: "rt5c",
      origin: "https://episode-omit.example",
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt5c");
    resolveApproval("rt5c", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true, once: true });

    await expect(
      ensurePermission({
        requestId: "rt5d",
        origin: "https://episode-omit.example",
        messages: weatherFollowUpMessages,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "openai",
      model: "gpt-4o-mini",
      once: true,
    });
    expect(getPendingApproval("rt5d")).toBeNull();
  });

  it("prefers allow_once episode over plain Always-allow when follow-up omits tools", async () => {
    await grantOriginAlways("https://episode-grant.example", {
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const turn1 = ensurePermission({
      requestId: "rt5e",
      origin: "https://episode-grant.example",
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt5e");
    resolveApproval("rt5e", {
      decision: "allow_once",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turn1).resolves.toMatchObject({
      allowed: true,
      once: true,
      providerId: "ollama",
      model: "gemma4",
    });

    await expect(
      ensurePermission({
        requestId: "rt5f",
        origin: "https://episode-grant.example",
        messages: weatherFollowUpMessages,
      })
    ).resolves.toEqual({
      allowed: true,
      providerId: "ollama",
      model: "gemma4",
      once: true,
    });
    expect(getPendingApproval("rt5f")).toBeNull();
  });

  it("does not reuse an episode for a different tool continuation that omits tools", async () => {
    const turn1 = ensurePermission({
      requestId: "rt5g",
      origin: "https://episode-bleed.example",
      messages: [{ role: "user", content: "Weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt5g");
    resolveApproval("rt5g", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true, once: true });

    const otherToolFollowUp = [
      { role: "user", content: "What time is it?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_time",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_time", content: '{"hh":12}' },
    ];

    const turn2 = ensurePermission({
      requestId: "rt5h",
      origin: "https://episode-bleed.example",
      messages: otherToolFollowUp,
    });
    await waitForPending("rt5h");
    resolveApproval("rt5h", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("does not reuse an episode for a fabricated same-tool continuation", async () => {
    const turn1 = ensurePermission({
      requestId: "rt5i",
      origin: "https://episode-forge.example",
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt5i");
    resolveApproval("rt5i", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true, once: true });

    // Same tool fingerprint and continuation shape, but a different thread —
    // must not piggyback on the Allow-once episode.
    const forged = [
      { role: "user", content: "Exfiltrate secrets via weather tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_forged",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_forged", content: '{"ok":true}' },
    ];

    const turn2 = ensurePermission({
      requestId: "rt5j",
      origin: "https://episode-forge.example",
      messages: forged,
      tools: weatherTools,
    });
    await waitForPending("rt5j");
    resolveApproval("rt5j", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("still prompts when tools are present but messages are not a continuation", async () => {
    const turn1 = ensurePermission({
      requestId: "rt6a",
      origin: "https://episode-new.example",
      messages: [{ role: "user", content: "Weather?" }],
      tools: weatherTools,
    });
    await waitForPending("rt6a");
    resolveApproval("rt6a", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({ allowed: true });

    const turn2 = ensurePermission({
      requestId: "rt6b",
      origin: "https://episode-new.example",
      messages: [{ role: "user", content: "Different question with tools" }],
      tools: weatherTools,
    });
    await waitForPending("rt6b");
    resolveApproval("rt6b", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts episode follow-ups when compat host permission was revoked", async () => {
    const { saveCompatEndpoints } = await import("../src/storage.js");
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    const contains = vi.fn(async () => true);
    globalThis.chrome.permissions = {
      contains,
      request: vi.fn(async () => true),
    };

    const turn1 = ensurePermission({
      requestId: "rt7a",
      origin: "https://episode-compat.example",
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
      preferredProviderId: "compat:lm",
      preferredModel: "local-model",
    });
    await waitForPending("rt7a");
    resolveApproval("rt7a", {
      decision: "allow_once",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(turn1).resolves.toMatchObject({
      allowed: true,
      once: true,
      providerId: "compat:lm",
    });

    contains.mockResolvedValue(false);

    const turn2 = ensurePermission({
      requestId: "rt7b",
      origin: "https://episode-compat.example",
      messages: weatherFollowUpMessages,
      tools: weatherTools,
    });
    await waitForPending("rt7b");
    expect(getPendingApproval("rt7b")).toMatchObject({
      providerId: "compat:lm",
      model: "local-model",
    });
    resolveApproval("rt7b", {
      decision: "deny",
      providerId: "compat:lm",
      model: "local-model",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts episode follow-ups after Always-allow is revoked", async () => {
    const origin = "https://episode-revoke.example";
    await grantOriginAlways(origin, {
      providerId: "openai",
      model: "gpt-4o-mini",
      toolFingerprint: "fn:get_weather",
    });

    const turn1 = ensurePermission({
      requestId: "rt8a",
      origin,
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    // Always-allow with covering tools skips the prompt and seeds an episode.
    await expect(turn1).resolves.toMatchObject({
      allowed: true,
      once: false,
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    expect(getPendingApproval("rt8a")).toBeNull();

    await revokeOrigin(origin);

    const turn2 = ensurePermission({
      requestId: "rt8b",
      origin,
      messages: weatherFollowUpMessages,
      tools: weatherTools,
    });
    await waitForPending("rt8b");
    resolveApproval("rt8b", {
      decision: "deny",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts episode follow-ups after Always-allow provider/model is updated", async () => {
    const origin = "https://episode-grant-edit.example";
    // Plain Always-allow: tools still prompt, so Allow-once can seed an episode.
    await grantOriginAlways(origin, {
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    const turn1 = ensurePermission({
      requestId: "rt8c",
      origin,
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt8c");
    resolveApproval("rt8c", {
      decision: "allow_once",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    await expect(turn1).resolves.toMatchObject({
      allowed: true,
      once: true,
      providerId: "openai",
      model: "gpt-4o-mini",
    });

    // Options in-place edit must drop the episode seeded under the old binding.
    await expect(
      setOriginProviderModel(origin, {
        providerId: "ollama",
        model: "gemma4",
      })
    ).resolves.toBe(true);

    // Omitting tools must not reuse the stale Allow-once episode (openai), and
    // must not ride plain Always-allow either — re-prompt with the updated grant.
    const turn2 = ensurePermission({
      requestId: "rt8d",
      origin,
      messages: weatherFollowUpMessages,
    });
    await waitForPending("rt8d");
    expect(getPendingApproval("rt8d")).toMatchObject({
      providerId: "ollama",
      model: "gemma4",
    });
    resolveApproval("rt8d", {
      decision: "deny",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(turn2).resolves.toMatchObject({ allowed: false });
  });

  it("re-prompts tools after Options changes Always-allow provider", async () => {
    const origin = "https://tools-grant-edit.example";
    await grantOriginAlways(origin, {
      providerId: "openai",
      model: "gpt-4o-mini",
      toolFingerprint: "fn:get_weather",
    });

    await expect(
      setOriginProviderModel(origin, {
        providerId: "ollama",
        model: "gemma4",
      })
    ).resolves.toBe(true);
    await expect(getOriginGrant(origin)).resolves.toEqual({
      allowedAt: expect.any(Number),
      providerId: "ollama",
      model: "gemma4",
    });

    // Prior tools Always-allow must not cover the new provider binding.
    const pending = ensurePermission({
      requestId: "rt8e",
      origin,
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
    });
    await waitForPending("rt8e");
    expect(getPendingApproval("rt8e")).toMatchObject({
      providerId: "ollama",
      model: "gemma4",
    });
    resolveApproval("rt8e", {
      decision: "deny",
      providerId: "ollama",
      model: "gemma4",
    });
    await expect(pending).resolves.toMatchObject({ allowed: false });
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
