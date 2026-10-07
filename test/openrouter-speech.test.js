import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listOpenRouterSynthesisModels,
  listOpenRouterTranscriptionModels,
  openRouterMediaTypesForModel,
  openRouterVoicesForModel,
  resetOpenRouterSpeechCatalogs,
  synthesizeOpenRouter,
  transcribeOpenRouter,
} from "../src/providers/openrouter-speech.js";

const TRANSCRIPTION_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription";
const SPEECH_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=speech";

const transcriptionCatalog = {
  data: [
    {
      id: "openai/gpt-transcribe",
      name: "OpenAI: GPT Transcribe",
      architecture: {
        input_modalities: ["audio"],
        output_modalities: ["transcription"],
      },
    },
    {
      id: "openai/gpt-4o-mini-transcribe",
      name: "OpenAI: GPT-4o Mini Transcribe",
      architecture: {
        input_modalities: ["audio"],
        output_modalities: ["transcription"],
      },
    },
    {
      id: "elevenlabs/scribe-v2",
      name: "ElevenLabs: Scribe v2",
      architecture: {
        input_modalities: ["audio"],
        output_modalities: ["transcription"],
      },
    },
  ],
};

const speechCatalog = {
  data: [
    {
      id: "mistralai/voxtral-mini-tts-2603",
      name: "Mistral: Voxtral Mini TTS",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["speech"],
      },
      supported_voices: ["en_paul_neutral", "en_paul_happy"],
    },
    {
      id: "x-ai/grok-voice-tts-1.0",
      name: "xAI: Grok Voice TTS 1.0",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["speech"],
      },
      supported_voices: ["eve", "ara", "rex", "sal", "leo"],
    },
    {
      id: "elevenlabs/eleven-v4",
      name: "ElevenLabs: Eleven v4",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["speech"],
      },
      supported_voices: ["george", "sarah"],
    },
    {
      id: "bytedance-seed/seed-audio-1-0",
      name: "ByteDance Seed: Seed Audio 1.0",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["speech"],
      },
      supported_voices: null,
    },
  ],
};

/**
 * @param {(
 *   url: string,
 *   init?: RequestInit
 * ) => Response | Promise<Response> | undefined} [handler]
 * Handler may return a Response to override, or undefined to use catalog defaults.
 */
