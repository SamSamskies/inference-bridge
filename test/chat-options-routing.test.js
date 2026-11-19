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
async function setup(firefox, safari = false) {
  vi.resetModules();
  mock = installChromeMock();
  if (firefox) mock.setManifest({ browser_specific_settings: { gecko: {} } });
  if (safari) mock.setManifest({ browser_specific_settings: { safari: {} } });
  // Exercise real request/approval routing with the supported Chrome API, and
  // the unsupported Firefox path. This mock does not emulate browser isolation.
  if (!firefox) chrome.storage.local.setAccessLevel = vi.fn(async () => {});
  chrome.runtime.onConnect = event();
  chrome.runtime.onMessage = event();
  chrome.runtime.onInstalled = event();
  chrome.contextMenus = { removeAll: vi.fn(async () => {}), create: vi.fn(), onClicked: event() };
  chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
  chrome.windows.onRemoved = event();
  chrome.tabs = {
    onRemoved: event(),
    onUpdated: event(),
    remove: vi.fn(async () => {}),
  };
  if (safari) {
    delete chrome.windows.create;
    chrome.tabs.create = vi.fn(async () => ({ id: 201 }));
    chrome.tabs.get = vi.fn(async (id) => ({ id }));
  }
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
function start(options, experimental = false, requestOrigin = origin) {
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
    type: "start", origin: requestOrigin, pageUrl: `${requestOrigin}/`, experimental,
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
function editPreference(chatReasoningEffort, {
  requestOrigin = origin,
  senderUrl = `${chrome.runtime.getURL("ui/options.html")}#site-access`,
} = {}) {
  return new Promise((resolve) => chrome.runtime.onMessage.emit({
    type: "set-origin-chat-reasoning-effort", origin: requestOrigin, chatReasoningEffort,
  }, { url: senderUrl }, resolve));
}
function sendApprovalMessage(
  port,
  message,
  senderUrl = permissions.approvalPageUrl(port.streamId),
  tabId = 201,
) {
  return new Promise((resolve) => chrome.runtime.onMessage.emit({
    requestId: port.streamId, ...message,
  }, {
    url: senderUrl,
    ...(typeof tabId === "number" ? { tab: { id: tabId } } : {}),
  }, resolve));
}
afterEach(() => {
  for (const port of ports) port.onDisconnect.emit();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Safari website approval", () => {
  beforeEach(() => setup(false, true));

  it("opens a tab and sends only an explicitly approved provider and model", async () => {
    await storage.saveSettings({ apiKeys: { openai: "test-key", openrouter: "router-test-key" } });
    const port = start();
    await pending(port);
    const url = permissions.approvalPageUrl(port.streamId);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url, active: true, openerTabId: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await sendApprovalMessage(port, { type: "get-approval" }, origin))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(port, { type: "get-approval" }))
      .toMatchObject({ request: { origin, ...route } });
    const approval = {
      type: "resolve-approval", decision: "allow_once",
      providerId: "openrouter", model: "openrouter/auto",
    };
    expect(await sendApprovalMessage(port, approval, origin)).toEqual({ ok: false });
    expect(await sendApprovalMessage(port, approval, permissions.approvalPageUrl("other")))
      .toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(port, approval)).toEqual({ ok: true });
    await outcome(port);
    expect(fetch.mock.calls.at(-1)[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body().model).toBe("openrouter/auto");
    expect((await storage.getSettings()).allowedOrigins).toEqual({});

    const next = start();
    await pending(next);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(await sendApprovalMessage(next, { type: "resolve-approval", decision: "deny" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(next.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("closes the approval tab from the worker after a Deny", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.remove.mockClear();
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "deny" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledWith(201));
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["allow_once", "always", "never"])("keeps the approval tab open when a failed %s cannot be saved", async (decision) => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.remove.mockClear();
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("Storage full"));
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision, ...route,
    })).toEqual({ ok: false, error: expect.stringContaining("Storage may be full or unavailable") });
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe("error"));
    // Give the deferred close a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(201);
    expect(fetch).not.toHaveBeenCalled();
    const settings = await storage.getSettings();
    expect(settings.allowedOrigins).toEqual({});
    expect(settings.blockedOrigins).toEqual({});
  });

  it("closes the approval tab from the worker after a successful Allow", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.remove.mockClear();
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    })).toEqual({ ok: true });
    // Worker defers tabs.remove so sendResponse can complete first.
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledWith(201));
    await outcome(port);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("denies when the approval tab closes without a decision", async () => {
    const port = start();
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.onRemoved.emit(201);
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies when the approval tab closes before tabId is bound", async () => {
    let opened;
    chrome.tabs.create.mockReturnValueOnce(new Promise((resolve) => { opened = resolve; }));
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
    // onRemoved before entry.tabId is set cannot match the pending entry.
    chrome.tabs.onRemoved.emit(201);
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    expect(port.messages.some((m) => m.type === "error")).toBe(false);

    chrome.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 201."));
    opened({ id: 201 });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies when the approval tab navigates away without a decision", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    const approvalUrl = permissions.approvalPageUrl(port.streamId);
    chrome.tabs.onUpdated.emit(201, { url: approvalUrl, status: "loading" });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    chrome.tabs.onUpdated.emit(201, { url: "https://example.com/", status: "loading" });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(201);
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies navigate-away when WebKit omits changeInfo.url", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.get.mockClear();
    chrome.tabs.get.mockResolvedValueOnce({ id: 201, url: "about:blank" });
    chrome.tabs.onUpdated.emit(201, { status: "loading" });
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();

    chrome.tabs.get.mockResolvedValueOnce({ id: 201, url: "https://example.com/" });
    chrome.tabs.onUpdated.emit(201, { status: "loading" });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(201);
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies navigate-away when WebKit only reports complete without a url", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    chrome.tabs.get.mockClear();
    chrome.tabs.get.mockResolvedValueOnce({
      id: 201,
      url: permissions.approvalPageUrl(port.streamId),
    });
    chrome.tabs.onUpdated.emit(201, { status: "complete" });
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();

    chrome.tabs.get.mockResolvedValueOnce({ id: 201, url: "https://example.com/" });
    chrome.tabs.onUpdated.emit(201, { status: "complete" });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(201);
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the pending approval across approval-tab reload and interim same-document URLs", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    const approvalUrl = permissions.approvalPageUrl(port.streamId);
    // chrome-extension origins are opaque in Node; strip the query in place.
    const withoutQuery = approvalUrl.replace(/\?.*$/, "");
    chrome.tabs.onUpdated.emit(201, { url: withoutQuery, status: "loading" });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    chrome.tabs.onUpdated.emit(201, { url: approvalUrl, status: "loading" });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    // Stale/wrong ?requestId= on the approval path must not false-deny.
    const wrongQuery = permissions.approvalPageUrl("stream_other");
    chrome.tabs.onUpdated.emit(201, { url: wrongQuery, status: "loading" });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    })).toEqual({ ok: true });
    await outcome(port);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("trusts get-approval and resolve-approval from an interim approval document URL", async () => {
    const port = start();
    await pending(port);
    const approvalUrl = permissions.approvalPageUrl(port.streamId);
    const withoutQuery = approvalUrl.replace(/\?.*$/, "");
    expect(await sendApprovalMessage(port, { type: "get-approval" }, withoutQuery))
      .toMatchObject({ request: { origin, ...route } });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, withoutQuery)).toEqual({ ok: true });
    await outcome(port);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("trusts approval catalog reads from an interim URL only on the bound tab", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    const interim = permissions.approvalPageUrl(port.streamId).replace(/\?.*$/, "");
    expect(permissions.isTrustedApprovalCatalogSender({ url: interim, tab: { id: 201 } })).toBe(true);
    expect(permissions.isTrustedApprovalCatalogSender({ url: interim, tab: { id: 999 } })).toBe(false);
    expect(permissions.isTrustedApprovalCatalogSender({ url: interim })).toBe(false);
    const list = (tabId) => new Promise((resolve) => chrome.runtime.onMessage.emit(
      { type: "list-providers" },
      { id: chrome.runtime.id, url: interim, tab: { id: tabId } },
      resolve,
    ));
    await vi.waitFor(async () => {
      expect(await list(201)).toMatchObject({ providers: expect.any(Array) });
      expect((await list(201)).providers.length).toBeGreaterThan(0);
    });
    expect(await list(999)).toEqual({ providers: [] });
  });

  it("isolates concurrent Safari approvals when sender URLs omit requestId", async () => {
    chrome.tabs.create
      .mockResolvedValueOnce({ id: 201 })
      .mockResolvedValueOnce({ id: 202 });
    const first = start();
    const second = start();
    await pending(first);
    await pending(second);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(202));
    const interim = permissions.approvalPageUrl(first.streamId).replace(/\?.*$/, "");
    expect(await sendApprovalMessage(second, { type: "get-approval" }, interim, 201))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(second, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: false });
    expect(permissions.getPendingApproval(second.streamId)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(second, {
      type: "resolve-approval", decision: "deny",
    }, permissions.approvalPageUrl(second.streamId), 202)).toEqual({ ok: true });
    await vi.waitFor(() => expect(second.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(await sendApprovalMessage(first, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: true });
    await outcome(first);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects approval catalog reads from a foreign tabId", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    const url = permissions.approvalPageUrl(port.streamId);
    expect(permissions.isTrustedApprovalCatalogSender({ url, tab: { id: 201 } })).toBe(true);
    expect(permissions.isTrustedApprovalCatalogSender({ url, tab: { id: 999 } })).toBe(false);
    expect(permissions.isTrustedApprovalCatalogSender({ url })).toBe(false);
    const list = (tabId) => new Promise((resolve) => chrome.runtime.onMessage.emit(
      { type: "list-providers" },
      { id: chrome.runtime.id, url, tab: { id: tabId } },
      resolve,
    ));
    await vi.waitFor(async () => {
      expect(await list(201)).toMatchObject({ providers: expect.any(Array) });
      expect((await list(201)).providers.length).toBeGreaterThan(0);
    });
    expect(await list(999)).toEqual({ providers: [] });
  });

  it("rejects get and resolve until the Safari approval tabId is bound", async () => {
    let opened;
    chrome.tabs.create.mockReturnValueOnce(new Promise((resolve) => { opened = resolve; }));
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
    const approvalUrl = permissions.approvalPageUrl(port.streamId);
    const interim = approvalUrl.replace(/\?.*$/, "");
    expect(await sendApprovalMessage(port, { type: "get-approval" }, interim, 201))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: false });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();

    opened({ id: 201 });
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    expect(await sendApprovalMessage(port, { type: "get-approval" }, interim, 201))
      .toMatchObject({ request: { origin, ...route } });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: true });
    await outcome(port);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("closes the approval tab if it opens after the originating tab navigated", async () => {
    let opened;
    chrome.tabs.create.mockReturnValueOnce(new Promise((resolve) => { opened = resolve; }));
    const port = start();
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
    chrome.tabs.onUpdated.emit(1, { status: "loading" });
    opened({ id: 202 });
    await vi.waitFor(() => expect(chrome.tabs.remove).toHaveBeenCalledWith(202));
    expect(port.messages.at(-1)?.error?.code).toBe("aborted");
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("expires a pending approval and rejects a late decision", async () => {
    vi.useFakeTimers();
    const port = start();
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledWith(201));
    await vi.advanceTimersByTimeAsync(permissions.SAFARI_APPROVAL_TIMEOUT_MS);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(201);
    expect(port.messages.at(-1)?.error?.code).toBe("permission_denied");
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "always", ...route }))
      .toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
    expect((await storage.getSettings()).allowedOrigins).toEqual({});
  });

  it("abandons an approved request if the originating tab fails to reconnect", async () => {
    vi.useFakeTimers();
    const port = start();
    await pending(port);
    port.onDisconnect.emit();
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "allow_once", ...route }))
      .toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(port.messages.at(-1)?.error).toMatchObject({
      code: "aborted",
      message: expect.stringContaining("did not reconnect"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports permission_denied when deny arrives after soft-disconnect without rebind", async () => {
    vi.useFakeTimers();
    const port = start();
    await pending(port);
    port.onDisconnect.emit();
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "deny" }))
      .toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(port.messages.at(-1)?.error?.code).toBe("permission_denied");
    expect(JSON.stringify(port.messages)).not.toContain("did not reconnect");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an actionable error when Safari cannot open the approval tab", async () => {
    chrome.tabs.create.mockRejectedValueOnce(new Error("Browser API error"));
    const port = start();
    await vi.waitFor(() => expect(port.messages.at(-1)?.error).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Could not open the Safari approval tab"),
    }));
    expect(await sendApprovalMessage(port, { type: "get-approval" })).toEqual({ request: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each([false, true])("chat effort routing (Firefox: %s)", (firefox) => {
  beforeEach(() => setup(firefox));

  it("clears old toolbar menus on install/update and adds Open Chat only in Firefox", async () => {
    chrome.runtime.onInstalled.emit({ reason: "update" });
    await vi.waitFor(() => expect(chrome.contextMenus.removeAll).toHaveBeenCalledOnce());
    // Menu creation must follow cleanup, including when upgrading a Chrome build
    // that had the duplicate Open Chat entry stored by the browser.
    await Promise.resolve();
    if (firefox) expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: "open-chat", title: "Open Chat", contexts: ["action"] });
    else expect(chrome.contextMenus.create).not.toHaveBeenCalled();
  });

  it("routes approved cloud chat with its own key and remembers it independently of local defaults", async () => {
    const cloudRoute = { providerId: "ollama-cloud", model: "gpt-oss:120b" };
    await storage.saveSettings({ apiKeys: { "ollama-cloud": "cloud-key", ollama: "local-search-key" }, defaultModels: { "ollama-cloud": cloudRoute.model } });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      expect(url.startsWith("https://ollama.com/")).toBe(true);
      return url.endsWith("/api/show") ? Response.json({ capabilities: ["completion"] })
        : new Response('{"model":"gpt-oss:120b","message":{"role":"assistant","content":"Cloud reply"},"done":true}\n');
    }));
    const port = start();
    await pending(port);
    await permissions.resolveApproval(port.streamId, { decision: "always", ...cloudRoute });
    await outcome(port);
    expect((await storage.getSettings()).allowedOrigins[origin]).toMatchObject(cloudRoute);
    expect((await storage.getSettings()).originLastUsed[origin]).toMatchObject(cloudRoute);
    expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe("Bearer cloud-key");
    await storage.saveSettings({ defaultProviderId: "ollama", defaultModel: "local-model" });
    await outcome(start());
    expect(fetch.mock.calls.every(([url]) => url.startsWith("https://ollama.com/"))).toBe(true);
    expect(JSON.stringify(port.messages)).not.toContain("cloud-key");
  });

  it("keeps an existing local grant local after the global default changes to cloud", async () => {
    const localRoute = { providerId: "ollama", model: "gpt-oss:120b" };
    await storage.grantOriginAlways(origin, localRoute);
    await storage.saveSettings({ defaultProviderId: "ollama-cloud", defaultModel: "gpt-oss:120b", apiKeys: { "ollama-cloud": "cloud-key" } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Local daemon stopped"); }));
    const port = start();
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("unavailable"));
    expect(fetch.mock.calls.every(([url]) => url.startsWith("http://localhost:11434/"))).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => !init.headers?.Authorization)).toBe(true);
    expect((await storage.getSettings()).allowedOrigins[origin]).toMatchObject(localRoute);
  });

  it.each([
    ["ppq", "claude-sonnet-5.5", "gpt-6.1-terra", "auto"],
    ["ollama-cloud", "beam", "gpt-oss:120b", "deepseek-v4.1-flash:1017"],
  ])("uses the saved %s chat model before the factory default when approval switches providers", async (providerId, savedModel, nextModel, factoryDefault) => {
    const list = (method = "chat") => new Promise((resolve) => chrome.runtime.onMessage.emit(
      { type: "list-providers", method },
      { id: chrome.runtime.id, url: chrome.runtime.getURL("ui/options.html") }, resolve
    ));
    // This is not the global provider: a switch must still use its own saved model.
    await storage.saveSettings({
      defaultModels: { [providerId]: savedModel },
      apiKeys: { [providerId]: "private-provider-test-key" },
    });
    let response = await list();
    expect(response.providers.find((provider) => provider.id === providerId)).toMatchObject({
      defaultModel: savedModel, hasApiKey: true,
    });
    expect(response.providers.find((provider) => provider.id === "openai").defaultModel).toBe(route.model);
    expect(JSON.stringify(response)).not.toContain("private-provider-test-key");
    await storage.saveSettings({ defaultModels: { [providerId]: nextModel } });
    response = await list();
    expect(response.providers.find((provider) => provider.id === providerId).defaultModel).toBe(nextModel);
    // Do not mutate the adapter's factory default or expose chat models for other methods.
    const { getProvider } = await import("../src/providers/registry.js");
    expect(getProvider(providerId).defaultModel).toBe(factoryDefault);
    await storage.saveSettings({ defaultModels: { [providerId]: "" } });
    expect((await list()).providers.find((provider) => provider.id === providerId).defaultModel).toBe(factoryDefault);
    expect((await list("decide")).providers.find((provider) => provider.id === "openai").defaultModel).not.toBe(route.model);
  });

  it("edits existing site effort through Options without changing grant scopes or prompting", async () => {
    await storage.grantOriginAlways(origin, {
      ...route, toolFingerprint: "hosted:web_search", imageInput: true, imageOutput: true,
    });
    const before = (await storage.getSettings()).allowedOrigins;
    expect(await editPreference("low")).toEqual({ ok: true });
    const port = start({ reasoningEffort: "high" });
    await outcome(port);
    expect(body().reasoning_effort).toBe("low");
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
    expect((await storage.getSettings()).allowedOrigins).toEqual(before);
    expect(await editPreference("global")).toEqual({ ok: true });
    await outcome(start({ reasoningEffort: "high" }));
    expect(body().reasoning_effort).toBe("high");
    expect((await storage.getSettings()).originChatReasoningEfforts).toEqual({});
  });

  it.each([
    ["page", "global", "none", "low"],
    ["none", "global", "high", "low"],
    ["high", "none", "high", "low"],
    ["none", "page", "medium", "medium"],
    ["auto", "global", "none", undefined],
    ["none", "auto", "none", undefined],
  ])("maps Ollama metadata after page/global/site resolution (%s, %s, %s)", async (global, site, page, expected) => {
    const ollamaRoute = { providerId: "ollama", model: "beam:cloud" };
    await storage.grantOriginAlways(origin, { ...ollamaRoute, imageInput: true, imageOutput: true });
    await storage.saveSettings({ chatReasoningEffort: global });
    if (site !== "global") await storage.setOriginChatReasoningEffort(origin, site);
    const grants = (await storage.getSettings()).allowedOrigins;
    vi.stubGlobal("fetch", vi.fn(async (url) => url.endsWith("/api/show")
      ? Response.json({ thinking: { values: ["low", "medium", "high", "xhigh", "max"], default: "max" } })
      : new Response(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n")));
    const port = start({ reasoningEffort: page, temperature: 0.4 });
    await outcome(port);
    expect(body().think).toBe(expected);
    expect(body().model).toBe("beam:cloud");
    expect(body().options.temperature).toBe(0.4);
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
    expect((await storage.getSettings()).allowedOrigins).toEqual(grants);
  });

  it("edits and clears saved preferences without granting access", async () => {
    expect(await editPreference("high")).toEqual({ ok: true });
    expect((await storage.getSettings()).originChatReasoningEfforts[origin]).toBe("high");
    expect((await storage.getSettings()).allowedOrigins).toEqual({});
    expect(await editPreference("global")).toEqual({ ok: true });
    expect((await storage.getSettings()).originChatReasoningEfforts).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["high", "https://app.example", "https://app.example"],
    ["high", "https://app.example", "chrome-extension://test-id/content/inject.js"],
    ["extreme", "https://app.example", "chrome-extension://test-id/ui/options.html"],
    ["high", "null", "chrome-extension://test-id/ui/options.html"],
    [undefined, "https://app.example", "chrome-extension://test-id/ui/options.html"],
  ])("rejects invalid Options edits (%s, %s, %s)", async (preference, requestOrigin, senderUrl) => {
    await storage.setOriginChatReasoningEffort(origin, "low");
    expect(await editPreference(preference, { requestOrigin, senderUrl })).toMatchObject({ ok: false });
    expect((await storage.getSettings()).originChatReasoningEfforts[origin]).toBe("low");
  });

  it("reports preference storage failures without granting access", async () => {
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("Storage full"));
    expect(await editPreference("high")).toEqual({ ok: false, error: expect.stringContaining("Storage may be full or unavailable") });
    expect((await storage.getSettings()).allowedOrigins).toEqual({});
  });

  it.each(["allow_once", "always", "never"])("returns a failed %s through the popup message channel without calling the provider", async (decision) => {
    const port = start();
    await pending(port);
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("Storage full"));
    const response = await sendApprovalMessage(port, {
      type: "resolve-approval", decision,
      ...route, chatReasoningEffort: "high",
    });
    expect(response).toEqual({ ok: false, error: expect.stringContaining("Storage may be full or unavailable") });
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe("error"));
    expect(fetch).not.toHaveBeenCalled();
    const settings = await storage.getSettings();
    expect(settings.allowedOrigins).toEqual({});
    expect(settings.blockedOrigins).toEqual({});
    expect(settings.originLastUsed).toEqual({});
    expect(settings.originChatReasoningEfforts).toEqual({});
  });

  it("rejects approval catalog reads from a foreign popup tabId", async () => {
    const port = start();
    await pending(port);
    await vi.waitFor(async () => {
      expect(await sendApprovalMessage(port, { type: "get-approval" }))
        .toMatchObject({ request: { origin } });
    });
    const url = permissions.approvalPageUrl(port.streamId);
    expect(permissions.isTrustedApprovalCatalogSender({ url, tab: { id: 201 } })).toBe(true);
    expect(permissions.isTrustedApprovalCatalogSender({ url, tab: { id: 999 } })).toBe(false);
    expect(permissions.isTrustedApprovalCatalogSender({ url })).toBe(false);
    const list = (tabId) => new Promise((resolve) => chrome.runtime.onMessage.emit(
      { type: "list-providers" },
      { id: chrome.runtime.id, url, tab: { id: tabId } },
      resolve,
    ));
    await vi.waitFor(async () => {
      expect(await list(201)).toMatchObject({ providers: expect.any(Array) });
      expect((await list(201)).providers.length).toBeGreaterThan(0);
    });
    expect(await list(999)).toEqual({ providers: [] });
  });

  it("isolates concurrent popup approvals when sender URLs omit requestId", async () => {
    let windowSeq = 0;
    chrome.windows.create = (opts, cb) => {
      windowSeq += 1;
      const id = 1000 + windowSeq;
      const tabId = 200 + windowSeq;
      queueMicrotask(() => cb?.({ id, tabs: [{ id: tabId }] }));
    };
    const first = start();
    const second = start();
    await pending(first);
    await pending(second);
    await vi.waitFor(async () => {
      expect(await sendApprovalMessage(first, { type: "get-approval" }, permissions.approvalPageUrl(first.streamId), 201))
        .toMatchObject({ request: { origin } });
      expect(await sendApprovalMessage(second, { type: "get-approval" }, permissions.approvalPageUrl(second.streamId), 202))
        .toMatchObject({ request: { origin } });
    });
    const interim = permissions.approvalPageUrl(first.streamId).replace(/\?.*$/, "");
    expect(await sendApprovalMessage(second, { type: "get-approval" }, interim, 201))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(second, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: false });
    expect(permissions.getPendingApproval(second.streamId)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(second, {
      type: "resolve-approval", decision: "deny",
    }, permissions.approvalPageUrl(second.streamId), 202)).toEqual({ ok: true });
    await vi.waitFor(() => expect(second.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(await sendApprovalMessage(first, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: true });
    await outcome(first);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects get and resolve until the popup tabId is bound via tabs.query", async () => {
    let deliverTabs;
    chrome.windows.create = (_opts, cb) => {
      queueMicrotask(() => cb?.({ id: 1001 }));
    };
    chrome.tabs.query = vi.fn((_query, cb) => {
      deliverTabs = (tabs) => queueMicrotask(() => cb?.(tabs));
    });
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalledWith(
      { windowId: 1001 },
      expect.any(Function),
    ));
    const approvalUrl = permissions.approvalPageUrl(port.streamId);
    const interim = approvalUrl.replace(/\?.*$/, "");
    expect(await sendApprovalMessage(port, { type: "get-approval" }, interim, 201))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: false });
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();

    deliverTabs([{ id: 201 }]);
    await vi.waitFor(async () => {
      expect(await sendApprovalMessage(port, { type: "get-approval" }, interim, 201))
        .toMatchObject({ request: { origin, ...route } });
    });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...route,
    }, interim, 201)).toEqual({ ok: true });
    await outcome(port);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("expires a popup approval that never binds tabId", async () => {
    vi.useFakeTimers();
    chrome.windows.create = (_opts, cb) => {
      queueMicrotask(() => cb?.({ id: 1001 }));
    };
    chrome.tabs.query = vi.fn((_query, cb) => {
      // Never deliver tabs — tabId stays unbound until the shared prompt timeout.
      void cb;
    });
    const port = start();
    await pending(port);
    await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
    expect(permissions.getPendingApproval(port.streamId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(permissions.APPROVAL_PROMPT_TIMEOUT_MS);
    expect(port.messages.at(-1)?.error?.code).toBe("permission_denied");
    expect(permissions.getPendingApproval(port.streamId)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["global", "low"], ["page", "high"], ["auto", undefined],
    ["none", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"],
  ])("saves popup choice %s and applies it to current and granted requests", async (preference, expected) => {
    await storage.saveSettings({ chatReasoningEffort: "low" });
    const port = start({ reasoningEffort: "high", temperature: 0.2 });
    await pending(port);
    expect(permissions.getPendingApproval(port.streamId)).toMatchObject({
      chatReasoningEffort: "global", globalChatReasoningEffort: "low",
    });
    // Exercise the popup's runtime message transport, including the new field.
    const response = await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "always",
      ...route, chatReasoningEffort: preference,
    });
    expect(response.ok).toBe(true);
    await outcome(port);
    expect(body().reasoning_effort).toBe(expected);
    expect(body().temperature).toBe(0.2);
    const settings = await storage.getSettings();
    expect(settings.originChatReasoningEfforts[origin]).toBe(preference === "global" ? undefined : preference);
    expect(settings.allowedOrigins[origin]).not.toHaveProperty("chatReasoningEffort");
    await storage.saveSettings({ chatReasoningEffort: "medium" });
    const next = start({ reasoningEffort: "high" });
    await outcome(next);
    expect(body().reasoning_effort).toBe(preference === "global" ? "medium" : expected);
    expect(permissions.getPendingApproval(next.streamId)).toBeNull();
  });

  it("remembers Allow once choices without granting access and restores them on reapproval", async () => {
    await storage.saveSettings({ chatReasoningEffort: "low" });
    const first = start();
    await pending(first);
    permissions.resolveApproval(first.streamId, {
      decision: "allow_once", ...route, chatReasoningEffort: "high",
    });
    await outcome(first);
    expect(body().reasoning_effort).toBe("high");
    expect((await storage.getSettings()).allowedOrigins).toEqual({});
    const second = start();
    await pending(second);
    expect(permissions.getPendingApproval(second.streamId).chatReasoningEffort).toBe("high");
    permissions.resolveApproval(second.streamId, {
      decision: "allow_once", ...route, chatReasoningEffort: "global",
    });
    await outcome(second);
    expect(body().reasoning_effort).toBe("low");
    expect((await storage.getSettings()).originChatReasoningEfforts).toEqual({});
  });

  it.each(["deny", "never", "close"])("does not save effort on %s", async (decision) => {
    await storage.setOriginChatReasoningEffort(origin, "low");
    const port = start();
    await pending(port);
    if (decision === "close") permissions.handleApprovalWindowClosed(1001);
    else permissions.resolveApproval(port.streamId, {
      decision, ...route, chatReasoningEffort: "high",
    });
    await vi.waitFor(() => expect(port.messages.at(-1).error?.code).toBe("permission_denied"));
    expect((await storage.getSettings()).originChatReasoningEfforts[origin]).toBe("low");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps choices isolated to the exact origin and preserves them when access is revoked", async () => {
    await storage.setOriginChatReasoningEffort(origin, "high");
    await storage.grantOriginAlways(origin, route);
    const other = "https://other.example";
    await storage.grantOriginAlways(other, route);
    await storage.saveSettings({ chatReasoningEffort: "low" });
    await outcome(start(undefined, false, other));
    expect(body().reasoning_effort).toBe("low");
    await storage.revokeOrigin(origin);
    const port = start();
    await pending(port);
    expect(permissions.getPendingApproval(port.streamId).chatReasoningEffort).toBe("high");
    // Older popup callers that omit the field must preserve the saved choice.
    permissions.resolveApproval(port.streamId, { decision: "allow_once", ...route });
    await outcome(port);
    expect(body().reasoning_effort).toBe("high");
  });

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
