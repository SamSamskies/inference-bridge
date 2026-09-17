import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openAIVoicesForModel,
  synthesizeOpenAI,
  transcribeOpenAI,
} from "../src/providers/openai-speech.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI transcription", () => {
  it("uploads the original Blob with operation-specific multipart fields", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn(async () =>
      Response.json({
        text: "hello world",
        language: "en",
        duration: 1.25,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeOpenAI({
      apiKey: "sk-test",
      model: "gpt-4o-transcribe",
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
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("model")).toBe("gpt-4o-transcribe");
    expect(init.body.get("response_format")).toBe("json");
    expect(init.body.get("stream")).toBe("true");
    expect(init.body.get("language")).toBe("en-US");
    const file = init.body.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
    expect(result).toEqual({
      model: "gpt-4o-transcribe",
      transcript: { text: "hello world", language: "en" },
      usage: { inputSeconds: 1.25 },
    });
  });

  it("emits append-only deltas and returns the final streaming transcript", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        [
          "event: transcript.text.delta",
          'data: {"type":"transcript.text.delta","delta":"hello "}',
          "",
          "event: transcript.text.delta",
          'data: {"type":"transcript.text.delta","delta":"world"}',
          "",
          "event: transcript.text.done",
          'data: {"type":"transcript.text.done","text":"hello world","languages":[{"code":"en"}]}',
          "",
          "",
        ].join("\n"),
        { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const deltas = [];

    const result = await transcribeOpenAI({
      apiKey: "sk-test",
      model: "gpt-transcribe",
      audio: {
        data: new Blob([Uint8Array.of(1)], { type: "audio/wav" }),
        mediaType: "audio/wav",
        byteLength: 1,
      },
      signal: new AbortController().signal,
      onDelta: (content) => deltas.push(content),
    });

    expect(deltas).toEqual(["hello ", "world"]);
    expect(deltas.join("")).toBe(result.transcript.text);
    expect(result).toEqual({
      model: "gpt-transcribe",
      transcript: { text: "hello world", language: "en" },
    });
  });

  it("passes supported video containers through unchanged", async () => {
    const bytes = Uint8Array.from([9, 8, 7]);
    const fetchMock = vi.fn(async () => Response.json({ text: "speech" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeOpenAI({
      apiKey: "sk-test",
      model: "gpt-4o-transcribe",
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

  it("maps empty transcripts and decoder failures to actionable invalid_request errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "  " })));
    await expect(
      transcribeOpenAI({
        apiKey: "sk-test",
        model: "gpt-4o-transcribe",
        audio: {
          data: new Blob([Uint8Array.of(1)], { type: "audio/wav" }),
          mediaType: "audio/wav",
          byteLength: 1,
        },
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "No audible speech was detected in the media file.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "could not decode audio track" } },
          { status: 400 }
        )
      )
    );
    await expect(
      transcribeOpenAI({
        apiKey: "sk-test",
        model: "gpt-4o-transcribe",
        audio: {
          data: new Blob([Uint8Array.of(1)], { type: "video/mp4" }),
          mediaType: "video/mp4",
          byteLength: 1,
        },
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "The media file has no decodable audio track.",
    });
  });

  it("fails closed on unsupported media and malformed responses", async () => {
    await expect(
      transcribeOpenAI({
        model: "gpt-4o-transcribe",
        audio: {
          data: new Blob([Uint8Array.of(1)]),
          mediaType: "audio/ogg",
          byteLength: 1,
        },
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 }))
    );
    await expect(
      transcribeOpenAI({
        model: "gpt-4o-transcribe",
        audio: {
          data: new Blob([Uint8Array.of(1)], { type: "audio/wav" }),
          mediaType: "audio/wav",
          byteLength: 1,
        },
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("OpenAI synthesis", () => {
  it("uses model-specific curated voice catalogs", () => {
    expect(
      openAIVoicesForModel("gpt-4o-mini-tts").map((voice) => voice.id)
    ).toContain("marin");
    expect(openAIVoicesForModel("tts-1").map((voice) => voice.id)).not.toContain(
      "marin"
    );
  });

  it("streams response bytes with backpressure and returns exact metadata", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
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

    const result = await synthesizeOpenAI({
      apiKey: "sk-test",
      model: "gpt-4o-mini-tts",
      voice: "coral",
      text: "Hi 😀",
      mediaType: "audio/mpeg",
      signal: new AbortController().signal,
      onAudioDelta: async (chunk) => {
        chunks.push([...chunk]);
      },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Hi 😀",
      voice: "coral",
      response_format: "mp3",
    });
    expect(chunks).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
    expect(result).toEqual({
      model: "gpt-4o-mini-tts",
      audio: { mediaType: "audio/mpeg", byteLength: 5 },
      usage: { inputCharacters: 4 },
    });
  });

  it("rejects unknown voices, malformed formats, and empty bodies", async () => {
    const common = {
      model: "gpt-4o-mini-tts",
      text: "hello",
      signal: new AbortController().signal,
      onAudioDelta: vi.fn(),
    };
    await expect(
      synthesizeOpenAI({
        ...common,
        voice: "custom",
        mediaType: "audio/mpeg",
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      synthesizeOpenAI({
        ...common,
        voice: "alloy",
        mediaType: "audio/wav",
      })
    ).rejects.toMatchObject({ code: "unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null)));
    await expect(
      synthesizeOpenAI({
        ...common,
        voice: "alloy",
        mediaType: "audio/mpeg",
      })
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("maps upstream and aborted requests to IPA-style errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "invalid voice" } },
          { status: 400 }
        )
      )
    );
    await expect(
      synthesizeOpenAI({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        text: "hello",
        mediaType: "audio/mpeg",
        signal: new AbortController().signal,
        onAudioDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "provider_error" });

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
      synthesizeOpenAI({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        text: "hello",
        mediaType: "audio/mpeg",
        signal: controller.signal,
        onAudioDelta: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
