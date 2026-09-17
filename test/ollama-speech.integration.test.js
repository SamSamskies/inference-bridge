import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ollamaModelHasAudio,
  transcribeOllama,
} from "../src/providers/ollama-speech.js";

const enabled = process.env.OLLAMA_SPEECH_INTEGRATION === "1";
const model = process.env.OLLAMA_SPEECH_MODEL || "gemma4:e2b";

describe.skipIf(!enabled)("Ollama speech integration", () => {
  it("transcribes the checked-in 16 kHz mono WAV fixture", async ({ skip }) => {
    const supported = await ollamaModelHasAudio(model);
    if (!supported) {
      skip(`Ollama or an audio-capable ${model} model is unavailable`);
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
});
