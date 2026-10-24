import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_TRANSCRIBE_MODEL,
  geminiTranscribe,
  geminiTranscription,
  geminiSynthesis,
  geminiSynthesize,
  listGeminiVoices,
} from "../src/providers/gemini-speech.js";

const apiKey = "private-gemini-key";
const base = "https://generativelanguage.googleapis.com";
const file = {
  name: "files/test-audio",
  uri: `${base}/v1beta/files/test-audio`,
  state: "ACTIVE",
};
const transcript = {
  status: "completed",
  model: GEMINI_TRANSCRIBE_MODEL,
  steps: [
    {
      type: "model_output",
      content: [{ type: "text", text: "The sky is blue." }],
    },
  ],
};
function transcribe(extra = {}) {
  return geminiTranscribe({
    apiKey,
    model: GEMINI_TRANSCRIBE_MODEL,
    audio: {
      data: new Blob([Uint8Array.of(1, 2, 3)], { type: "audio/wav" }),
      mediaType: "audio/wav",
      byteLength: 3,
    },
    signal: new AbortController().signal,
    onDelta: vi.fn(),
    ...extra,
  });
}
function wav(dataBytes = 400000, sampleRate = 24000) {
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}
function synthesize(extra = {}) {
  return geminiSynthesize({
    apiKey,
    model: geminiSynthesis.defaultModel,
    text: "Hello 🌎",
    mediaType: "audio/wav",
    signal: new AbortController().signal,
    onAudioDelta: vi.fn(),
    ...extra,
  });
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      if (url === `${base}/upload/v1beta/files`)
        return new Response(null, {
          headers: {
            "x-goog-upload-url": `${base}/upload/v1beta/files?upload_id=test`,
          },
        });
      if (url.includes("upload_id=test")) return Response.json({ file });
      if (url.includes("/voices"))
        return Response.json({
          voices: [
            { id: "kore", display_name: "Kore", type: "prebuilt" },
            { id: "voice_private", type: "replicated" },
          ],
        });
      if (url.includes("/models/"))
        return Response.json({ name: `models/${url.split("/").at(-1)}` });
      if (url.includes("/interactions")) {
        const body = JSON.parse(init.body);
        return Response.json(
          body.model === GEMINI_TRANSCRIBE_MODEL
            ? transcript
            : {
                status: "completed",
                model: body.model,
                steps: [
                  {
                    type: "model_output",
                    content: [
                      {
                        type: "audio",
                        mime_type: "audio/wav",
                        data: wav().toString("base64"),
                      },
                    ],
                  },
                ],
              }
        );
      }
      throw new Error("Unexpected URL");
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Gemini dedicated transcription", () => {
  it("uploads a bounded file, uses verbatim Interactions with language, and deletes the remote file", async () => {
    const onDelta = vi.fn();
    const result = await transcribe({ language: "es-ES", onDelta });
    expect(result).toEqual({
      model: GEMINI_TRANSCRIBE_MODEL,
      transcript: { text: "The sky is blue." },
    });
    expect(onDelta).not.toHaveBeenCalled();
    const upload = fetch.mock.calls[1][1];
    expect(upload.body).toBeInstanceOf(Blob);
    expect(upload.headers["X-Goog-Upload-Command"]).toBe("upload, finalize");
    const body = JSON.parse(fetch.mock.calls[2][1].body);
    expect(body).toMatchObject({
      model: GEMINI_TRANSCRIBE_MODEL,
      store: false,
      input: [{ type: "audio", uri: file.uri, mime_type: "audio/wav" }],
      generation_config: {
        transcription_config: {
          mode: { type: "verbatim" },
          language_codes: ["es-ES"],
        },
      },
    });
    expect(body).not.toHaveProperty("system_instruction");
    expect(fetch.mock.calls.at(-1)[0]).toBe(file.uri);
    expect(fetch.mock.calls.at(-1)[1].method).toBe("DELETE");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
  it("maps M4A MIME without changing the supplied bytes", async () => {
    const data = new Blob(["abc"], { type: "audio/mp4" });
    await transcribe({
      audio: { data, mediaType: "audio/mp4", byteLength: 3 },
    });
    expect(fetch.mock.calls[1][1].body).toBe(data);
    expect(JSON.parse(fetch.mock.calls[2][1].body).input[0].mime_type).toBe(
      "audio/m4a"
    );
  });
  it("rejects video, byte mismatches, invalid hints, and ordinary chat models before network work", async () => {
    await expect(
      transcribe({ model: "gemini-3.8-flash" })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      transcribe({
        audio: {
          data: new Blob(["abc"]),
          mediaType: "video/mp4",
          byteLength: 3,
        },
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      transcribe({
        audio: {
          data: new Blob(["abc"]),
          mediaType: "audio/wav",
          byteLength: 4,
        },
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(transcribe({ language: "invalid_tag" })).rejects.toMatchObject(
      { code: "invalid_request" }
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cleans up after an upstream quota error", async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) =>
      url.endsWith("/interactions")
        ? Response.json(
            { error: { message: "Quota exhausted" } },
            { status: 429 }
          )
        : original(url, init)
    );
    await expect(transcribe()).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("quota"),
    });
    expect(fetch.mock.calls.at(-1)[1].method).toBe("DELETE");
  });
  it("cleans up with a separate signal after cancellation", async () => {
    const controller = new AbortController();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) => {
      if (url.endsWith("/interactions")) {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      }
      return original(url, init);
    });
    await expect(
      transcribe({ signal: controller.signal })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetch.mock.calls.at(-1)[1]).toMatchObject({ method: "DELETE" });
    expect(fetch.mock.calls.at(-1)[1].signal.aborted).toBe(false);
  });
  it("rejects silence and cleans up rather than returning an empty transcript", async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) =>
      url.endsWith("/interactions")
        ? Response.json({ ...transcript, steps: [] })
        : original(url, init)
    );
    await expect(transcribe()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("no transcribable speech"),
    });
    expect(fetch.mock.calls.at(-1)[1].method).toBe("DELETE");
  });
  it("never forwards a key or bytes to an unexpected upload host", async () => {
    fetch.mockResolvedValueOnce(
      new Response(null, {
        headers: { "x-goog-upload-url": "https://evil.example/upload" },
      })
    );
    await expect(transcribe()).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("only discovers the dedicated model and preserves denied-key errors", async () => {
    expect(await geminiTranscription.listModels({ apiKey })).toEqual([
      { id: GEMINI_TRANSCRIBE_MODEL },
    ]);
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Not found" } }, { status: 404 })
    );
    expect(await geminiTranscription.listModels({ apiKey })).toEqual([]);
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Denied" } }, { status: 403 })
    );
    await expect(
      geminiTranscription.listModels({ apiKey })
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("Gemini WAV synthesis", () => {
  it("uses the live prebuilt voice library, including snake-case pagination", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({
        voices: [
          { id: "kore", display_name: "Kore", type: "prebuilt" },
          { id: "Private", type: "prompted" },
        ],
        next_page_token: "next page",
      })
    );
    fetch.mockResolvedValueOnce(
      Response.json({
        voices: [{ id: "Puck", display_name: "Upbeat", type: "prebuilt" }],
      })
    );
    expect(await listGeminiVoices({ apiKey })).toEqual([
      { id: "kore", label: "Kore" },
      { id: "Puck", label: "Upbeat" },
    ]);
    expect(fetch.mock.calls[0][0]).toContain("type=prebuilt");
    expect(fetch.mock.calls[1][0]).toContain("page_token=next%20page");
  });
  it("decodes a single native WAV into bounded chunks with exact bytes and backpressure", async () => {
    const parts = [];
    let active = false;
    const result = await synthesize({
      onAudioDelta: async (bytes) => {
        expect(active).toBe(false);
        active = true;
        await Promise.resolve();
        parts.push(bytes);
        active = false;
      },
    });
    expect(parts.length).toBe(2);
    expect(Buffer.concat(parts)).toEqual(wav());
    expect(result.audio).toEqual({
      mediaType: "audio/wav",
      byteLength: wav().length,
    });
    const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
    expect(body).toMatchObject({
      store: false,
      stream: false,
      response_format: {
        type: "audio",
        mime_type: "audio/wav",
        sample_rate: 24000,
      },
      generation_config: { speech_config: [{ voice: "kore" }] },
    });
    expect(body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Hello 🌎" }] },
    ]);
  });
  it("rejects ordinary chat models, MP3 requests, and unsupported voices", async () => {
    await expect(
      synthesize({ model: "gemini-3.8-flash" })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(synthesize({ mediaType: "audio/mpeg" })).rejects.toMatchObject(
      { code: "unavailable" }
    );
    await expect(synthesize({ voice: "voice_private" })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { mime_type: "audio/l16", data: wav().toString("base64") },
    { mime_type: "audio/wav", data: "!!!=" },
    { mime_type: "audio/wav", data: wav(4, 16000).toString("base64") },
    { mime_type: "audio/wav", data: Buffer.alloc(48).toString("base64") },
    { mime_type: "audio/wav", data: (() => {
      const bytes = Buffer.concat([wav(4), wav(4)]);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      return bytes.toString("base64");
    })() },
    { mime_type: "audio/wav", data: (() => {
      const bytes = Buffer.concat([wav(4), Buffer.from([0])]);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      return bytes.toString("base64");
    })() },
    { mime_type: "audio/wav", data: (() => {
      const bytes = wav(4); bytes.writeUInt16LE(4, 32);
      return bytes.toString("base64");
    })() },
  ])("rejects invalid output before delivering any bytes", async (audio) => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, init) =>
      url.endsWith("/interactions")
        ? Response.json({
            status: "completed",
            steps: [
              { type: "model_output", content: [{ type: "audio", ...audio }] },
            ],
          })
        : original(url, init)
    );
    const onAudioDelta = vi.fn();
    await expect(synthesize({ onAudioDelta })).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(onAudioDelta).not.toHaveBeenCalled();
  });
  it("stops delivering audio chunks when the consumer aborts", async () => {
    const controller = new AbortController();
    const onAudioDelta = vi.fn(() => controller.abort());
    await expect(
      synthesize({ signal: controller.signal, onAudioDelta })
    ).rejects.toMatchObject({ code: "aborted" });
    expect(onAudioDelta).toHaveBeenCalledTimes(1);
  });
});
