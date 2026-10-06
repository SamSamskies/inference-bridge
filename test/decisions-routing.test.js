import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import request from "./fixtures/system-one-request.json";
import fixture from "./fixtures/system-one-response.json";
import catalog from "./fixtures/openrouter-decisions-models.json";
import openaiFixture from "./fixtures/openai-decisions-response.json";

const origin = "https://app.example";
const cloud = { providerId: "openrouter", model: "typesafe/jev-1.13" };
const openai = { providerId: "openai", model: "gpt-6-luna" };
const local = { providerId: "ollama", model: "nimble:latest" };
const decide = { method: "decide", ...request };
function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}
let mock, ports, storage, permissions;
async function setup(firefox) {
  vi.resetModules();
  mock = installChromeMock();
  if (firefox) mock.setManifest({ browser_specific_settings: { gecko: {} } });
  chrome.runtime.onConnect = event();
  chrome.runtime.onMessage = event();
  chrome.permissions = {
    contains: vi.fn(async () => true),
    onRemoved: event(),
  };
  chrome.windows.onRemoved = event();
  chrome.tabs = { onRemoved: event(), onUpdated: event() };
  chrome.action = { onClicked: event() };
  ports = [];
  storage = await import("../src/storage.js");
  permissions = await import("../src/permissions.js");
  await import("../background/service-worker.js");
  await storage.saveSettings({
    apiKeys: { openrouter: "test-key", openai: "openai-key" },
    operationDefaults: { decide: cloud },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (url.endsWith("?output_modalities=decisions"))
        return Response.json(catalog);
      if (url.endsWith("/api/tags"))
        return Response.json({
          models: [
            "nimble:latest",
            "clef:latest",
            "clef-flash:latest",
            "gemma4:latest",
          ].map((name) => ({ name })),
        });
      if (url.endsWith("/api/show"))
        return Response.json({
          capabilities:
            JSON.parse(options.body).model === "gemma4:latest"
              ? ["completion"]
              : ["decision"],
          details: { format: "gguf" },
        });
      if (url.endsWith("/alpha/decisions"))
        return Response.json({
          ...fixture,
          model:
            JSON.parse(options.body).model === cloud.model
              ? fixture.model
              : JSON.parse(options.body).model,
        });
      if (url.endsWith("/v1/systemone"))
        return Response.json({
          ...fixture,
          model: JSON.parse(options.body).model,
        });
      if (url === "https://api.openai.com/v1/decisions")
        return Response.json(openaiFixture);
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}
afterEach(() => {
  for (const port of ports) port.onDisconnect.emit();
  vi.unstubAllGlobals();
});
function start({ payload = decide, experimental = true } = {}) {
  const port = {
    name: "ipa-inference",
    sender: { tab: { id: 1 } },
    onMessage: event(),
    onDisconnect: event(),
    messages: [],
    postMessage(message) {
      this.messages.push(message);
      if (message.type === "started") {
        this.streamId = message.streamId;
        this.onMessage.emit({ type: "started-ack", streamId: this.streamId });
      }
    },
  };
  ports.push(port);
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: "start",
    origin,
    pageUrl: `${origin}/`,
    experimental,
    request: payload,
  });
  return port;
}
async function outcome(port) {
  await vi.waitFor(() =>
    expect(
      port.messages.some(
        (message) => message.type === "error" || message.chunk?.type === "done"
      )
    ).toBe(true)
  );
}
async function approve(port, route = cloud, decision = "allow_once") {
  await vi.waitFor(() =>
    expect(permissions.getPendingApproval(port.streamId)?.method).toBe("decide")
  );
  permissions.resolveApproval(port.streamId, { decision, ...route });
}
async function message(payload) {
  return new Promise((resolve) =>
    chrome.runtime.onMessage.emit(payload, {}, resolve)
  );
}

