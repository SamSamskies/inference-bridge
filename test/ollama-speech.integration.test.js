import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ollamaModelSupportsSynthesis,
  ollamaModelSupportsTranscription,
  synthesizeOllama,
  transcribeOllama,
} from "../src/providers/ollama-speech.js";

const enabled = process.env.OLLAMA_SPEECH_INTEGRATION === "1";
const model = process.env.OLLAMA_SPEECH_MODEL || "lfm3-audio:latest";

describe.skipIf(!enabled)("Ollama speech integration", () => {
  it("transcribes the checked-in 16 kHz mono WAV fixture", async ({ skip }) => {
    const supported = await ollamaModelSupportsTranscription(model);
    if (!supported) {
      skip(`Ollama or a transcription-capable ${model} model is unavailable`);
    }

    const bytes = await readFile(
      new URL("./fixtures/ollama-why-sky-blue.wav", import.meta.url)
    );
    const result = await transcribeOllama({
      model,
      audio: {
        data: new Blob([bytes], { type: "audio/wav" }),
        mediaType: "audio/wav",
        byteLength: bytes.byteLength,
      },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(result.transcript.text.toLowerCase()).toMatch(/\b(sky|blue)\b/);
  }, 120_000);

  it("synthesizes a native WAV from an installed speech model", async ({ skip }) => {
    const speechModel = process.env.OLLAMA_TTS_MODEL || "phonon";
    const supported = await ollamaModelSupportsSynthesis(speechModel);
    if (!supported) {
      skip(`Ollama or a speech-capable ${speechModel} model is unavailable`);
    }

    const chunks = [];
    const result = await synthesizeOllama({
      model: speechModel,
      voice: process.env.OLLAMA_TTS_VOICE || "default",
      text: "Hello from Inference Bridge.",
      mediaType: "audio/wav",
      signal: new AbortController().signal,
      onAudioDelta: (chunk) => chunks.push(chunk.slice()),
    });
    const bytes = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(result.audio).toEqual({
      mediaType: "audio/wav",
      byteLength: bytes.byteLength,
    });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
  }, 120_000);
});
