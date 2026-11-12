import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaCloudProvider as cloud, getOllamaCloudThinking } from "../src/providers/ollama-cloud.js";
import { ollamaProvider as local } from "../src/providers/ollama.js";
import { resolveProviderModels, resolveProviderVoices } from "../src/providers/registry.js";
import { isApprovalProviderReady } from "../src/provider-ready.js";
import decisionRequest from "./fixtures/system-one-request.json";
import decisionResponse from "./fixtures/system-one-response.json";

const apiKey = "private-cloud-test-key";
const signal = () => new AbortController().signal;
const chatArgs = (extra = {}) => ({
  apiKey, model: "gpt-oss:120b", messages: [{ role: "user", content: "Hi" }],
  signal: signal(), onDelta: vi.fn(), onReasoningDelta: vi.fn(), ...extra,
});
const chunk = (message, done = true) => `${JSON.stringify({ model: "gpt-oss:120b", message: { role: "assistant", ...message }, done })}\n`;
const ndjson = (body) => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
const entry = (name, capabilities) => ({ name, capabilities });
const catalog = [
  entry("gpt-oss:120b", ["completion", "thinking", "tools"]),
  entry("gemma4:31b", ["completion", "vision"]),
  entry("clef:27b", ["decision", "vision"]),
];

function mockCloud({ models = catalog, show, chat } = {}) {
  const mock = vi.fn(async (url, init) => {
    if (!url.startsWith("https://ollama.com/")) throw new Error(`Unexpected non-cloud request: ${url}`);
    if (url.endsWith("/api/tags")) return Response.json({ models });
    if (url.endsWith("/api/show")) {
      const model = JSON.parse(init.body).model;
      return show ? show(model, init) : Response.json({ capabilities: models.find((m) => m.name === model)?.capabilities });
    }
    if (url.endsWith("/api/chat")) return chat ? chat(init) : ndjson(chunk({ content: "Hi", thinking: "Thinking" }));
    if (url.endsWith("/v1/systemone")) return Response.json({ ...decisionResponse, model: "clef:27b" });
    throw new Error(`Unexpected cloud request: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Ollama Cloud discovery and readiness", () => {
  it("keeps cloud ready with a key while local Ollama is down", () => {
    expect(isApprovalProviderReady({ ...cloud, hasApiKey: true }, { ollamaAvailable: false })).toBe(true);
    expect(isApprovalProviderReady({ ...cloud, hasApiKey: false }, { ollamaAvailable: true })).toBe(false);
    expect(isApprovalProviderReady(local, { ollamaAvailable: false })).toBe(false);
  });

  it("uses public exact cloud ids and separates operation catalogs", async () => {
    const mock = mockCloud();
    expect(await cloud.listModels({ apiKey })).toEqual([{ id: "gemma4:31b" }, { id: "gpt-oss:120b" }]);
    expect(await cloud.decisions.listModels()).toEqual([{ id: "clef:27b", inputModalities: ["text", "image"] }]);
    expect(await cloud.transcription.listModels()).toEqual([]);
    expect(await cloud.synthesis.listModels()).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock.mock.calls.every(([, init]) => !init.headers.Authorization)).toBe(true);
  });

  it("probes missing capabilities and excludes unknown, embedding, decision, and speech models from chat", async () => {
    mockCloud({ models: [
      { name: "custom-chat" }, entry("unknown", []), entry("embed", ["embedding", "audio"]),
      entry("custom-speech", ["speech"]), entry("custom-decision", ["decision"]),
    ], show: () => Response.json({ capabilities: ["completion"] }) });
    expect(await cloud.listModels()).toEqual([{ id: "custom-chat" }]);
  });

  it("skips tags whose capability probe fails instead of failing the whole catalog", async () => {
    mockCloud({ models: [{ name: "stale" }, { name: "limited" }, { name: "good" }],
      show: (model) => model === "stale" ? Response.json({ error: "not found" }, { status: 404 })
        : model === "limited" ? Response.json({ error: "slow down" }, { status: 429 })
          : Response.json({ capabilities: ["completion"] }) });
    expect(await cloud.listModels()).toEqual([{ id: "good" }]);
  });

  it("still aborts catalog discovery when the signal is aborted", async () => {
    mockCloud({ models: [{ name: "a" }], show: () => Response.json({ capabilities: ["completion"] }) });
    const controller = new AbortController();
    controller.abort();
    await expect(cloud.listModels({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it.each([{}, { models: "bad" }])("rejects a malformed catalog: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(cloud.listModels()).rejects.toMatchObject({ code: "provider_error" });
  });

  it("does not borrow local vision capabilities for the same model name", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => Response.json({
      capabilities: url.startsWith("http://localhost") ? ["completion", "vision"] : ["completion"],
    })));
    expect((await local.getModelCapabilities({ model: "same-model" })).imageInput).toBe(true);
    expect((await cloud.getModelCapabilities({ model: "same-model" })).imageInput).toBe(false);
  });
});

describe("Ollama Cloud native chat", () => {
  it("authenticates cloud requests and streams content, reasoning, tools, and thinking controls", async () => {
    const mock = mockCloud({
      show: () => Response.json({ capabilities: ["completion", "tools", "thinking"], thinking: { values: ["low", "medium", "high"], default: "medium" } }),
      chat: () => ndjson(chunk({ content: "", thinking: "Checking", tool_calls: [{ function: { name: "weather", arguments: { city: "Austin" } } }] })),
    });
    const args = chatArgs({ options: { reasoningEffort: "none", temperature: 0.2 }, tools: [{ type: "function", function: { name: "weather" } }] });
    const result = await cloud.streamChat(args);
    expect(args.onReasoningDelta).toHaveBeenCalledWith("Checking");
    expect(result.message.toolCalls[0].function).toEqual({ name: "weather", arguments: '{"city":"Austin"}' });
    const [, init] = mock.mock.calls.find(([url]) => url.endsWith("/api/chat"));
    expect(init.headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(init.body)).toMatchObject({ think: "low", options: { temperature: 0.2 }, stream: true });
    expect(mock.mock.calls.every(([url]) => url.startsWith("https://ollama.com/"))).toBe(true);
  });

  it("runs hosted search and fetch through the shared loop with cloud chat turns", async () => {
    let turns = 0;
    const native = mockCloud({ chat: () => ndjson(++turns === 1
      ? chunk({ content: "", tool_calls: [{ function: { name: "web_search", arguments: { query: "Ollama" } } }] })
      : chunk({ content: "Found it" })) });
    const prior = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => url.endsWith("/api/web_search")
      ? Response.json({ results: [{ title: "Ollama", url: "https://ollama.com", content: "Models" }] }) : prior(url, init)));
    const args = chatArgs({ tools: [{ type: "web_search" }] });
    const result = await cloud.streamChat(args);
    expect(result.message.content).toBe("Found it");
    expect(result.message.toolCalls).toBeUndefined();
    expect(turns).toBe(2);
    const search = fetch.mock.calls.find(([url]) => url.endsWith("/api/web_search"));
    expect(search[1].headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(native.mock.calls.filter(([url]) => url.endsWith("/api/chat"))).toHaveLength(2);
  });

  it("suppresses hosted search when toolChoice is none", async () => {
    const mock = mockCloud();
    await cloud.streamChat(chatArgs({ tools: [{ type: "web_search" }], toolChoice: "none" }));
    expect(mock.mock.calls.some(([url]) => /web_search|web_fetch/.test(url))).toBe(false);
    expect(JSON.parse(mock.mock.calls.at(-1)[1].body).tools).toBeUndefined();
  });

  it("sends images only when cloud metadata advertises vision", async () => {
    const mock = mockCloud();
    const messages = [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "YWJj" }] }];
    await cloud.streamChat(chatArgs({ model: "gemma4:31b", messages }));
    expect(JSON.parse(mock.mock.calls.at(-1)[1].body).messages[0].images).toEqual(["YWJj"]);
    await expect(cloud.streamChat(chatArgs({ messages }))).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each(["clef:27b", "phonon", "retired-model"])("blocks %s on the chat route", async (model) => {
    const mock = mockCloud();
    await expect(cloud.streamChat(chatArgs({ model }))).rejects.toMatchObject({ code: "unavailable" });
    expect(mock.mock.calls.some(([url]) => url.endsWith("/api/chat"))).toBe(false);
  });

  it.each([401, 403, 402, 429, 503])("preserves cloud HTTP %s errors without localhost advice or credentials", async (status) => {
    mockCloud({ chat: () => Response.json({ error: `cloud denied ${apiKey}` }, { status }) });
    await expect(cloud.streamChat(chatArgs())).rejects.toMatchObject({
      code: status >= 500 ? "unavailable" : "provider_error", message: "cloud denied [redacted]",
    });
  });

  it("redacts the transmitted key when saved credentials contain surrounding whitespace", async () => {
    mockCloud({ chat: () => Response.json({ error: apiKey }, { status: 401 }) });
    await expect(cloud.streamChat(chatArgs({ apiKey: ` ${apiKey} ` }))).rejects.toMatchObject({ message: "[redacted]" });
  });

  it("rejects missing keys before network activity", async () => {
    const mock = mockCloud();
    await expect(cloud.streamChat(chatArgs({ apiKey: " " }))).rejects.toMatchObject({ code: "unavailable" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("propagates cancellation during cloud metadata discovery", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    }));
    await expect(cloud.streamChat(chatArgs({ signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses cloud thinking metadata without local setup", async () => {
    const mock = mockCloud({ show: () => Response.json({ thinking: { values: [false, true], default: true } }) });
    expect(await getOllamaCloudThinking("gemma4:31b", { apiKey })).toEqual({ values: [false, true], default: true });
    expect(mock.mock.calls[0][0]).toBe("https://ollama.com/api/show");
  });
});

describe("Ollama Cloud decisions and speech", () => {
  it("sends real System One requests with cloud ids and the cloud key", async () => {
    const mock = mockCloud();
    const result = await cloud.decide({ apiKey, model: "clef:27b", ...decisionRequest, signal: signal() });
    expect(result.answers).toEqual(decisionResponse.answers);
    const [url, init] = mock.mock.calls.at(-1);
    expect(url).toBe("https://ollama.com/v1/systemone");
    expect(init.headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(init.body)).toEqual({ model: "clef:27b", ...decisionRequest });
  });

  it("rechecks decisions capability before submitting a saved route", async () => {
    const mock = mockCloud({ show: () => Response.json({ capabilities: ["completion"] }) });
    await expect(cloud.decide({ apiKey, model: "clef:27b", ...decisionRequest, signal: signal() })).rejects.toMatchObject({ code: "unavailable" });
    expect(mock.mock.calls.some(([url]) => url.endsWith("/v1/systemone"))).toBe(false);
  });

  it("offers speech only when advertised and keeps cloud transcription WAV-only", async () => {
    mockCloud({ models: [...catalog, entry("cloud-transcriber", ["audio", "completion"]), entry("phonon", ["speech"])] });
    expect(await resolveProviderModels(cloud, { method: "transcribe", mediaType: "audio/wav" })).toEqual([{ id: "cloud-transcriber" }]);
    expect(await resolveProviderModels(cloud, { method: "transcribe", mediaType: "audio/mpeg" })).toEqual([]);
    expect(await cloud.synthesis.listModels()).toEqual([{ id: "phonon" }]);
    expect(await resolveProviderVoices(cloud, { model: "phonon" })).toEqual([{ id: "default" }]);
  });

  it("authenticates multipart transcription without a local daemon", async () => {
    mockCloud({ models: [entry("cloud-transcriber", ["audio", "completion"])] });
    const prior = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => url.endsWith("/v1/audio/transcriptions")
      ? Response.json({ text: "Hello" }) : prior(url, init)));
    const result = await cloud.transcribe({ apiKey, model: "cloud-transcriber", audio: { data: new Blob(["wav"]), byteLength: 3, mediaType: "audio/wav" }, signal: signal(), onDelta: vi.fn() });
    expect(result.transcript.text).toBe("Hello");
    const [url, init] = fetch.mock.calls.at(-1);
    expect(url).toBe("https://ollama.com/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: `Bearer ${apiKey}` });
    expect(init.body.get("model")).toBe("cloud-transcriber");
  });

  it("authenticates synthesis and preserves bounded WAV delivery when a cloud speech model is advertised", async () => {
    mockCloud({ models: [entry("phonon", ["speech"])] });
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]]) {
      bytes.set(new TextEncoder().encode(text), offset);
    }
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, 0xffffffff, true);
    const prior = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => url.endsWith("/v1/audio/speech")
      ? new Response(bytes, { headers: { "Content-Type": "audio/wav" } }) : prior(url, init)));
    const onAudioDelta = vi.fn();
    const result = await cloud.synthesize({ apiKey, model: "phonon", text: "Hello", voice: "default", mediaType: "audio/wav", signal: signal(), onAudioDelta });
    expect(result.audio).toEqual({ mediaType: "audio/wav", byteLength: 46 });
    expect(onAudioDelta).toHaveBeenCalledTimes(1);
    const delivered = onAudioDelta.mock.calls[0][0];
    expect(new DataView(delivered.buffer).getUint32(4, true)).toBe(38);
    const [url, init] = fetch.mock.calls.at(-1);
    expect(url).toBe("https://ollama.com/v1/audio/speech");
    expect(init.headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(init.body)).toMatchObject({ model: "phonon", response_format: "wav" });
  });

  it("blocks unavailable cloud speech before uploading any audio or text", async () => {
    const mock = mockCloud();
    await expect(cloud.transcribe({ apiKey, model: "gemma4:31b", audio: { data: new Blob(["wav"]), byteLength: 3, mediaType: "audio/wav" }, signal: signal(), onDelta: vi.fn() })).rejects.toMatchObject({ code: "unavailable" });
    await expect(cloud.synthesize({ apiKey, model: "phonon", text: "Hello", voice: "default", mediaType: "audio/wav", signal: signal(), onAudioDelta: vi.fn() })).rejects.toMatchObject({ code: "unavailable" });
    expect(mock.mock.calls.every(([url]) => url.endsWith("/api/show"))).toBe(true);
  });
});
