import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openRouterMediaTypesForModel,
  openRouterVoicesForModel,
  synthesizeOpenRouter,
  transcribeOpenRouter,
} from "../src/providers/openrouter-speech.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenRouter transcription", () => {
  it("passes original bytes through an OpenAI-compatible multipart request", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn(async () =>
      Response.json({
        text: "hello",
        usage: { seconds: 1.5, input_tokens: 2, output_tokens: 1 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeOpenRouter({
      apiKey: "sk-or-test",
      model: "openai/gpt-transcribe",
      audio: {
        data: new Blob([bytes], { type: "audio/wav" }),
        mediaType: "audio/wav",
        byteLength: bytes.byteLength,
      },
      language: "en-US",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions"
    );
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.body.get("model")).toBe("openai/gpt-transcribe");
    expect(init.body.get("response_format")).toBe("json");
    expect(init.body.get("language")).toBe("en");
    const file = init.body.get("file");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
    expect(result).toEqual({
      model: "openai/gpt-transcribe",
      transcript: { text: "hello" },
      usage: { inputSeconds: 1.5 },
    });
  });

  it("gates video containers and unknown models through a reviewed route map", async () => {
    expect(
      await openRouterMediaTypesForModel({
        model: "openai/gpt-4o-mini-transcribe",
      })
    ).toContain("video/mp4");
    expect(
      await openRouterMediaTypesForModel({ model: "unknown/audio-model" })
    ).toEqual([]);

    const bytes = Uint8Array.from([9, 8]);
    const fetchMock = vi.fn(async () => Response.json({ text: "speech" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeOpenRouter({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini-transcribe",
      audio: {
        data: new Blob([bytes], { type: "video/mp4" }),
        mediaType: "video/mp4",
        byteLength: bytes.byteLength,
      },
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });
    const file = fetchMock.mock.calls[0][1].body.get("file");
    expect(file.name).toBe("recording.mp4");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
  });

  it("fails closed before fetch for unreviewed model and format combinations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      transcribeOpenRouter({
        model: "unknown/audio-model",
        audio: {
          data: new Blob([Uint8Array.of(1)], { type: "audio/wav" }),
          mediaType: "audio/wav",
          byteLength: 1,
        },
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps decoder errors, empty transcripts, and upstream outages", async () => {
    const request = {
      apiKey: "sk-or-test",
      model: "openai/gpt-transcribe",
      audio: {
        data: new Blob([Uint8Array.of(1)], { type: "audio/wav" }),
        mediaType: "audio/wav",
        byteLength: 1,
      },
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "could not decode audio track" } },
          { status: 400 }
        )
      )
    );
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The media file has no decodable audio track.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: " " })));
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "silence detected; no speech found" } },
          { status: 400 }
        )
      )
    );
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "no route available" } },
          { status: 503 }
        )
      )
    );
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "invalid API key" } },
          { status: 401 }
        )
      )
    );
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("OpenRouter synthesis", () => {
  it("keeps model-specific voice catalogs closed", () => {
    expect(
      openRouterVoicesForModel("mistralai/voxtral-mini-tts-2603")
    ).toEqual([{ id: "en_paul_neutral" }]);
    expect(openRouterVoicesForModel("x-ai/grok-voice-tts-1.0")).toEqual([
      { id: "eve" },
      { id: "ara" },
      { id: "rex" },
      { id: "sal" },
      { id: "leo" },
    ]);
    expect(openRouterVoicesForModel("unknown/tts")).toEqual([]);
  });

  it("streams MP3 bytes with backpressure and exact result metadata", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () =>
      new Response(stream, {
        headers: { "Content-Type": "audio/mpeg" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const chunks = [];

    const result = await synthesizeOpenRouter({
      apiKey: "sk-or-test",
      model: "mistralai/voxtral-mini-tts-2603",
      voice: "en_paul_neutral",
      text: "Hi 😀",
      mediaType: "audio/mpeg",
      signal: new AbortController().signal,
      onAudioDelta: async (chunk) => chunks.push([...chunk]),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(JSON.parse(init.body)).toEqual({
      model: "mistralai/voxtral-mini-tts-2603",
      input: "Hi 😀",
      voice: "en_paul_neutral",
      response_format: "mp3",
    });
    expect(chunks).toEqual([[1, 2], [3]]);
    expect(result).toEqual({
      model: "mistralai/voxtral-mini-tts-2603",
      audio: { mediaType: "audio/mpeg", byteLength: 3 },
      usage: { inputCharacters: 4 },
    });
  });

  it("rejects unreviewed voices and non-MP3 responses", async () => {
    const common = {
      model: "mistralai/voxtral-mini-tts-2603",
      text: "hello",
      mediaType: "audio/mpeg",
      signal: new AbortController().signal,
      onAudioDelta: vi.fn(),
    };
    await expect(
      synthesizeOpenRouter({ ...common, voice: "unreviewed" })
    ).rejects.toMatchObject({ code: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(Uint8Array.of(1), {
          headers: { "Content-Type": "audio/pcm" },
        })
      )
    );
    await expect(
      synthesizeOpenRouter({ ...common, voice: "en_paul_neutral" })
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("audio/pcm"),
    });
  });

  it("maps an aborted request to aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      })
    );
    await expect(
      synthesizeOpenRouter({
        apiKey: "sk-or-test",
        model: "mistralai/voxtral-mini-tts-2603",
        voice: "en_paul_neutral",
        text: "hello",
        mediaType: "audio/mpeg",
        signal: controller.signal,
        onAudioDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
