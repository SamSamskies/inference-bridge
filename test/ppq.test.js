import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";

let provider, listModels;
beforeEach(async () => {
  vi.resetModules();
  const ppq = await import("../src/providers/ppq.js");
  provider = ppq.ppqProvider;
  listModels = ppq.listPPQModels;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fn = { type: "function", function: { name: "weather", parameters: { type: "object" } } };
const search = { type: "web_search" };
const args = (extra = {}) => ({
  apiKey: "private-ppq-key", model: "auto", messages: [{ role: "user", content: "Hello" }],
  signal: new AbortController().signal, onDelta: vi.fn(), ...extra,
});
const sse = (...events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const chatResponse = () => sse({ model: "resolved-model", choices: [{ delta: { content: "Hello", reasoning_content: "Thinking" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });

describe("PPQ chat catalog", () => {
  it("uses public discovery, sorts/deduplicates aliases, and keeps non-chat methods separate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [
      { id: "z/model", type: "chat", name: "Z model", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "auto", type: "chat", name: "Auto" }, { id: "auto", name: "Auto" },
      { id: "typesafe/jev-1.13", type: "decisions" }, { id: "~typesafe/jev-latest" },
      { id: "nova-3", type: "transcription" }, { id: "deepgram_aura_2", type: "tts" },
      { id: "image-only", architecture: { output_modalities: ["image"] } },
      { id: "model:online" }, { id: "" }, {}, null,
    ] })));
    const signal = new AbortController().signal;
    expect(await listModels({ signal, apiKey: "must-not-send" })).toEqual([
      { id: "auto", label: "Auto" },
      { id: "z/model", label: "Z model", inputModalities: ["text", "image"], outputModalities: ["text"] },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.ppq.ai/v1/models", { signal });
    expect(await provider.getModelCapabilities({ model: "z/model" })).toEqual({ imageInput: true, imageOutput: false });
    expect(await provider.getModelCapabilities({ model: "auto" })).toEqual({ imageInput: null, imageOutput: false });
  });

  it.each([
    [() => { throw new TypeError("network"); }, "unavailable"],
    [() => new Response("no", { status: 503 }), "unavailable"],
    [() => new Response("no", { status: 401 }), "provider_error"],
    [() => new Response("invalid-json"), "provider_error"],
    [() => Response.json({ models: [] }), "provider_error"],
  ])("reports failed discovery without disabling manual text chat", async (response, code) => {
    vi.stubGlobal("fetch", vi.fn(response));
    await expect(listModels()).rejects.toMatchObject({ name: "InferenceError", code });
    fetch.mockImplementation(chatResponse);
    expect((await provider.streamChat(args({ model: "manual-alias" }))).message.content).toBe("Hello");
  });

  it("expires vision proof and fails closed after a failed refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "vision", architecture: { input_modalities: ["image"] } }] })));
    const now = Date.now();
    const date = vi.spyOn(Date, "now").mockReturnValue(now);
    expect((await provider.getModelCapabilities({ model: "vision" })).imageInput).toBe(true);
    date.mockReturnValue(now + 60_001);
    fetch.mockRejectedValue(new TypeError("network"));
    await expect(provider.getModelCapabilities({ model: "vision" })).rejects.toMatchObject({ code: "unavailable" });
    fetch.mockResolvedValue(Response.json({ data: [] }));
    expect((await provider.getModelCapabilities({ model: "vision" })).imageInput).toBe(null);
  });

  it("aborts before discovery and while reading catalog JSON", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { controller.abort(); return { data: [] }; } })));
    await expect(listModels({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    fetch.mockClear();
    await expect(listModels({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PPQ chat transport and tools", () => {
  it.each([
    [undefined, undefined, undefined],
    [[search], "auto", [search]],
    [[search], "none", undefined],
    [[fn, search], "auto", [fn, search]],
    [[fn, search], "none", [fn]],
    [[fn], { type: "function", function: { name: "weather" } }, [fn]],
  ])("preserves approved tools and suppresses search with none (%j, %j)", async (tools, toolChoice, expected) => {
    vi.stubGlobal("fetch", vi.fn(chatResponse));
    const onDelta = vi.fn(), onReasoningDelta = vi.fn();
    const input = args({ tools, toolChoice, onDelta, onReasoningDelta, options: { temperature: 0.5 } });
    const result = await provider.streamChat(input);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.ppq.ai/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer private-ppq-key");
    expect(init.signal).toBe(input.signal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "auto", messages: input.messages, stream: true, temperature: 0.5 });
    expect(body.tools).toEqual(expected);
    expect(body.tool_choice).toEqual(expected ? toolChoice : undefined);
    expect(body.plugins).toBeUndefined();
    expect(result).toMatchObject({ model: "resolved-model", message: { content: "Hello", reasoning: "Thinking" }, usage: { inputTokens: 2, outputTokens: 3 } });
    expect(onDelta).toHaveBeenCalledWith("Hello");
    expect(onReasoningDelta).toHaveBeenCalledWith("Thinking");
  });

  it("assembles declared streamed function calls mixed with hosted search and round-trips tool results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Austin"}' } }] } }] },
    )));
    const first = await provider.streamChat(args({ tools: [search, fn] }));
    expect(first.message.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Austin"}' } }]);
    fetch.mockImplementation(chatResponse);
    await provider.streamChat(args({ tools: [search, fn], messages: [
      first.message, { role: "tool", toolCallId: "call_1", content: "Sunny" },
    ] }));
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.messages[0].tool_calls).toEqual(first.message.toolCalls);
    expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" });
  });

  it("rejects a server search incorrectly returned as a page-executable function", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "search_1", function: { name: "web_search", arguments: "{}" } }] } }] })));
    await expect(provider.streamChat(args({ tools: [search, fn] }))).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("server-side") });
  });

  it.each(["model:online", "model:ONLINE", "model:online:nitro", "model:nitro:online", "typesafe/jev-1.13", "~typesafe/jev-latest", ""])("rejects inappropriate chat model %s before network I/O", async (model) => {
    vi.stubGlobal("fetch", vi.fn());
    expect(() => provider.preflightChat({ model })).toThrow();
    await expect(provider.streamChat(args({ model, toolChoice: "none" }))).rejects.toHaveProperty("code");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an explicit key and rejects image output without a provider call", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(provider.streamChat(args({ apiKey: undefined }))).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.streamChat(args({ output: { images: true } }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps verified vision input and blocks unknown vision models", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => url.endsWith("/models")
      ? Response.json({ data: [{ id: "vision", architecture: { input_modalities: ["image"] } }] }) : chatResponse()));
    const messages = [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "YQ==" }] }];
    await provider.streamChat(args({ model: "vision", messages }));
    expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }]);
    await expect(provider.streamChat(args({ model: "unknown", messages }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 402, 422, 429, 503])("sanitizes actionable HTTP %s errors without retrying or dropping search", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "denied private-ppq-key", debug: "hidden" } }, { status })));
    await expect(provider.streamChat(args({ tools: [search] }))).rejects.toMatchObject({
      code: status >= 500 ? "unavailable" : "provider_error",
      message: expect.stringContaining("[redacted]"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).tools).toEqual([search]);
  });

  it("keeps generic PPQ compat endpoints fail-closed for hosted search", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const compat = createOpenAICompatProvider({ id: "compat:ppq", name: "Old PPQ", baseUrl: "https://api.ppq.ai/v1" });
    await expect(compat.streamChat(args({ tools: [search] }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
