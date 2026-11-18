import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import decideRequest from "./fixtures/system-one-request.json";
import openaiDecideFixture from "./fixtures/openai-decisions-response.json";

/**
 * Safari opens decide/speech approvals as tabs (not popups). These cover the
 * tab surface, sender isolation, and allow_once routing for non-chat methods.
 */

const origin = "https://app.example";
const decideRoute = { providerId: "openai", model: "gpt-6-luna" };
const transcribeRoute = { providerId: "openai", model: "gpt-4o-mini-transcribe" };

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

let ports, storage, permissions;

async function setupSafari() {
  vi.resetModules();
  const mock = installChromeMock();
  mock.setManifest({ browser_specific_settings: { safari: {} } });
  chrome.storage.local.setAccessLevel = vi.fn(async () => {});
  chrome.runtime.onConnect = event();
  chrome.runtime.onMessage = event();
  chrome.runtime.onInstalled = event();
  chrome.contextMenus = { removeAll: vi.fn(async () => {}), create: vi.fn(), onClicked: event() };
  chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
  chrome.windows.onRemoved = event();
  delete chrome.windows.create;
  chrome.tabs = {
    onRemoved: event(),
    onUpdated: event(),
    create: vi.fn(async () => ({ id: 201 })),
    get: vi.fn(async (id) => ({ id })),
    remove: vi.fn(async () => {}),
  };
  chrome.action = { onClicked: event() };
  ports = [];
  storage = await import("../src/storage.js");
  permissions = await import("../src/permissions.js");
  await import("../background/service-worker.js");
}

function start(request) {
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
      if (message.type === "binary-pull") {
        this.onMessage.emit({
          type: "binary-chunk",
          streamId: this.streamId,
          sequence: message.sequence,
          byteLength: 3,
          done: true,
          data: btoa(String.fromCharCode(4, 5, 6)),
        });
      }
      if (message.type === "binary-data") {
        this.onMessage.emit({
          type: "binary-ack",
          streamId: this.streamId,
          sequence: message.sequence,
        });
      }
    },
  };
  ports.push(port);
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: "start",
    origin,
    pageUrl: `${origin}/`,
    request,
  });
  return port;
}

function sendApprovalMessage(port, message, senderUrl = permissions.approvalPageUrl(port.streamId)) {
  return new Promise((resolve) => chrome.runtime.onMessage.emit({
    requestId: port.streamId,
    ...message,
  }, { url: senderUrl }, resolve));
}

async function pending(port, method) {
  await vi.waitFor(() => expect(
    permissions.getPendingApproval(port.streamId)
  ).toMatchObject({ method, origin }));
}

async function outcome(port) {
  await vi.waitFor(() => expect(port.messages.some(
    (m) => m.type === "error" || m.chunk?.type === "done"
  )).toBe(true));
}

beforeEach(async () => {
  await setupSafari();
});

afterEach(() => {
  for (const port of ports) port.onDisconnect.emit();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Safari decide approval", () => {
  beforeEach(async () => {
    await storage.saveSettings({
      apiKeys: { openai: "test-key" },
      operationDefaults: { decide: decideRoute },
    });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "https://api.openai.com/v1/decisions") {
        return Response.json(openaiDecideFixture);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it("opens a tab and only allows the trusted approval page to allow once", async () => {
    const port = start({ method: "decide", ...decideRequest });
    await pending(port, "decide");
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({
      url: permissions.approvalPageUrl(port.streamId),
      active: true,
    }));
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(port, { type: "get-approval" }, origin))
      .toEqual({ request: null });
    expect(await sendApprovalMessage(port, { type: "get-approval" }))
      .toMatchObject({ request: { method: "decide", origin, ...decideRoute } });

    const approval = {
      type: "resolve-approval",
      decision: "allow_once",
      ...decideRoute,
    };
    expect(await sendApprovalMessage(port, approval, origin)).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(port, approval)).toEqual({ ok: true });
    await outcome(port);
    expect(port.messages.filter((m) => m.type === "error")).toEqual([]);
    expect(port.messages.some((m) => m.chunk?.type === "done")).toBe(true);
    expect(fetch.mock.calls.at(-1)[0]).toBe("https://api.openai.com/v1/decisions");
    expect(await storage.getOriginOperationGrant(origin, "decide")).toBeNull();
  });

  it("denies without calling the provider", async () => {
    const port = start({ method: "decide", ...decideRequest });
    await pending(port, "decide");
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "deny" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Safari transcribe approval", () => {
  beforeEach(async () => {
    await storage.saveSettings({
      apiKeys: { openai: "test-key" },
      operationDefaults: { transcribe: transcribeRoute },
    });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.endsWith("/audio/transcriptions")) {
        return Response.json({ text: "Hello Safari" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it("opens a tab and only transfers audio after a trusted allow once", async () => {
    const port = start({
      method: "transcribe",
      media: { sourceId: "page-audio", mediaType: "audio/wav", byteLength: 3 },
    });
    await pending(port, "transcribe");
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({
      url: permissions.approvalPageUrl(port.streamId),
      active: true,
    }));
    expect(fetch).not.toHaveBeenCalled();
    expect(port.messages.some((m) => m.type.startsWith("binary-"))).toBe(false);

    expect(await sendApprovalMessage(port, { type: "get-approval" }))
      .toMatchObject({ request: { method: "transcribe", origin, ...transcribeRoute } });
    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...transcribeRoute,
    }, origin)).toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();

    expect(await sendApprovalMessage(port, {
      type: "resolve-approval", decision: "allow_once", ...transcribeRoute,
    })).toEqual({ ok: true });
    await outcome(port);
    expect(port.messages.filter((m) => m.type === "error")).toEqual([]);
    expect(port.messages.find((m) => m.chunk?.type === "done").chunk.transcript.text)
      .toBe("Hello Safari");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect([...new Uint8Array(await options.body.get("file").arrayBuffer())]).toEqual([4, 5, 6]);
  });

  it("denies without transferring audio or calling the provider", async () => {
    const port = start({
      method: "transcribe",
      media: { sourceId: "page-audio", mediaType: "audio/wav", byteLength: 3 },
    });
    await pending(port, "transcribe");
    expect(await sendApprovalMessage(port, { type: "resolve-approval", decision: "deny" }))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(port.messages.at(-1)?.error?.code).toBe("permission_denied"));
    expect(fetch).not.toHaveBeenCalled();
    expect(port.messages.some((m) => m.type.startsWith("binary-"))).toBe(false);
  });
});

describe("Safari on-device messages", () => {
  function message(payload) {
    return new Promise((resolve) => chrome.runtime.onMessage.emit(payload, {}, resolve));
  }

  it("rejects status and install without probing an offscreen host", async () => {
    const getContexts = vi.fn(async () => [{}]);
    chrome.runtime.getContexts = getContexts;

    await expect(message({ type: "on-device-status" })).resolves.toEqual({
      ok: false,
      availability: "missing",
      error: "On-device AI is unavailable in Safari.",
    });
    await expect(message({ type: "on-device-install" })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      error: "On-device AI is unavailable in Safari.",
    });
    await expect(message({ type: "on-device-cancel-install" })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      error: "On-device AI is unavailable in Safari.",
    });
    expect(getContexts).not.toHaveBeenCalled();
  });
});
