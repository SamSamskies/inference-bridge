import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import models from "./fixtures/ppq-audio-models.json";
import voices from "./fixtures/ppq-audio-voices.json";
import { SYNTHESIS_OUTPUT_MAX_BYTES, TRANSCRIPTION_INPUT_MAX_BYTES } from "../src/speech.js";

const base = "https://api.ppq.ai/v1/audio";
const mp3 = new Uint8Array(readFileSync(new URL("./fixtures/speech.mp3", import.meta.url)));
let provider, response;
const common = () => ({ apiKey: "private-ppq-speech-key", signal: new AbortController().signal });
const transcription = (extra = {}) => ({
  ...common(), model: "nova-3", onDelta: vi.fn(),
  audio: { data: new Blob([Uint8Array.of(1, 2, 3)], { type: "audio/wav" }), mediaType: "audio/wav", byteLength: 3 }, ...extra,
});
const synthesis = (extra = {}) => ({ ...common(), model: "deepgram_aura_2", voice: "aura-2-arcas-en", text: "Hello", mediaType: "audio/mpeg", onAudioDelta: vi.fn(), ...extra });
const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(async () => {
  vi.resetModules();
  provider = (await import("../src/providers/ppq.js")).ppqProvider;
  response = (url) => url.endsWith("transcriptions") ? Response.json({ text: "Hello", language: "en", duration: 1.5 })
    : new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === `${base}/models`) return Response.json(models);
    if (url === `${base}/voices`) return Response.json(voices);
    return response(url, init);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PPQ audio discovery", () => {
  it("keeps STT and text TTS catalogs separate and omits speech-to-speech models", async () => {
    const stt = await provider.transcription.listModels();
    const tts = await provider.synthesis.listModels();
    expect(stt.map((model) => model.id)).toEqual(["nova-2", "nova-3"]);
    expect(tts.map((model) => model.id)).toEqual(["deepgram_aura_2", "eleven_multilingual_v2", "eleven_v3", "tinfoil-voxtral-tts"]);
    expect(stt.every((model) => model.outputModalities.includes("transcription"))).toBe(true);
    expect(tts.every((model) => model.outputModalities.includes("speech"))).toBe(true);
    expect(fetch.mock.calls.every(([url, init]) => url === `${base}/models` && !init.headers)).toBe(true);
    await expect(provider.streamChat({ ...common(), model: "eleven_v3", messages: [], onDelta() {} })).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.streamChat({ ...common(), model: "eleven_multilingual_sts_v2", messages: [], onDelta() {} })).rejects.toMatchObject({ code: "unavailable" });
    expect(posts()).toEqual([]);
  });

  it("discovers voices without a key, matching exact model IDs and showing languages", async () => {
    const result = await provider.synthesis.listVoices({ model: "deepgram_aura_2", apiKey: "must-not-send" });
    expect(result).toEqual([{ id: "aura-2-alvaro-es", label: "Alvaro (es)" }, { id: "aura-2-arcas-en", label: "Arcas (en)" }]);
    const eleven = await provider.synthesis.listVoices({ model: "eleven_v3" });
    expect(eleven).toEqual([{ id: "JBFqnCBsd6RMkjVDRZzb", label: "George (multi)" }]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${base}/models`, `${base}/voices`]);
    expect(fetch.mock.calls.every(([, init]) => !init.headers)).toBe(true);
    result[0].id = "changed";
    expect((await provider.synthesis.listVoices({ model: "deepgram_aura_2" }))[0].id).toBe("aura-2-alvaro-es");
  });

  it("filters voices whose language conflicts with the selected model's advertised languages", async () => {
    const prior = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) => url.endsWith("/voices") ? Response.json({ data: [
      ...voices.data,
      { id: "wrong-language", model_id: "tinfoil-voxtral-tts", language: "ja", name: "Wrong" },
      { id: "missing-model", language: "en" }, null,
    ] }) : prior(url, init));
    expect((await provider.synthesis.listVoices({ model: "tinfoil-voxtral-tts" })).map((voice) => voice.id)).toEqual(["neutral_female", "es_female"]);
  });

  it.each(["models", "voices"])("rejects malformed %s discovery and retries on the next call", async (path) => {
    const prior = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) => url.endsWith(`/${path}`) ? Response.json({ invalid: true }) : prior(url, init));
    const discover = () => path === "models" ? provider.transcription.listModels() : provider.synthesis.listVoices({ model: "deepgram_aura_2" });
    await expect(discover()).rejects.toMatchObject({ code: "provider_error" });
    fetch.mockImplementation(prior);
    expect((await discover()).length).toBeGreaterThan(0);
  });

  it("does not use stale model or voice proof after expired discovery fails", async () => {
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await provider.synthesis.listVoices({ model: "deepgram_aura_2" });
    clock.mockReturnValue(now + 60_001);
    fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(provider.synthesize(synthesis())).rejects.toMatchObject({ code: "unavailable" });
    expect(posts()).toEqual([]);
  });

  it("fails closed when the voice catalog expires and cannot refresh", async () => {
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await provider.synthesis.listVoices({ model: "deepgram_aura_2" });
    clock.mockReturnValue(now + 60_001);
    const prior = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) => url.endsWith("/voices") ? Promise.reject(new TypeError("offline")) : prior(url, init));
    await expect(provider.synthesize(synthesis())).rejects.toMatchObject({ code: "unavailable" });
    expect(posts()).toEqual([]);
  });

  it("rejects unavailable models and incompatible voice/model pairs without posting", async () => {
    await expect(provider.transcribe(transcription({ model: "auto" }))).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.synthesize(synthesis({ model: "nova-3" }))).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.synthesize(synthesis({ voice: "neutral_female" }))).rejects.toMatchObject({ code: "unavailable" });
    expect(posts()).toEqual([]);
  });
});

describe("PPQ transcription", () => {
  it.each(["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "video/mp4", "video/webm"])("uploads a complete bounded %s multipart file", async (mediaType) => {
    const input = transcription(); input.audio.mediaType = mediaType;
    const result = await provider.transcribe(input);
    expect(result).toEqual({ model: "nova-3", transcript: { text: "Hello", language: "en" }, usage: { inputSeconds: 1.5 } });
    const [url, init] = posts()[0];
    expect(url).toBe(`${base}/transcriptions`);
    expect(init.headers).toEqual({ Authorization: "Bearer private-ppq-speech-key" });
    expect(init.signal).toBe(input.signal);
    expect([...init.body.keys()]).toEqual(["model", "response_format", "file"]);
    expect(init.body.get("model")).toBe("nova-3");
    expect(init.body.get("response_format")).toBe("json");
    expect(new Uint8Array(await init.body.get("file").arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(input.onDelta).not.toHaveBeenCalled();
  });

  it.each(["en", "ES", "multi"])("forwards the supported %s language hint", async (language) => {
    await provider.transcribe(transcription({ language }));
    expect(posts()[0][1].body.get("language")).toBe(language.toLowerCase());
  });

  it.each(["en-US", "", "not a language"])("refuses an unrepresentable hint %s instead of stripping it", async (language) => {
    await expect(provider.transcribe(transcription({ language }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates byte identity, size, MIME, and explicit keys before discovery or upload", async () => {
    await expect(provider.transcribe(transcription({ apiKey: undefined }))).rejects.toMatchObject({ code: "unavailable" });
    const input = transcription(); input.audio.byteLength = 4;
    await expect(provider.transcribe(input)).rejects.toMatchObject({ code: "invalid_request" });
    input.audio.byteLength = TRANSCRIPTION_INPUT_MAX_BYTES + 1;
    await expect(provider.transcribe(input)).rejects.toMatchObject({ code: "invalid_request" });
    input.audio.mediaType = "audio/ogg";
    await expect(provider.transcribe(input)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, { text: 4 }, { text: " " }])("rejects unusable transcription JSON %j", async (payload) => {
    response = () => Response.json(payload);
    await expect(provider.transcribe(transcription())).rejects.toHaveProperty("code", payload?.text === " " ? "invalid_request" : "provider_error");
  });
  it("rejects invalid JSON and omits invalid duration metadata", async () => {
    response = () => new Response("not JSON");
    await expect(provider.transcribe(transcription())).rejects.toMatchObject({ code: "provider_error" });
    response = () => Response.json({ text: "Hello", duration: -1 });
    expect(await provider.transcribe(transcription())).not.toHaveProperty("usage");
  });
});

describe("PPQ synthesis", () => {
  it("requests MP3 with a model-specific voice and preserves split encoded bytes", async () => {
    response = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(mp3.slice(0, 1)); controller.enqueue(mp3.slice(1, 2));
      controller.enqueue(mp3.slice(2, 100)); controller.enqueue(mp3.slice(100)); controller.close();
    } }), { headers: { "Content-Type": "audio/mpeg" } });
    const input = synthesis({ text: "Hi 😀" });
    const result = await provider.synthesize(input);
    expect(result).toEqual({ model: input.model, audio: { mediaType: "audio/mpeg", byteLength: mp3.length }, usage: { inputCharacters: 4 } });
    const [url, init] = posts()[0];
    expect(url).toBe(`${base}/speech`);
    expect(JSON.parse(init.body)).toEqual({ model: input.model, input: input.text, voice: input.voice, response_format: "mp3" });
    const chunks = input.onAudioDelta.mock.calls.map(([value]) => value);
    expect(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))).toEqual(mp3);
  });

  it.each([
    ["deepgram_aura_2", "aura-2-arcas-en", 2000],
    ["tinfoil-voxtral-tts", "neutral_female", 1200],
    ["eleven_v3", "JBFqnCBsd6RMkjVDRZzb", 3000],
    ["eleven_multilingual_v2", "JBFqnCBsd6RMkjVDRZzb", 4096],
  ])("enforces model-specific and Bridge text bounds for %s", async (model, voice, limit) => {
    await expect(provider.synthesize(synthesis({ model, voice, text: "x".repeat(limit + 1) }))).rejects.toMatchObject({ code: "invalid_request" });
    expect(posts()).toEqual([]);
    expect((await provider.synthesize(synthesis({ model, voice, text: "x".repeat(limit) }))).usage.inputCharacters).toBe(limit);
  });

  it("rejects unsupported output types before discovery or a paid request", async () => {
    await expect(provider.synthesize(synthesis({ mediaType: "audio/wav" }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["audio/wav", "application/json", ""])("cancels responses mislabeled %s before emitting bytes", async (mediaType) => {
    const cancel = vi.fn();
    response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(mp3); }, cancel }), { headers: { "Content-Type": mediaType } });
    const input = synthesis();
    await expect(provider.synthesize(input)).rejects.toMatchObject({ code: "provider_error" });
    expect(input.onAudioDelta).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalled();
  });

  it.each([Uint8Array.of(), Uint8Array.of(1, 2), new TextEncoder().encode('{"error":"failure"}'), new TextEncoder().encode("RIFFWAVE")])("rejects invalid encoded MP3 bytes", async (bytes) => {
    response = () => new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
    const input = synthesis();
    await expect(provider.synthesize(input)).rejects.toMatchObject({ code: "provider_error" });
    expect(input.onAudioDelta).not.toHaveBeenCalled();
  });

  it("enforces the output bound on actual streamed bytes and cancels reading", async () => {
    const cancel = vi.fn();
    response = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(SYNTHESIS_OUTPUT_MAX_BYTES + 1));
    }, cancel }), { headers: { "Content-Type": "audio/mpeg" } });
    const input = synthesis();
    await expect(provider.synthesize(input)).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("byte limit") });
    expect(cancel).toHaveBeenCalled(); expect(input.onAudioDelta).not.toHaveBeenCalled();
  });

  it("rejects oversized Content-Length before reading or emitting bytes", async () => {
    const input = synthesis(); const cancel = vi.fn();
    response = () => new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(SYNTHESIS_OUTPUT_MAX_BYTES + 1) } });
    await expect(provider.synthesize(input)).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("byte limit") });
    expect(cancel).toHaveBeenCalled(); expect(input.onAudioDelta).not.toHaveBeenCalled();
  });

  it("cancels a pending response-body read without late audio delivery", async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    response = () => new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "audio/mpeg" } });
    const input = synthesis({ signal: controller.signal });
    const pending = provider.synthesize(input);
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    controller.abort(); await assertion;
    expect(cancel).toHaveBeenCalled(); expect(input.onAudioDelta).not.toHaveBeenCalled();
  });
});

describe.each(["transcribe", "synthesize"])("PPQ %s errors and cancellation", (method) => {
  const input = () => method === "transcribe" ? transcription() : synthesis();
  it.each([401, 402, 404, 422, 429, 503])("redacts HTTP %s errors without retrying or changing methods", async (status) => {
    response = () => Response.json({ error: { message: "private-ppq-speech-key" } }, { status });
    const error = await provider[method](input()).catch((error) => error);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("private-ppq-speech-key");
    expect(posts()).toHaveLength(1);
  });
  it("aborts before discovery and during the paid fetch", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(provider[method]({ ...input(), signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController(); let reached = false;
    response = (_url, { signal }) => new Promise((_resolve, reject) => {
      reached = true; signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const pending = provider[method]({ ...input(), signal: active.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(reached).toBe(true)); active.abort(); await assertion;
  });
});
