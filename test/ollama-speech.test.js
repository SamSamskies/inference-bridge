import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOllamaTranscriptionModels,
  OLLAMA_BASE_URL,
} from "../src/providers/ollama.js";
import {
  OLLAMA_MP3_TRANSCRIPTION_MODELS,
  OLLAMA_MULTIPART_MAX_BYTES,
  OLLAMA_TRANSCRIPTION_MEDIA_TYPES,
  ollamaModelHasAudio,
  ollamaTranscriptionMediaTypesForModel,
  transcribeOllama,
} from "../src/providers/ollama-speech.js";
import { resetOllamaOriginBypassMemoForTests } from "../src/ollama-origin-bypass.js";

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

afterEach(() => {
  resetOllamaOriginBypassMemoForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ollama audio capability", () => {
  it("requires an explicit audio capability from /api/show", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ capabilities: ["completion", "audio"] })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(ollamaModelHasAudio("gemma4:e2b")).resolves.toBe(true);
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
    await expect(ollamaModelHasAudio("text-only")).resolves.toBe(false);
    await expect(ollamaModelHasAudio("malformed")).resolves.toBe(false);
    await expect(ollamaModelHasAudio("offline")).resolves.toBe(false);
  });

  it("filters installed models through individual fresh capability probes", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return jsonResponse({
          models: [{ name: "gemma4:e2b" }, { name: "llama3.2" }],
        });
      }
      const model = JSON.parse(init.body).model;
      return jsonResponse({
        capabilities:
          model === "gemma4:e2b" ? ["completion", "audio"] : ["completion"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listOllamaTranscriptionModels()).resolves.toEqual([
      { id: "gemma4:e2b" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    model: "gemma4:e2b",
    audio: {
      data: new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/wav" }),
      mediaType: "audio/wav",
      byteLength: 3,
    },
    language: "en-US",
    signal: new AbortController().signal,
    onDelta: vi.fn(),
  });

  it("re-checks capability immediately before multipart upload", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["audio"] });
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
    expect(init.body.get("model")).toBe("gemma4:e2b");
    expect(init.body.get("response_format")).toBe("json");
    expect(init.body.get("language")).toBe("en-US");
    const file = init.body.get("file");
    expect(file.name).toBe("recording.wav");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(result).toEqual({
      model: "gemma4:e2b",
      transcript: { text: "Why is the sky blue?", language: "en" },
      usage: { inputSeconds: 5.3 },
    });
  });

  it("normalizes text/plain compatibility responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["audio"] }))
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
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["audio"] }))
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
      message: expect.stringContaining('"audio" capability'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["audio"] }))
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
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["audio"] }))
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
        .mockResolvedValueOnce(jsonResponse({ capabilities: ["audio"] }))
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
