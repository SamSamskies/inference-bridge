import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOllamaSynthesisModels,
  listOllamaTranscriptionModels,
  OLLAMA_BASE_URL,
  ollamaProvider,
} from "../src/providers/ollama.js";
import {
  isOllamaSpeechModel,
  listOllamaSynthesisVoices,
  OLLAMA_MP3_TRANSCRIPTION_MODELS,
  OLLAMA_MULTIPART_MAX_BYTES,
  OLLAMA_SYNTHESIS_DEFAULT_MODEL,
  OLLAMA_SYNTHESIS_DEFAULT_VOICE,
  OLLAMA_SYNTHESIS_MEDIA_TYPES,
  OLLAMA_TRANSCRIPTION_MEDIA_TYPES,
  ollamaModelSupportsSynthesis,
  ollamaModelSupportsTranscription,
  ollamaTranscriptionMediaTypesForModel,
  synthesizeOllama,
  transcribeOllama,
} from "../src/providers/ollama-speech.js";
import { AUDIO_TRANSFER_CHUNK_BYTES } from "../src/speech.js";
import { resetOllamaOriginBypassMemoForTests } from "../src/ollama-origin-bypass.js";

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

afterEach(() => {
  resetOllamaOriginBypassMemoForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ollama transcription capability", () => {
  it("requires explicit audio and completion capabilities from /api/show", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ capabilities: ["completion", "audio"] })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(ollamaModelSupportsTranscription("gemma4:e2b")).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${OLLAMA_BASE_URL}/api/show`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: "gemma4:e2b",
      name: "gemma4:e2b",
    });
  });

  it("fails closed on missing capability, malformed JSON, and network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["vision"] }))
        .mockResolvedValueOnce(new Response("not json"))
        .mockRejectedValueOnce(new TypeError("offline"))
    );
    await expect(ollamaModelSupportsTranscription("text-only")).resolves.toBe(false);
    await expect(ollamaModelSupportsTranscription("malformed")).resolves.toBe(false);
    await expect(ollamaModelSupportsTranscription("offline")).resolves.toBe(false);
  });

  it.each([
    ["embeddinggemma-2:latest", ["embedding", "vision", "audio"]],
    ["custom-audio-encoder", ["embedding", "audio"]],
    ["audio-only", ["audio"]],
    ["audio-decision", ["decision", "audio"]],
  ])("does not offer %s for transcription", async (model, capabilities) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ capabilities })));
    await expect(ollamaModelSupportsTranscription(model)).resolves.toBe(false);
    await expect(
      ollamaProvider.transcription.listAcceptedMediaTypesForModel({ model })
    ).resolves.toEqual([]);
  });

  it("filters installed models through individual fresh capability probes", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return jsonResponse({
          models: [
            { name: "gemma4:e2b" },
            { name: "llama3.2" },
            { name: "embeddinggemma-2:latest" },
            { name: "custom-transcriber" },
          ],
        });
      }
      const model = JSON.parse(init.body).model;
      return jsonResponse({
        capabilities: model === "embeddinggemma-2:latest"
          ? ["embedding", "vision", "audio"]
          : model === "llama3.2"
            ? ["completion"]
            : ["completion", "audio"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listOllamaTranscriptionModels()).resolves.toEqual([
      { id: "custom-transcriber" },
      { id: "gemma4:e2b" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("advertises MP3 only for the verified model while keeping WAV universal", () => {
    expect(OLLAMA_TRANSCRIPTION_MEDIA_TYPES).toEqual([
      "audio/wav",
      "audio/mpeg",
    ]);
    expect(OLLAMA_MP3_TRANSCRIPTION_MODELS).toEqual(["gemma4:e4b"]);
    expect(ollamaTranscriptionMediaTypesForModel("gemma4:e4b")).toEqual([
      "audio/wav",
      "audio/mpeg",
    ]);
    expect(ollamaTranscriptionMediaTypesForModel("GEMMA4:E4B")).toEqual([
      "audio/wav",
      "audio/mpeg",
    ]);
    expect(ollamaTranscriptionMediaTypesForModel("gemma4:e2b-mlx")).toEqual([
      "audio/wav",
    ]);
  });
});

describe("Ollama transcription", () => {
  const request = () => ({
    model: "lfm3-audio:latest",
    audio: {
      data: new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/wav" }),
      mediaType: "audio/wav",
      byteLength: 3,
    },
    language: "en-US",
    signal: new AbortController().signal,
    onDelta: vi.fn(),
  });

  it.each([null, {}, { text: 42 }])("rejects malformed transcript payload %j as provider_error", async (payload) => {
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("/api/show")
      ? jsonResponse({ capabilities: ["completion", "audio"] }) : jsonResponse(payload)));
    await expect(transcribeOllama(request())).rejects.toMatchObject({ code: "provider_error" });
  });

  it("re-checks capability immediately before multipart upload", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["completion", "audio"] });
      }
      return jsonResponse({
        text: "Why is the sky blue?",
        language: "en",
        usage: { seconds: 5.3 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeOllama(request());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${OLLAMA_BASE_URL}/v1/audio/transcriptions`);
    expect(init.body.get("model")).toBe("lfm3-audio:latest");
    expect(init.body.get("response_format")).toBe("json");
    expect(init.body.get("language")).toBe("en-US");
    const file = init.body.get("file");
    expect(file.name).toBe("recording.wav");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(result).toEqual({
      model: "lfm3-audio:latest",
      transcript: { text: "Why is the sky blue?", language: "en" },
      usage: { inputSeconds: 5.3 },
    });
  });

  it("normalizes text/plain compatibility responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "audio"] }))
        .mockResolvedValueOnce(
          new Response("plain transcript", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        )
    );
    await expect(transcribeOllama(request())).resolves.toMatchObject({
      transcript: { text: "plain transcript" },
    });
  });

  it("uploads MP3 for the verified model with an MP3 filename", async () => {
    const mp3 = request();
    mp3.model = "gemma4:e4b";
    mp3.audio = {
      data: new Blob([Uint8Array.from([4, 5, 6])], { type: "audio/mpeg" }),
      mediaType: "audio/mpeg",
      byteLength: 3,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "audio"] }))
      .mockResolvedValueOnce(jsonResponse({ text: "MP3 transcript" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeOllama(mp3)).resolves.toMatchObject({
      transcript: { text: "MP3 transcript" },
    });
    const file = fetchMock.mock.calls[1][1].body.get("file");
    expect(file.name).toBe("recording.mp3");
    expect(file.type).toBe("audio/mpeg");
  });

  it("refuses upload when capability cannot be established", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ capabilities: ["completion"] })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeOllama(request())).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining('"audio" and "completion" capabilities'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a saved audio embedding model before uploading audio", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ capabilities: ["embedding", "vision", "audio"] })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeOllama({
      ...request(),
      model: "embeddinggemma-2:latest",
    })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining('"audio" and "completion" capabilities'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${OLLAMA_BASE_URL}/api/show`);
  });

  it("keeps model-gated media support and lower Bridge limits authoritative", async () => {
    expect(OLLAMA_MULTIPART_MAX_BYTES).toBe(25 << 20);
    const badFormat = request();
    badFormat.audio.mediaType = "audio/mpeg";
    await expect(transcribeOllama(badFormat)).rejects.toMatchObject({
      code: "unavailable",
    });

    const oversized = request();
    oversized.audio.byteLength = 24_000_001;
    await expect(transcribeOllama(oversized)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("maps decoder, no-speech, malformed, and abort failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "audio"] }))
        .mockResolvedValueOnce(
          jsonResponse({ error: "unrecognized audio format" }, 400)
        )
    );
    await expect(transcribeOllama(request())).rejects.toMatchObject({
      code: "invalid_request",
      message: "The media file has no decodable audio track.",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "audio"] }))
        .mockResolvedValueOnce(jsonResponse({ text: "  " }))
    );
    await expect(transcribeOllama(request())).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "audio"] }))
        .mockResolvedValueOnce(
          new Response("not json", {
            headers: { "Content-Type": "application/json" },
          })
        )
    );
    await expect(transcribeOllama(request())).rejects.toMatchObject({
      code: "provider_error",
    });

    const aborted = request();
    aborted.signal = AbortSignal.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      })
    );
    await expect(transcribeOllama(aborted)).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

function pcmWav(dataBytes = 8, { unbounded = false } = {}) {
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, unbounded ? 0xffffffff : bytes.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, unbounded ? 0xffffffff : dataBytes, true);
  return bytes;
}

describe("Ollama synthesis capability", () => {
  it("advertises WAV-only synthesis with Phonon defaults", () => {
    expect(OLLAMA_SYNTHESIS_MEDIA_TYPES).toEqual(["audio/wav"]);
    expect(ollamaProvider.synthesis).toMatchObject({
      defaultModel: OLLAMA_SYNTHESIS_DEFAULT_MODEL,
      defaultVoice: OLLAMA_SYNTHESIS_DEFAULT_VOICE,
      outputMediaTypes: ["audio/wav"],
    });
    expect(typeof ollamaProvider.synthesize).toBe("function");
    expect(isOllamaSpeechModel("phonon")).toBe(true);
    expect(isOllamaSpeechModel("phonon:latest")).toBe(true);
    expect(isOllamaSpeechModel("gemma4:e4b")).toBe(false);
  });

  it("requires the speech capability from /api/show", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const model = JSON.parse(init.body).model;
      return jsonResponse(
        model === "phonon"
          ? { capabilities: ["speech"], voices: ["Zoey"] }
          : { capabilities: ["completion", "audio"] }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ollamaModelSupportsSynthesis("phonon")).resolves.toBe(true);
    await expect(ollamaModelSupportsSynthesis("gemma4:e4b")).resolves.toBe(false);
    await expect(listOllamaSynthesisVoices({ model: "phonon" })).resolves.toEqual([
      { id: "default" },
      { id: "Zoey" },
    ]);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body).verbose).toBe(true);
  });

  it("falls back to verbose voices.* tensors when /api/show omits voices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          capabilities: ["speech"],
          tensors: [
            { name: "flow_lm.bos_emb" },
            { name: "voices.Zoey" },
            { name: "voices.Easton" },
            { name: "voices.default" },
          ],
        })
      )
    );
    await expect(listOllamaSynthesisVoices({ model: "phonon" })).resolves.toEqual([
      { id: "default" },
      { id: "Zoey" },
      { id: "Easton" },
    ]);
  });

  it("prefers the documented voices field over tensor names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          capabilities: ["speech"],
          voices: ["Freya"],
          tensors: [{ name: "voices.Zoey" }],
        })
      )
    );
    await expect(listOllamaSynthesisVoices({ model: "phonon" })).resolves.toEqual([
      { id: "default" },
      { id: "Freya" },
    ]);
  });

  it("filters installed models through individual fresh speech probes", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return jsonResponse({
          models: [{ name: "gemma4:e2b" }, { name: "phonon" }, { name: "custom-tts" }],
        });
      }
      const model = JSON.parse(init.body).model;
      return jsonResponse({
        capabilities: model === "gemma4:e2b" ? ["completion", "audio"] : ["speech"],
        voices: ["default"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listOllamaSynthesisModels()).resolves.toEqual([
      { id: "custom-tts" },
      { id: "phonon" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("excludes speech models from the chat catalog", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return jsonResponse({
          models: [
            { name: "gemma4:e2b" },
            { name: "phonon" },
            { name: "phonon:latest" },
            { name: "custom-tts" },
          ],
        });
      }
      const model = JSON.parse(init.body).model;
      return jsonResponse({
        capabilities: model === "custom-tts" ? ["speech"] : ["completion"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ollamaProvider.listModels()).resolves.toEqual([{ id: "gemma4:e2b" }]);
    await expect(
      ollamaProvider.streamChat({
        model: "custom-tts",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("synthesize"),
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/chat"))
    ).toBe(false);
  });
});

describe("Ollama synthesis", () => {
  const request = (extra = {}) => ({
    model: "phonon",
    voice: "Zoey",
    text: "Hello from Ollama.",
    mediaType: "audio/wav",
    signal: new AbortController().signal,
    onAudioDelta: vi.fn(),
    ...extra,
  });

  it("rewrites streaming WAV sizes then emits bounded PCM fragments", async () => {
    const wav = pcmWav(AUDIO_TRANSFER_CHUNK_BYTES + 4, { unbounded: true });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["speech"], voices: ["Zoey"] });
      }
      return new Response(wav, { headers: { "Content-Type": "audio/wav" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const parts = [];
    const result = await synthesizeOllama(
      request({
        onAudioDelta: (chunk) => parts.push(chunk.slice()),
      })
    );
    const [speechUrl, init] = fetchMock.mock.calls[1];
    expect(speechUrl).toBe(`${OLLAMA_BASE_URL}/v1/audio/speech`);
    expect(JSON.parse(init.body)).toEqual({
      model: "phonon",
      input: "Hello from Ollama.",
      voice: "Zoey",
      response_format: "wav",
    });
    expect(parts.length).toBe(2);
    const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    expect(combined).toEqual(pcmWav(AUDIO_TRANSFER_CHUNK_BYTES + 4));
    expect(result).toEqual({
      model: "phonon",
      audio: { mediaType: "audio/wav", byteLength: wav.byteLength },
      usage: { inputCharacters: 18 },
    });
  });

  it("matches voices without regard to case or accents", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["speech"], voices: ["Freya"] }))
        .mockResolvedValueOnce(new Response(pcmWav(), { headers: { "Content-Type": "audio/wav" } }))
    );
    await expect(
      synthesizeOllama(request({ voice: "fréya", onAudioDelta: vi.fn() }))
    ).resolves.toMatchObject({ audio: { mediaType: "audio/wav" } });
  });

  it("rejects MP3, chat/audio models, and unknown voices before the speech request", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const model = JSON.parse(init.body).model;
      return jsonResponse({
        capabilities: model === "phonon" ? ["speech"] : ["completion", "audio"],
        voices: ["Zoey"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesizeOllama(request({ mediaType: "audio/mpeg" }))).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(synthesizeOllama(request({ model: "gemma4:e4b" }))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining('"speech" capability'),
    });
    await expect(synthesizeOllama(request({ voice: "missing" }))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("voice is unavailable"),
    });
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/api/show"))).toBe(true);
  });

  it("rejects malformed WAV and mismatched media types before emitting audio", async () => {
    const onAudioDelta = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["speech"], voices: ["Zoey"] }))
        .mockResolvedValueOnce(
          new Response(pcmWav(), { headers: { "Content-Type": "audio/mpeg" } })
        )
    );
    await expect(synthesizeOllama(request({ onAudioDelta }))).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(onAudioDelta).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["speech"], voices: ["Zoey"] }))
        .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])))
    );
    await expect(synthesizeOllama(request({ onAudioDelta }))).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
