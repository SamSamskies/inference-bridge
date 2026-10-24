import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { assertSpeechStream } from "./helpers/speech-conformance.mjs";

const origin = "https://speech.example";
const mp3 = new Uint8Array(readFileSync(new URL("./fixtures/speech.mp3", import.meta.url)));
const wav = (() => {
  const bytes = Buffer.alloc(600_044);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Uint8Array(bytes);
})();
const wavRoute = { providerId: "gemini", model: "gemini-3.8-flash-tts", voice: "kore" };
const synthesisFeature = { outputMediaTypes: ["audio/mpeg", "audio/wav"] };
const routes = {
  transcribe: { providerId: "openai", model: "gpt-4o-mini-transcribe" },
  synthesize: { providerId: "openai", model: "tts-1", voice: "alloy" },
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
// and provider networking are mocked; binary messages traverse MessageChannels.
describe.each(["Chrome", "Firefox"])("%s stable speech contract", (browser) => {
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
      apiKeys: { openai: "test-key", gemini: "test-gemini-key" },
      operationDefaults: routes,
    });
    for (const [method, route] of Object.entries(routes)) {
      await storage.grantOriginOperationAlways(origin, method, route);
    }
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "The sky is blue." });
      if (url.endsWith("/audio/speech")) return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
      if (url.includes("generativelanguage.googleapis.com")) {
        if (url.includes("/models/")) return Response.json({ name: `models/${url.split("/").at(-1)}` });
        if (url.includes("/voices")) return Response.json({ voices: [{ id: "kore", type: "prebuilt" }] });
        if (url.endsWith("/interactions")) return Response.json({
          status: "completed", model: wavRoute.model,
          steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") }] }],
        });
      }
      throw new Error(`Unexpected privileged fetch: ${url}`);
    }));
    pageFetch = vi.fn(async () => new Response(Uint8Array.of(1, 2, 3), {
      headers: { "Content-Type": "audio/wav" },
    }));
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
    expect(inference.getFeatures().methods.synthesize).toEqual(synthesisFeature);
  });
  afterEach(() => {
    connections.forEach((port) => port.disconnect());
    channels.forEach(({ port1, port2 }) => { port1.close(); port2.close(); });
    vi.unstubAllGlobals();
  });

  it.each([false, true])("preserves exact MP3 bytes (streamed upstream: %s)", async (streamed) => {
    if (streamed) fetch.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(mp3.slice(0, 1000));
        controller.enqueue(mp3.slice(1000));
        controller.close();
      },
    }), { headers: { "Content-Type": "audio/mpeg" } }));
    const stream = inference.request({ method: "synthesize", text: "The sky is blue. 😀" });
    expect(packets).toEqual([]); // Lazy: constructing the iterable performs no work.
    const report = await assertSpeechStream("synthesize", stream, { expectedAudio: mp3 });
    expect(report.byteLength).toBe(mp3.byteLength);
    expect(report.done.usage.inputCharacters).toBe(18);
    expect(packets.find((message) => message.type === "start")).not.toHaveProperty("experimental");
  });

  it("preserves a complete native Gemini WAV through MAIN, relay and worker", async () => {
    await storage.grantOriginOperationAlways(origin, "synthesize", wavRoute);
    const request = { method: "synthesize", text: "Hello", output: { mediaType: "audio/wav" } };
    const report = await assertSpeechStream(request, inference.request(request), { expectedAudio: wav });
    expect(report.byteLength).toBe(wav.byteLength);
    expect(report.deltas).toBeGreaterThan(1);
    expect(report.done.audio.mediaType).toBe("audio/wav");
    const calls = fetch.mock.calls.filter(([url]) => url.endsWith("/interactions"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toMatchObject({
      model: wavRoute.model, store: false, stream: false,
      response_format: { mime_type: "audio/wav" },
      generation_config: { speech_config: [{ voice: "kore" }] },
    });
    expect(fetch.mock.calls.every(([url]) => url.includes("generativelanguage.googleapis.com"))).toBe(true);
  });

  it("filters WAV approval choices and sends no provider traffic until approval", async () => {
    await storage.revokeOriginOperation(origin, "synthesize");
    const listed = await new Promise((resolve) => chrome.runtime.onMessage.emit(
      { type: "list-providers", method: "synthesize", mediaType: "audio/wav" }, {}, resolve
    ));
    expect(listed.providers.map((p) => p.id)).toEqual(["gemini"]);
    const request = { method: "synthesize", text: "Hello", output: { mediaType: "audio/wav" } };
    const result = assertSpeechStream(request, inference.request(request), { expectedAudio: wav });
    let pending;
    await vi.waitFor(() => {
      const started = packets.find((p) => p.type === "started");
      pending = started && permissions.getPendingApproval(started.streamId);
      expect(pending).toMatchObject({ providerId: "gemini", mediaType: "audio/wav" });
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(packets.some((p) => p.chunk?.type === "accepted")).toBe(false);
    permissions.resolveApproval(pending.requestId, { decision: "allow_once", ...wavRoute });
    expect((await result).done.audio.mediaType).toBe("audio/wav");
  });

  it.each(["audio/wav", "audio/mpeg"])("rejects an incompatible saved route for %s without switching providers", async (mediaType) => {
    if (mediaType === "audio/mpeg") await storage.grantOriginOperationAlways(origin, "synthesize", wavRoute);
    const chunks = [];
    await expect((async () => {
      for await (const chunk of inference.request({ method: "synthesize", text: "Hello", output: { mediaType } })) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "unavailable" });
    expect(chunks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops WAV fragment delivery when the iterator closes", async () => {
    await storage.grantOriginOperationAlways(origin, "synthesize", wavRoute);
    const iterator = inference.request({ method: "synthesize", text: "Hello", output: { mediaType: "audio/wav" } })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("accepted");
    expect((await iterator.next()).value.mediaType).toBe("audio/wav");
    await iterator.return();
    await vi.waitFor(() => expect(packets.some((p) => p.type === "abort")).toBe(true));
    expect(packets.some((p) => p.chunk?.type === "done")).toBe(false);
  });

  it("rejects inconsistent provider MIME metadata without a successful done", async () => {
    await storage.grantOriginOperationAlways(origin, "synthesize", wavRoute);
    const { geminiProvider } = await import("../src/providers/gemini.js");
    const spy = vi.spyOn(geminiProvider, "synthesize").mockImplementation(async ({ onAudioDelta }) => {
      await onAudioDelta(wav);
      return { model: wavRoute.model, audio: { mediaType: "audio/mpeg", byteLength: wav.length } };
    });
    const chunks = [];
    try {
      await expect((async () => {
        for await (const chunk of inference.request({ method: "synthesize", text: "Hello", output: { mediaType: "audio/wav" } })) chunks.push(chunk);
      })()).rejects.toMatchObject({ code: "provider_error" });
      expect(chunks.map((c) => c.type)).toEqual(["accepted"]);
    } finally { spy.mockRestore(); }
  });

  it.each(["blob", "base64", "url"])("transcribes a %s source through the stable path", async (source) => {
    const bytes = new Uint8Array(600_000).fill(42);
    const media = source === "blob"
      ? { data: new Blob([bytes], { type: "audio/x-wav" }) }
      : source === "base64" ? { data: "AQID", mediaType: "audio/wav" }
      : { url: "https://media.example/recording.wav" };
    const report = await assertSpeechStream("transcribe", inference.request({ method: "transcribe", media }));
    expect(report.done.transcript.text).toBe("The sky is blue.");
    expect(report.deltas).toBe(0); // Final-only providers are explicitly valid.
    const start = packets.find((message) => message.type === "start");
    expect(start).not.toHaveProperty("experimental");
    expect(start.request.media).not.toHaveProperty("url");
    expect(start.request.media).not.toHaveProperty("data");
    const uploaded = new Uint8Array(await fetch.mock.calls[0][1].body.get("file").arrayBuffer());
    expect(uploaded).toEqual(source === "blob" ? bytes : Uint8Array.of(1, 2, 3));
    expect(pageFetch).toHaveBeenCalledTimes(source === "url" ? 1 : 0);
  });

  it.each([false, true])("checks append-only transcript agreement (mismatch: %s)", async (mismatch) => {
    fetch.mockImplementation(async () => new Response([
      'data: {"type":"transcript.text.delta","delta":"The sky "}', "",
      'data: {"type":"transcript.text.delta","delta":"is blue."}', "",
      `data: ${JSON.stringify({ type: "transcript.text.done", text: mismatch ? "different" : "The sky is blue." })}`, "", "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }));
    const chunks = [];
    async function* observed() {
      for await (const chunk of inference.request({ method: "transcribe", media: { data: "AQID", mediaType: "audio/wav" } })) {
        chunks.push(chunk);
        yield chunk;
      }
    }
    const result = assertSpeechStream("transcribe", observed());
    if (mismatch) {
      await expect(result).rejects.toMatchObject({ code: "provider_error" });
      expect(chunks.some((chunk) => chunk.type === "done")).toBe(false);
    } else expect((await result).deltas).toBe(2);
  });

  it("denies before accepted or media transfer", async () => {
    await storage.revokeOriginOperation(origin, "transcribe");
    const chunks = [];
    const outcome = (async () => {
      for await (const chunk of inference.request({ method: "transcribe", media: { data: "AQID", mediaType: "audio/wav" } })) chunks.push(chunk);
    })();
    const rejected = expect(outcome).rejects.toMatchObject({ code: "permission_denied" });
    let start;
    await vi.waitFor(() => {
      start = packets.find((message) => message.type === "started");
      expect(start && permissions.getPendingApproval(start.streamId)).toBeTruthy();
    });
    permissions.resolveApproval(start.streamId, { decision: "deny" });
    await rejected;
    expect(chunks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(packets.some((message) => message.type === "binary-pull")).toBe(false);
  });

  it("rejects declared/detected MIME conflicts before accepted or provider work", async () => {
    const chunks = [];
    await expect((async () => {
      for await (const chunk of inference.request({
        method: "transcribe",
        media: { data: new Blob(["abc"], { type: "audio/mpeg" }), mediaType: "audio/wav" },
      })) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "invalid_request" });
    expect(chunks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(packets.some((message) => message.type === "binary-pull")).toBe(false);
  });

  it("rejects an unrepresentable route language hint before accepted or upload", async () => {
    await storage.saveSettings({ apiKeys: { openrouter: "test-key" } });
    await storage.grantOriginOperationAlways(origin, "transcribe", {
      providerId: "openrouter", model: "openai/gpt-4o-mini-transcribe",
    });
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/models?output_modalities=transcription")) return Response.json({
        data: [{ id: "openai/gpt-4o-mini-transcribe", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } }],
      });
      throw new Error(`Unexpected upload: ${url}`);
    });
    const chunks = [];
    await expect((async () => {
      for await (const chunk of inference.request({
        method: "transcribe", language: "zh-Hant",
        media: { data: "AQID", mediaType: "audio/wav" },
      })) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("language hint") });
    expect(chunks).toEqual([]);
    expect(packets.some((message) => message.type === "binary-pull")).toBe(false);
    expect(fetch.mock.calls.every(([url]) => url.includes("/models?"))).toBe(true);
  });

  it.each([false, true])("ignores the obsolete global speech toggle (%s)", async (legacyEnabled) => {
    await chrome.storage.local.set({ experimentalSpeechEnabled: legacyEnabled });
    expect(inference.getFeatures().methods.synthesize).toEqual(synthesisFeature);
    const report = await assertSpeechStream("synthesize", inference.request({ method: "synthesize", text: "hello" }), { expectedAudio: mp3 });
    expect(report.byteLength).toBe(mp3.byteLength);
    expect(await chrome.storage.local.get("experimentalSpeechEnabled")).toEqual({});
  });
});
