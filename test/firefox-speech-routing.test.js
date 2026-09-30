import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";

const origin = "https://app.example";
const routes = {
  transcribe: { providerId: "openai", model: "gpt-4o-mini-transcribe" },
  synthesize: { providerId: "openai", model: "tts-1", voice: "alloy" },
};
const requests = {
  transcribe: { method: "transcribe", media: { sourceId: "page-audio", mediaType: "audio/wav", byteLength: 3 } },
  synthesize: { method: "synthesize", text: "Hello from Firefox" },
};

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

let mock;
let ports;
let grantOriginOperationAlways, saveSettings, getPendingApproval, resolveApproval;
beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  mock.setManifest({ browser_specific_settings: { gecko: {} } });
  chrome.runtime.onConnect = event();
  chrome.runtime.onMessage = event();
  chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
  chrome.windows.onRemoved = event();
  chrome.tabs = { onRemoved: event(), onUpdated: event() };
  chrome.action = { onClicked: event() };
  ports = [];
  ({ grantOriginOperationAlways, saveSettings } = await import("../src/storage.js"));
  ({ getPendingApproval, resolveApproval } = await import("../src/permissions.js"));
  await import("../background/service-worker.js");
  await saveSettings({
    experimentalSpeechEnabled: true,
    apiKeys: { openai: "test-key" },
    operationDefaults: routes,
  });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "Hello Firefox" });
    if (url.endsWith("/audio/speech")) {
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  for (const port of ports) port.onDisconnect.emit();
  vi.unstubAllGlobals();
});

function start(method, { experimental = true, transfer = true } = {}) {
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
      if (!transfer) return;
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
        this.onMessage.emit({ type: "binary-ack", streamId: this.streamId, sequence: message.sequence });
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
    request: requests[method],
  });
  return port;
}

async function waitForOutcome(port) {
  await vi.waitFor(() => expect(port.messages.some(
    (message) => message.type === "error" || message.chunk?.type === "done"
  )).toBe(true));
}

describe.each(["transcribe", "synthesize"])("Firefox %s routing", (method) => {
  it("requires opt-in before opening an approval or calling the provider", async () => {
    await saveSettings({ experimentalSpeechEnabled: false });
    const port = start(method);
    await waitForOutcome(port);
    expect(port.messages).toEqual([expect.objectContaining({
      type: "error", error: expect.objectContaining({ code: "invalid_request" }),
    })]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects speech on stable request", async () => {
    const port = start(method, { experimental: false });
    await waitForOutcome(port);
    expect(port.messages[0].error.code).toBe("invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits for operation-specific approval, then transfers audio", async () => {
    const port = start(method);
    await vi.waitFor(() => expect(getPendingApproval(port.streamId)?.method).toBe(method));
    expect(fetch).not.toHaveBeenCalled();
    expect(port.messages.some((message) => message.type.startsWith("binary-"))).toBe(false);
    resolveApproval(port.streamId, { decision: "allow_once", ...routes[method] });
    await waitForOutcome(port);
    expect(port.messages.filter((message) => message.type === "error")).toEqual([]);
    expect(port.messages).toContainEqual({ type: "chunk", chunk: { type: "accepted" } });
    const done = port.messages.find((message) => message.chunk?.type === "done").chunk;
    if (method === "transcribe") {
      expect(done.transcript.text).toBe("Hello Firefox");
      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect([...new Uint8Array(await options.body.get("file").arrayBuffer())]).toEqual([4, 5, 6]);
    } else {
      expect(done.audio).toMatchObject({ mediaType: "audio/mpeg", byteLength: 3 });
      const packet = port.messages.find((message) => message.type === "binary-data");
      expect(atob(packet.data)).toBe(String.fromCharCode(1, 2, 3));
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
        input: requests.synthesize.text, model: "tts-1", voice: "alloy", response_format: "mp3",
      });
    }
  });

  it("stops before provider calls when Firefox host access was revoked", async () => {
    await grantOriginOperationAlways(origin, method, routes[method]);
    chrome.permissions.contains.mockResolvedValue(false);
    const port = start(method);
    await waitForOutcome(port);
    expect(port.messages).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "unavailable", message: expect.stringContaining("Host access") }),
    }));
    expect(fetch).not.toHaveBeenCalled();
    expect(port.messages.some((message) => message.type.startsWith("binary-"))).toBe(false);
  });

  it.each(["disconnect", "abort", "host revocation"])("settles on %s during binary transfer", async (reason) => {
    await grantOriginOperationAlways(origin, method, routes[method]);
    const port = start(method, { transfer: false });
    await vi.waitFor(() => expect(port.messages.some(
      (message) => message.type === "binary-pull" || message.type === "binary-data"
    ), JSON.stringify(port.messages)).toBe(true));
    if (reason === "disconnect") port.onDisconnect.emit();
    else if (reason === "abort") port.onMessage.emit({ type: "abort", streamId: port.streamId });
    else chrome.permissions.onRemoved.emit();
    await waitForOutcome(port);
    expect(port.messages).toContainEqual(expect.objectContaining({
      type: "error", error: expect.objectContaining({ code: "aborted" }),
    }));
    expect(port.messages.some((message) => message.chunk?.type === "done")).toBe(false);
    if (method === "transcribe") expect(fetch).not.toHaveBeenCalled();
  });
});