describe.each([false, true])("decisions routing (Firefox: %s)", (firefox) => {
  beforeEach(() => setup(firefox));
  it.each([false, true])(
    "offers decisions with speech enabled: %s",
    async (enabled) => {
      await storage.saveSettings({ experimentalSpeechEnabled: enabled });
      const port = start();
      await approve(port);
      await outcome(port);
      expect(port.messages.at(-1).chunk.type).toBe("done");
    }
  );
  it("keeps the stable API chat-only", async () => {
    const stable = start({ experimental: false });
    await outcome(stable);
    expect(stable.messages[0].error.code).toBe("invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates unknown fields before approval or networking", async () => {
    const port = start({ payload: { ...decide, provider: "openrouter" } });
    await outcome(port);
    expect(port.messages[0].error).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("provider"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not let chat Always-allow cover decisions and previews bounded state with question ids/types", async () => {
    await storage.grantOriginAlways(origin, cloud);
    const port = start({ payload: { ...decide, state: "x".repeat(2000) } });
    await vi.waitFor(() =>
      expect(permissions.getPendingApproval(port.streamId)).not.toBeNull()
    );
    const approval = permissions.getPendingApproval(port.streamId);
    expect(approval).toMatchObject({
      method: "decide",
      ...cloud,
      stateSummary: `${"x".repeat(1200)}…`,
      questionSummaries: [
        { id: "is_bug", type: "noul" },
        { id: "team", type: "choice" },
        { id: "urgency", type: "score" },
      ],
    });
    expect(approval).not.toHaveProperty("state");
    expect(approval).not.toHaveProperty("messages");
    expect(fetch).not.toHaveBeenCalled();
    await approve(port);
    await outcome(port);
    const chunks = port.messages
      .filter((item) => item.type === "chunk")
      .map((item) => item.chunk);
    expect(chunks).toEqual([
      { type: "accepted" },
      {
        type: "done",
        model: fixture.model,
        answers: fixture.answers,
        usage: { inputTokens: 476, outputTokens: 70 },
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/models?output_modalities=decisions",
      "https://openrouter.ai/api/alpha/decisions",
    ]);
  });
  it("persists and revokes decide independently of chat and speech", async () => {
    await storage.grantOriginAlways(origin, cloud);
    await storage.grantOriginOperationAlways(origin, "transcribe", {
      providerId: "openai",
      model: "gpt-4o-mini-transcribe",
    });
    const first = start();
    await approve(first, cloud, "always");
    await outcome(first);
    expect(
      await storage.getOriginOperationGrant(origin, "decide")
    ).toMatchObject(cloud);
    const second = start();
    await outcome(second);
    expect(permissions.getPendingApproval(second.streamId)).toBeNull();
    await storage.revokeOriginOperation(origin, "decide");
    expect(await storage.getOriginOperationGrant(origin, "decide")).toBeNull();
    expect(await storage.getOriginGrant(origin)).not.toBeNull();
    expect(
      await storage.getOriginOperationGrant(origin, "transcribe")
    ).not.toBeNull();
  });
  it.each(["nimble:latest", "clef:latest", "clef-flash:latest"])(
    "routes installed %s to local System One",
    async (model) => {
      const route = { ...local, model };
      await storage.saveSettings({ operationDefaults: { decide: route } });
      await storage.grantOriginOperationAlways(origin, "decide", route);
      const port = start();
      await outcome(port);
      expect(
        port.messages
          .filter((item) => item.chunk)
          .map((item) => item.chunk.type)
      ).toEqual(["accepted", "done"]);
      expect(port.messages.at(-1).chunk).toMatchObject({
        answers: fixture.answers,
        model,
      });
      expect(fetch.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
      expect(fetch.mock.calls.at(-1)[0]).toBe(
        "http://localhost:11434/v1/systemone"
      );
      expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).model).toBe(model);
    }
  );
  it.each([
    "liquid/d1",
    "inception/mercury-decide:free",
    "~typesafe/jev-latest",
  ])("routes catalog model %s through OpenRouter decisions", async (model) => {
    await storage.grantOriginOperationAlways(origin, "decide", {
      ...cloud,
      model,
    });
    const port = start();
    await outcome(port);
    expect(port.messages.at(-1).chunk).toMatchObject({
      type: "done",
      model,
      answers: fixture.answers,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/models?output_modalities=decisions",
      "https://openrouter.ai/api/alpha/decisions",
    ]);
  });
  it("fails closed on an empty or stale installed catalog", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", local);
    fetch.mockResolvedValue(Response.json({ models: [] }));
    const port = start();
    await outcome(port);
    expect(port.messages.at(-1).error).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("ollama pull nimble"),
    });
    expect(port.messages.some((item) => item.chunk)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["anthropic", "on-device", "compat:unsupported"])(
    "rejects a saved unsupported provider %s",
    async (providerId) => {
      if (providerId.startsWith("compat:"))
        await storage.saveCompatEndpoints([
          {
            id: providerId,
            name: "Test server",
            baseUrl: "https://server.example",
          },
        ]);
      await storage.grantOriginOperationAlways(origin, "decide", {
        providerId,
        model: "chat-model",
      });
      const port = start();
      await outcome(port);
      expect(port.messages.at(-1).error.code).toBe("unavailable");
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it("rejects an unknown cloud decision slug and a missing key", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", {
      ...cloud,
      model: "openrouter/auto",
    });
    const port = start();
    await outcome(port);
    expect(port.messages.at(-1).error.code).toBe("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await storage.grantOriginOperationAlways(origin, "decide", cloud);
    await storage.saveSettings({ apiKeys: { openrouter: "" } });
    const noKey = start();
    await outcome(noKey);
    expect(noKey.messages.at(-1).error.code).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the current API key after approval", async () => {
    const port = start();
    await vi.waitFor(() =>
      expect(permissions.getPendingApproval(port.streamId)?.method).toBe(
        "decide"
      )
    );
    await storage.saveSettings({ apiKeys: { openrouter: "" } });
    await approve(port);
    await outcome(port);
    expect(port.messages.at(-1).error.code).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when an unsupported provider is saved as the default", async () => {
    await storage.saveSettings({
      operationDefaults: {
        decide: { providerId: "anthropic", model: "chat-model" },
      },
    });
    const port = start();
    await outcome(port);
    expect(port.messages[0].error.code).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  if (firefox) {
    it("checks Firefox host access before acceptance", async () => {
      await storage.grantOriginOperationAlways(origin, "decide", cloud);
      chrome.permissions.contains.mockResolvedValue(false);
      const port = start();
      await outcome(port);
      expect(port.messages.at(-1).error).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("Host access"),
      });
      expect(port.messages.some((item) => item.chunk)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  }
  it("cancels approval without contacting a provider", async () => {
    const port = start();
    await vi.waitFor(() =>
      expect(permissions.getPendingApproval(port.streamId)?.method).toBe(
        "decide"
      )
    );
    port.onMessage.emit({ type: "abort", streamId: port.streamId });
    await outcome(port);
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
    expect(port.messages.at(-1).error.code).toBe("aborted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts the active fetch without sending a done chunk", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", cloud);
    fetch.mockImplementation((url, { signal }) =>
      url.endsWith("?output_modalities=decisions")
        ? Promise.resolve(Response.json(catalog))
        : new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
    );
    const port = start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const signal = fetch.mock.calls[1][1].signal;
    port.onMessage.emit({ type: "abort", streamId: port.streamId });
    await outcome(port);
    expect(signal.aborted).toBe(true);
    expect(port.messages.at(-1).error.code).toBe("aborted");
    expect(port.messages.some((item) => item.chunk?.type === "done")).toBe(
      false
    );
  });
  it("lists only decisions providers and catalogs for the UI", async () => {
    const providers = await message({
      type: "list-providers",
      method: "decide",
    });
    expect(
      providers.providers.map((provider) => [
        provider.id,
        provider.defaultModel,
      ])
    ).toEqual([
      ["openai", "gpt-6-luna"],
      ["openrouter", cloud.model],
      ["ollama", "nimble"],
    ]);
    const models = await message({
      type: "list-models",
      method: "decide",
      providerId: "openrouter",
    });
    expect(models.models.map((model) => model.id)).toEqual(
      catalog.data.map((model) => model.id).sort((a, b) => a.localeCompare(b))
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://openrouter.ai/api/v1/models?output_modalities=decisions",
      { signal: undefined }
    );
  });
  it("routes approved OpenAI decisions with the saved key and separate grants", async () => {
    await storage.saveSettings({ operationDefaults: { decide: openai } });
    await storage.grantOriginAlways(origin, openai);
    const port = start();
    await approve(port, openai, "always");
    await outcome(port);
    expect(port.messages.filter((item) => item.chunk).map((item) => item.chunk.type))
      .toEqual(["accepted", "done"]);
    expect(port.messages.at(-1).chunk).toEqual({
      type: "done", model: "gpt-6-luna", answers: fixture.answers,
      usage: { inputTokens: 476, outputTokens: 0 },
    });
    expect(await storage.getOriginOperationGrant(origin, "decide")).toMatchObject(openai);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.openai.com/v1/decisions", expect.objectContaining({
      headers: { "Content-Type": "application/json", Authorization: "Bearer openai-key" },
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body).input).toBe(JSON.stringify(request.state));
  });
  it("keeps OpenRouter as the initial decisions default", async () => {
    await storage.saveSettings({ operationDefaults: { decide: null } });
    const port = start();
    await vi.waitFor(() => expect(permissions.getPendingApproval(port.streamId)?.method).toBe("decide"));
    expect(permissions.getPendingApproval(port.streamId)).toMatchObject({
      providerId: "openrouter", model: cloud.model,
    });
  });
  it("lists the OpenAI Decisions model independently of chat", async () => {
    expect(await message({ type: "list-models", method: "decide", providerId: "openai" }))
      .toMatchObject({ ok: true, models: [{ id: "gpt-6-luna" }] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects stale OpenAI models and keys before contacting the provider", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", { ...openai, model: "gpt-6-astra" });
    const stale = start();
    await outcome(stale);
    expect(stale.messages.at(-1).error).toMatchObject({
      code: "unavailable", message: expect.stringContaining("OpenAI Decisions catalog"),
    });
    await storage.grantOriginOperationAlways(origin, "decide", openai);
    await storage.saveSettings({ apiKeys: { openai: "" } });
    const noKey = start();
    await outcome(noKey);
    expect(noKey.messages.at(-1).error.code).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the current OpenAI key after approval", async () => {
    await storage.saveSettings({ operationDefaults: { decide: openai } });
    const port = start();
    await vi.waitFor(() => expect(permissions.getPendingApproval(port.streamId)?.method).toBe("decide"));
    await storage.saveSettings({ apiKeys: { openai: "" } });
    await approve(port, openai);
    await outcome(port);
    expect(port.messages.at(-1).error.code).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns individual OpenAI refusals in the done chunk", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", openai);
    const body = structuredClone(openaiFixture);
    body.answers[0] = { type: "refusal", name: "is_bug" };
    fetch.mockResolvedValue(Response.json(body));
    const port = start();
    await outcome(port);
    expect(port.messages.at(-1).chunk).toMatchObject({
      type: "done", answers: { ...fixture.answers, is_bug: { type: "refusal" } },
    });
  });
  it("aborts the OpenAI fetch without a done chunk", async () => {
    await storage.grantOriginOperationAlways(origin, "decide", openai);
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const port = start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = fetch.mock.calls[0][1].signal;
    port.onMessage.emit({ type: "abort", streamId: port.streamId });
    await outcome(port);
    expect(signal.aborted).toBe(true);
    expect(port.messages.at(-1).error.code).toBe("aborted");
    expect(port.messages.some((item) => item.chunk?.type === "done")).toBe(false);
  });
  if (firefox) {
    it("checks OpenAI host access before sending decisions", async () => {
      await storage.grantOriginOperationAlways(origin, "decide", openai);
      chrome.permissions.contains.mockResolvedValue(false);
      const port = start();
      await outcome(port);
      expect(port.messages.at(-1).error.code).toBe("unavailable");
      expect(fetch).not.toHaveBeenCalled();
    });
  }
});
