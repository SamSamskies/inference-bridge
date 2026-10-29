import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";

vi.mock("../src/prompt-api-client.js", () => ({
  getOnDeviceAvailability: vi.fn(async () => "available"),
  streamOnDeviceChat: vi.fn(async () => ({
    model: "on-device", message: { role: "assistant", content: "ok" },
  })),
  installOnDeviceModel: vi.fn(),
  cancelOnDeviceInstall: vi.fn(),
}));

const origin = "https://app.example";
const route = { providerId: "openai", model: "gpt-5-nano" };
const chat = { method: "chat", messages: [{ role: "user", content: "Hi" }] };
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
  chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
  chrome.windows.onRemoved = event();
  chrome.tabs = { onRemoved: event(), onUpdated: event() };
  chrome.action = { onClicked: event() };
  ports = [];
  storage = await import("../src/storage.js");
  permissions = await import("../src/permissions.js");
  await import("../background/service-worker.js");
  await storage.saveSettings({
    apiKeys: { openai: "test-key" },
    defaultProviderId: route.providerId,
    defaultModel: route.model,
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { headers: { "Content-Type": "text/event-stream" } }
  )));
}
function start(options, experimental = false) {
  const port = {
    name: "ipa-inference",
    sender: { tab: { id: 1 } },
    onMessage: event(), onDisconnect: event(), messages: [],
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
    type: "start", origin, pageUrl: `${origin}/`, experimental,
    request: { ...chat, ...(options ? { options } : {}) },
  });
  return port;
}
async function outcome(port) {
  await vi.waitFor(() => expect(port.messages.some(
    (m) => m.type === "error" || m.chunk?.type === "done"
  )).toBe(true));
  expect(port.messages.at(-1)).toMatchObject({ chunk: { type: "done" } });
}
async function pending(port) {
  await vi.waitFor(() => expect(
    permissions.getPendingApproval(port.streamId)
  ).not.toBeNull());
}
function body() {
  return JSON.parse(fetch.mock.calls.at(-1)[1].body);
}
afterEach(() => {
  for (const port of ports) port.onDisconnect.emit();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([false, true])("chat effort routing (Firefox: %s)", (firefox) => {
  beforeEach(() => setup(firefox));

  it.each([undefined, "auto", "low"])(
    "preserves page/provider defaults (%s) for existing grants",
    async (reasoningEffort) => {
      await storage.grantOriginAlways(origin, route);
      const port = start(reasoningEffort ? { reasoningEffort } : undefined);
      await outcome(port);
      expect(body().reasoning_effort).toBe(reasoningEffort === "low" ? "low" : undefined);
      expect(permissions.getPendingApproval(port.streamId)).toBeNull();
    }
  );

  it.each([
    ["auto", undefined], ["none", "minimal"], ["low", "low"],
    ["medium", "medium"], ["high", "high"],
  ])("maps the user's %s override through the adapter", async (effort, expected) => {
    await storage.grantOriginAlways(origin, route);
    const before = (await storage.getSettings()).allowedOrigins;
    await storage.saveSettings({ chatReasoningEffort: effort });
    const port = start({ reasoningEffort: effort === "high" ? "none" : "high", temperature: 0.2 });
    await outcome(port);
    expect(body().reasoning_effort).toBe(expected);
    expect(body().temperature).toBe(0.2);
    expect((await storage.getSettings()).allowedOrigins).toEqual(before);
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
  });

  it.each([false, true])("overrides omitted options (experimental: %s)", async (experimental) => {
    await storage.grantOriginAlways(origin, route);
    await storage.saveSettings({ chatReasoningEffort: "high" });
    await outcome(start(undefined, experimental));
    expect(body().reasoning_effort).toBe("high");
  });

  it("reads settings changed during approval and applies them to later granted requests", async () => {
    const port = start({ reasoningEffort: "high" });
    await pending(port);
    expect(fetch).not.toHaveBeenCalled();
    await storage.saveSettings({ chatReasoningEffort: "low" });
    permissions.resolveApproval(port.streamId, { decision: "always", ...route });
    await outcome(port);
    expect(body().reasoning_effort).toBe("low");
    const before = (await storage.getSettings()).allowedOrigins;
    await storage.saveSettings({ chatReasoningEffort: "page" });
    await outcome(start({ reasoningEffort: "high" }));
    expect(body().reasoning_effort).toBe("high");
    expect((await storage.getSettings()).allowedOrigins).toEqual(before);
  });

  it("continues to require permission for a new site and honors Deny", async () => {
    await storage.saveSettings({ chatReasoningEffort: "high" });
    const port = start();
    await pending(port);
    expect(fetch).not.toHaveBeenCalled();
    permissions.resolveApproval(port.streamId, { decision: "deny", ...route });
    await vi.waitFor(() => expect(port.messages.at(-1).error?.code).toBe("permission_denied"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates page effort even when the user overrides it", async () => {
    await storage.saveSettings({ chatReasoningEffort: "low" });
    const port = start({ reasoningEffort: "extreme" });
    await vi.waitFor(() => expect(port.messages.at(-1).error?.code).toBe("invalid_request"));
    expect(fetch).not.toHaveBeenCalled();
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
  });

  it("uses the existing fallback when a model rejects effort", async () => {
    await storage.grantOriginAlways(origin, route);
    await storage.saveSettings({ chatReasoningEffort: "high" });
    fetch.mockResolvedValueOnce(Response.json({ error: {
      message: "reasoning_effort is not supported",
    } }, { status: 400 }));
    await outcome(start({ reasoningEffort: "low" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning_effort).toBe("high");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body()).not.toHaveProperty("reasoning_effort");
  });

  it("omits none for a known non-reasoning model", async () => {
    await storage.grantOriginAlways(origin, { ...route, model: "gpt-4o-mini" });
    await storage.saveSettings({ chatReasoningEffort: "none" });
    await outcome(start({ reasoningEffort: "high" }));
    expect(body()).not.toHaveProperty("reasoning_effort");
  });

  it.skipIf(firefox)("allows an override with a provider that ignores effort", async () => {
    await storage.grantOriginAlways(origin, { providerId: "on-device", model: "on-device" });
    await storage.saveSettings({ chatReasoningEffort: "high" });
    await outcome(start({ reasoningEffort: "none" }));
    const { streamOnDeviceChat } = await import("../src/prompt-api-client.js");
    expect(streamOnDeviceChat).toHaveBeenCalledWith(expect.objectContaining({ messages: chat.messages }));
    expect(streamOnDeviceChat.mock.calls.at(-1)[0]).not.toHaveProperty("options");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the effective options for provider preflight as well as streaming", async () => {
    const { openaiProvider } = await import("../src/providers/openai.js");
    const preflight = vi.fn();
    openaiProvider.preflightChat = preflight;
    try {
      await storage.grantOriginAlways(origin, route);
      await storage.saveSettings({ chatReasoningEffort: "medium" });
      await outcome(start({ reasoningEffort: "none", temperature: 0.3 }));
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
        options: { reasoningEffort: "medium", temperature: 0.3 },
      }));
      expect(body().reasoning_effort).toBe("medium");
    } finally {
      delete openaiProvider.preflightChat;
    }
  });
});
