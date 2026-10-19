import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { assertDecisionStream } from "./helpers/decisions-conformance.mjs";
import payload from "./fixtures/system-one-request.json";
import fixture from "./fixtures/system-one-response.json";
import openaiFixture from "./fixtures/openai-decisions-response.json";
import catalog from "./fixtures/openrouter-decisions-models.json";

const origin = "https://decisions.example";
const request = { method: "decide", ...payload };
const routes = {
  openrouter: { providerId: "openrouter", model: "typesafe/jev-1.13" },
  openai: { providerId: "openai", model: "gpt-6-luna" },
  ollama: { providerId: "ollama", model: "nimble:latest" },
};
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => [...listeners].forEach((fn) => fn(...args)),
  };
}

// Run the shipped MAIN, isolated relay, and worker together. Only browser APIs
// and provider networking are mocked; requests traverse real MessageChannels.
describe.each(["Chrome", "Firefox"])("%s stable decision contract", (browser) => {
  let inference, storage, permissions, packets, connections, channels, pageFetch;
  beforeEach(async () => {
    vi.resetModules();
    const mock = installChromeMock();
    if (browser === "Firefox") mock.setManifest({ browser_specific_settings: { gecko: {} } });
    chrome.runtime.onConnect = event();
    chrome.runtime.onMessage = event();
    chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
    chrome.windows.onRemoved = event();
    chrome.tabs = { onRemoved: event(), onUpdated: event() };
    chrome.action = { onClicked: event() };
    packets = [];
    connections = [];
    channels = [];
    chrome.runtime.connect = ({ name }) => {
      let disconnected = false;
      const disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        client.onDisconnect.emit();
        worker.onDisconnect.emit();
      };
      const client = { name, onMessage: event(), onDisconnect: event(), disconnect };
      const worker = { name, sender: { tab: { id: 1 } }, onMessage: event(), onDisconnect: event(), disconnect };
      client.postMessage = (message) => {
        packets.push(message);
        queueMicrotask(() => worker.onMessage.emit(structuredClone(message)));
      };
      worker.postMessage = (message) => {
        packets.push(message);
        queueMicrotask(() => client.onMessage.emit(structuredClone(message)));
      };
      connections.push(client);
      chrome.runtime.onConnect.emit(worker);
      return client;
    };
    storage = await import("../src/storage.js");
    permissions = await import("../src/permissions.js");
    await import("../background/service-worker.js");
    await storage.saveSettings({
      apiKeys: { openai: "test-key", openrouter: "test-key" },
      operationDefaults: { decide: routes.openrouter },
    });
    await storage.grantOriginOperationAlways(origin, "decide", routes.openrouter);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.endsWith("?output_modalities=decisions")) return Response.json(catalog);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: routes.ollama.model }] });
      if (url.endsWith("/api/show")) return Response.json({ capabilities: ["decision"], details: { format: "gguf" } });
      if (url === "https://api.openai.com/v1/decisions") return Response.json(openaiFixture);
      if (url.endsWith("/alpha/decisions") || url.endsWith("/v1/systemone")) return Response.json(fixture);
      throw new Error(`Unexpected privileged fetch: ${url}`);
    }));
    pageFetch = vi.fn(async () => { throw new Error("Decision state must not trigger page fetches."); });
    const messages = event();
    const window = {
      isSecureContext: true,
      addEventListener: (type, fn) => { if (type === "message") messages.addListener(fn); },
      removeEventListener: (type, fn) => { if (type === "message") messages.removeListener(fn); },
      postMessage: (data, _target, ports) => messages.emit({ source: window, data, ports }),
    };
    window.top = window;
    const globals = {
      window, chrome, location: { origin, href: `${origin}/` },
      Object, Math, Map, Set, Promise, Error, Symbol, Blob, Uint8Array, URL, AbortController,
      atob, btoa, TextEncoder, TextDecoder, fetch: pageFetch,
      console: { warn: vi.fn() }, setTimeout, clearTimeout, setInterval, clearInterval,
      MessageChannel: class extends MessageChannel {
        constructor() { super(); channels.push(this); }
      },
    };
    for (const file of ["inject.js", "content-script.js"]) {
      const filename = new URL(`../content/${file}`, import.meta.url);
      vm.runInNewContext(readFileSync(filename, "utf8"), globals, { filename: filename.pathname });
    }
    inference = window.inference;
    expect(inference.getFeatures().methods.decide).toBe(true);
  });
  afterEach(() => {
    connections.forEach((port) => port.disconnect());
    channels.forEach(({ port1, port2 }) => { port1.close(); port2.close(); });
    vi.unstubAllGlobals();
  });

  it.each(Object.keys(routes))("passes the companion IPA assertions via %s", async (backend) => {
    await storage.grantOriginOperationAlways(origin, "decide", routes[backend]);
    const stream = inference.request(request);
    expect(packets).toEqual([]);
    const done = await assertDecisionStream(request, stream);
    expect(done.answers).toEqual(fixture.answers);
    expect(packets.find((packet) => packet.type === "start")).not.toHaveProperty("experimental");
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("completes typed refusals (all: %s)", async (all) => {
    const body = structuredClone(fixture);
    for (const id of all ? Object.keys(request.questions) : ["is_bug"]) body.answers[id] = { type: "refusal" };
    fetch.mockImplementation(async (url) => Response.json(url.includes("/models?") ? catalog : body));
    const done = await assertDecisionStream(request, inference.request(request));
    expect(done.answers).toEqual(body.answers);
  });

  it.each([
    ["non-maximum choice", (body) => { body.answers.team.choice = "frontend"; }],
    ["inconsistent score", (body) => { body.answers.urgency.score = 0; }],
    ["changed legend", (body) => { body.answers.urgency.legend["0"] = "Changed"; }],
    ["missing answer", (body) => { delete body.answers.is_bug; }],
    ["extra answer", (body) => { body.answers.extra = { type: "refusal" }; }],
    ["malformed refusal", (body) => { body.answers.is_bug = { type: "refusal", noul: 0 }; }],
  ])("rejects %s before done", async (_name, mutate) => {
    const body = structuredClone(fixture);
    mutate(body);
    fetch.mockImplementation(async (url) => Response.json(url.includes("/models?") ? catalog : body));
    const chunks = [];
    await expect((async () => {
      for await (const chunk of inference.request(request)) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "provider_error" });
    expect(chunks).toEqual([{ type: "accepted" }]);
  });

  it("snapshots before approval and keeps saved decision routes independent of defaults", async () => {
    await storage.revokeOriginOperation(origin, "decide");
    await storage.grantOriginAlways(origin, routes.openrouter);
    await storage.grantOriginOperationAlways(origin, "transcribe", { providerId: "openai", model: "gpt-4o-mini-transcribe" });
    const input = structuredClone(request);
    const result = assertDecisionStream(request, inference.request(input));
    let streamId;
    await vi.waitFor(() => {
      streamId = packets.find((packet) => packet.type === "started")?.streamId;
      expect(permissions.getPendingApproval(streamId)?.method).toBe("decide");
    });
    expect(fetch).not.toHaveBeenCalled();
    input.state.ticket = "mutated";
    input.questions.team.criteria.frontend = "mutated";
    permissions.resolveApproval(streamId, { decision: "always", ...routes.openrouter });
    await result;
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).state).toEqual(request.state);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).questions).toEqual(request.questions);
    await storage.saveSettings({ defaultProviderId: "anthropic", operationDefaults: { decide: routes.openai } });
    fetch.mockClear();
    await assertDecisionStream(request, inference.request(request));
    expect(fetch.mock.calls.at(-1)[0]).toContain("openrouter.ai/api/alpha/decisions");
    expect(await storage.getOriginOperationGrant(origin, "decide")).toMatchObject(routes.openrouter);
  });

  it("honors an origin block despite a saved decision grant", async () => {
    await storage.blockOrigin(origin);
    await expect(assertDecisionStream(request, inference.request(request)))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts while approval is pending without provider I/O", async () => {
    await storage.revokeOriginOperation(origin, "decide");
    const controller = new AbortController();
    const result = assertDecisionStream(request, inference.request({ ...request, signal: controller.signal }));
    const rejected = expect(result).rejects.toMatchObject({ code: "aborted" });
    let streamId;
    await vi.waitFor(() => {
      streamId = packets.find((packet) => packet.type === "started")?.streamId;
      expect(permissions.getPendingApproval(streamId)?.method).toBe("decide");
    });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(permissions.getPendingApproval(streamId)).toBeNull());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closing the iterator cancels pending approval", async () => {
    await storage.revokeOriginOperation(origin, "decide");
    const iterator = inference.request(request)[Symbol.asyncIterator]();
    const pending = iterator.next();
    let streamId;
    await vi.waitFor(() => {
      streamId = packets.find((packet) => packet.type === "started")?.streamId;
      expect(permissions.getPendingApproval(streamId)?.method).toBe("decide");
    });
    expect(await iterator.return()).toEqual({ done: true, value: undefined });
    expect(await pending).toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(permissions.getPendingApproval(streamId)).toBeNull());
    expect(fetch).not.toHaveBeenCalled();
    expect(packets.some((packet) => packet.chunk?.type === "done")).toBe(false);
  });

  it.each(["provider", "model", "options", "messages"])("rejects page-selected %s before approval or provider work", async (field) => {
    await expect(assertDecisionStream(request, inference.request({ ...request, [field]: "bad" })))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(packets).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["abort", "return"])("cancels unfinished provider work on %s without done", async (action) => {
    let providerSignal;
    fetch.mockImplementation(async (url, { signal }) => {
      if (url.includes("/models?")) return Response.json(catalog);
      providerSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    const iterator = inference.request({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "accepted" } });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    if (action === "abort") {
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    } else {
      expect(await iterator.return()).toEqual({ done: true, value: undefined });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    }
    await vi.waitFor(() => expect(providerSignal.aborted).toBe(true));
    expect(packets.some((packet) => packet.chunk?.type === "done")).toBe(false);
  });
});