function stubFetch(handler) {
  const fetchMock = vi.fn(async (url, init) => {
    const href = String(url);
    const custom = handler ? await handler(href, init) : undefined;
    if (custom !== undefined) return custom;
    if (href === TRANSCRIPTION_CATALOG_URL) {
      return Response.json(transcriptionCatalog);
    }
    if (href === SPEECH_CATALOG_URL) {
      return Response.json(speechCatalog);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetOpenRouterSpeechCatalogs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetOpenRouterSpeechCatalogs();
});

describe("OpenRouter speech catalogs", () => {
  it("lists transcription models from output_modalities=transcription", async () => {
    const fetchMock = stubFetch();
    const models = await listOpenRouterTranscriptionModels();
    expect(fetchMock).toHaveBeenCalledWith(
      TRANSCRIPTION_CATALOG_URL,
      expect.anything()
    );
    expect(models.map((model) => model.id)).toEqual([
      "elevenlabs/scribe-v2",
      "openai/gpt-4o-mini-transcribe",
      "openai/gpt-transcribe",
    ]);
  });

  it("lists synthesis models with voices and drops voice-less entries", async () => {
    stubFetch();
    const models = await listOpenRouterSynthesisModels();
    expect(models.map((model) => model.id)).toEqual([
      "elevenlabs/eleven-v4",
      "mistralai/voxtral-mini-tts-2603",
      "x-ai/grok-voice-tts-1.0",
    ]);
    expect(await openRouterVoicesForModel("elevenlabs/eleven-v4")).toEqual([
      { id: "george" },
      { id: "sarah" },
    ]);
    expect(
      await openRouterVoicesForModel("bytedance-seed/seed-audio-1-0")
    ).toEqual([]);
    expect(await openRouterVoicesForModel("unknown/tts")).toEqual([]);
  });
});

describe("OpenRouter transcription", () => {
  it("passes original bytes through an OpenAI-compatible multipart request", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json({
          text: "hello",
          usage: { seconds: 1.5, input_tokens: 2, output_tokens: 1 },
        });
      }
    });

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

    const transcriptionCall = fetchMock.mock.calls.find(
      ([url]) =>
        String(url) === "https://openrouter.ai/api/v1/audio/transcriptions"
    );
    expect(transcriptionCall).toBeTruthy();
    const [, init] = transcriptionCall;
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

  it("allows video only on OpenAI transcription routes from the live catalog", async () => {
    stubFetch();
    expect(
      await openRouterMediaTypesForModel({
        model: "openai/gpt-4o-mini-transcribe",
      })
    ).toContain("video/mp4");
    expect(
      await openRouterMediaTypesForModel({ model: "elevenlabs/scribe-v2" })
    ).toEqual(["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"]);
    expect(
      await openRouterMediaTypesForModel({ model: "unknown/audio-model" })
    ).toEqual([]);

    const bytes = Uint8Array.from([9, 8]);
    const fetchMock = stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json({ text: "speech" });
      }
    });
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
    const transcriptionCall = fetchMock.mock.calls.find(
      ([url]) =>
        String(url) === "https://openrouter.ai/api/v1/audio/transcriptions"
    );
    const file = transcriptionCall[1].body.get("file");
    expect(file.name).toBe("recording.mp4");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
  });

  it("fails closed before fetch for models outside the transcription catalog", async () => {
    const fetchMock = stubFetch();
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
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url) === "https://openrouter.ai/api/v1/audio/transcriptions"
      )
    ).toBe(false);
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
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json(
          { error: { message: "could not decode audio track" } },
          { status: 400 }
        );
      }
    });
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The media file has no decodable audio track.",
    });

    resetOpenRouterSpeechCatalogs();
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json({ text: " " });
      }
    });
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    resetOpenRouterSpeechCatalogs();
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json(
          { error: { message: "silence detected; no speech found" } },
          { status: 400 }
        );
      }
    });
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    resetOpenRouterSpeechCatalogs();
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json(
          { error: { message: "no route available" } },
          { status: 503 }
        );
      }
    });
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "unavailable",
    });

    resetOpenRouterSpeechCatalogs();
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
        return Response.json(
          { error: { message: "invalid API key" } },
          { status: 401 }
        );
      }
    });
    await expect(transcribeOpenRouter(request)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("OpenRouter synthesis", () => {
  it("streams MP3 bytes with backpressure and exact result metadata", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });
    const fetchMock = stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/speech") {
        return new Response(stream, {
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
    });
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

    const speechCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "https://openrouter.ai/api/v1/audio/speech"
    );
    expect(speechCall).toBeTruthy();
    expect(JSON.parse(speechCall[1].body)).toEqual({
      model: "mistralai/voxtral-mini-tts-2603",
      input: "Hi 😀",
      voice: "en_paul_neutral",
      response_format: "mp3",
    });
    expect(chunks).toEqual([
      [1, 2],
      [3],
    ]);
    expect(result).toEqual({
      model: "mistralai/voxtral-mini-tts-2603",
      audio: { mediaType: "audio/mpeg", byteLength: 3 },
      usage: { inputCharacters: 4 },
    });
  });

  it("rejects unknown voices and non-MP3 responses", async () => {
    stubFetch();
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

    resetOpenRouterSpeechCatalogs();
    stubFetch(async (url) => {
      if (url === "https://openrouter.ai/api/v1/audio/speech") {
        return new Response(Uint8Array.of(1), {
          headers: { "Content-Type": "audio/pcm" },
        });
      }
    });
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
    stubFetch(async (url) => {
      if (url === SPEECH_CATALOG_URL) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    });
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
