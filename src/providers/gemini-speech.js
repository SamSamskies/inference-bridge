/** Dedicated Gemini audio models. No chat-as-transcription fallback. */
import {
  AUDIO_TRANSFER_CHUNK_BYTES,
  TRANSCRIPTION_INPUT_MAX_BYTES,
  SYNTHESIS_OUTPUT_MAX_BYTES,
  rawBase64ByteLength,
  countUnicodeCodePoints,
  isStructurallyValidLanguageTag,
} from "../speech.js";
import {
  checkGeminiAbort,
  geminiError,
  geminiFetch,
  geminiJson,
} from "./gemini-api.js";

export const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const GEMINI_TTS_MODELS = Object.freeze([
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
]);
export const GEMINI_TRANSCRIPTION_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
]);

async function discoverAudioModels(ids, args) {
  const result = [];
  for (const id of ids) {
    try {
      const model = await geminiJson(`/v1beta/models/${id}`, args);
      if (model.name !== `models/${id}`)
        throw geminiError(
          "provider_error",
          "Google Gemini returned mismatched model metadata"
        );
      result.push({
        id,
        ...(model.displayName ? { label: model.displayName } : {}),
      });
    } catch (error) {
      if (
        error.code !== "unavailable" ||
        !error.message.includes("model or API availability")
      )
        throw error;
    }
  }
  return result;
}

export const geminiTranscription = Object.freeze({
  defaultModel: GEMINI_TRANSCRIBE_MODEL,
  listModels: (args = {}) =>
    discoverAudioModels([GEMINI_TRANSCRIBE_MODEL], args),
  acceptedMediaTypes: GEMINI_TRANSCRIPTION_TYPES,
  maxInputBytes: TRANSCRIPTION_INPUT_MAX_BYTES,
  validateLanguageHint(language) {
    if (!isStructurallyValidLanguageTag(language))
      throw geminiError("invalid_request", "Invalid BCP 47 language hint");
  },
});

function modelText(interaction) {
  return (interaction.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assertCompleted(interaction) {
  if (interaction.status !== "completed")
    throw geminiError(
      "provider_error",
      `Google Gemini audio interaction ended with status ${interaction.status || "unknown"}`
    );
}

/** Abortable bounded poll; a separate cleanup signal survives user abort. */
async function pauseForFile(signal) {
  checkGeminiAbort(signal);
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(geminiError("aborted", "Request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function geminiTranscribe({
  apiKey,
  model,
  audio,
  language,
  signal,
}) {
  if (model !== GEMINI_TRANSCRIBE_MODEL)
    throw geminiError(
      "unavailable",
      "Select the dedicated Gemini transcription model"
    );
  if (
    !GEMINI_TRANSCRIPTION_TYPES.includes(audio?.mediaType) ||
    !(audio?.data instanceof Blob) ||
    audio.byteLength !== audio.data.size ||
    audio.byteLength <= 0 ||
    audio.byteLength > TRANSCRIPTION_INPUT_MAX_BYTES
  ) {
    throw geminiError(
      "invalid_request",
      "Invalid or unsupported Gemini transcription audio"
    );
  }
  if (language !== undefined)
    geminiTranscription.validateLanguageHint(language);
  const mimeType =
    audio.mediaType === "audio/mp4" ? "audio/m4a" : audio.mediaType;
  let fileName;
  try {
    const start = await geminiFetch("/upload/v1beta/files", {
      apiKey,
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(audio.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({
        file: { display_name: "Inference Bridge transcription" },
      }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl)
      throw geminiError(
        "provider_error",
        "Google Gemini returned no audio upload URL"
      );
    const uploaded = await geminiJson(uploadUrl, {
      apiKey,
      signal,
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: audio.data,
    });
    let file = uploaded.file;
    if (/^files\/[a-zA-Z0-9_-]+$/.test(file?.name)) fileName = file.name;
    if (
      !fileName ||
      file.uri !==
        `https://generativelanguage.googleapis.com/v1beta/${fileName}`
    ) {
      throw geminiError(
        "provider_error",
        "Google Gemini returned an invalid audio file reference"
      );
    }
    for (let polls = 0; file.state === "PROCESSING" && polls < 90; polls++) {
      await pauseForFile(signal);
      file = await geminiJson(`/v1beta/${fileName}`, { apiKey, signal });
    }
    if (file.state && file.state !== "ACTIVE")
      throw geminiError(
        "invalid_request",
        "Google Gemini could not process the audio file. Check its format and audio track."
      );
    if (
      file.name !== fileName ||
      file.uri !==
        `https://generativelanguage.googleapis.com/v1beta/${fileName}`
    )
      throw geminiError(
        "provider_error",
        "Google Gemini returned a mismatched audio file reference"
      );
    const interaction = await geminiJson("/v1beta/interactions", {
      apiKey,
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        input: [{ type: "audio", uri: file.uri, mime_type: mimeType }],
        generation_config: {
          transcription_config: {
            mode: { type: "verbatim" },
            ...(language ? { language_codes: [language] } : {}),
          },
        },
      }),
    });
    checkGeminiAbort(signal);
    assertCompleted(interaction);
    const text = modelText(interaction);
    if (!text.trim())
      throw geminiError(
        "invalid_request",
        "Google Gemini found no transcribable speech. The file may be silent or have no supported audio track."
      );
    return { model: interaction.model || model, transcript: { text } };
  } catch (error) {
    if (
      error.status === 400 &&
      /audio|media|format|codec|duration|track|silence|speech/i.test(
        error.message
      )
    ) {
      throw geminiError("invalid_request", error.message);
    }
    throw error;
  } finally {
    if (fileName) {
      try {
        // Best effort even on abort; never reuse the cancelled request signal.
        await geminiFetch(`/v1beta/${fileName}`, {
          apiKey,
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* Files API expiry is the fallback; see privacy disclosure. */
      }
    }
  }
}

export async function listGeminiVoices(args = {}) {
  const voices = new Map();
  const tokens = new Set();
  let token = "";
  do {
    const page = await geminiJson(
      `/v1beta/voices?type=prebuilt&page_size=1000${token ? `&page_token=${encodeURIComponent(token)}` : ""}`,
      args
    );
    if (!Array.isArray(page.voices))
      throw geminiError(
        "provider_error",
        "Google Gemini returned an invalid voice library"
      );
    for (const voice of page.voices) {
      // Only documented prebuilt voices, never automatically select a user's
      // custom/replicated voice. IDs and metadata come from the live library.
      const id = voice.id;
      if (
        voice.type === "prebuilt" &&
        typeof id === "string" &&
        /^[a-zA-Z0-9_-]+$/.test(id)
      )
        voices.set(id, { id, label: voice.display_name || id });
    }
    token = page.next_page_token || "";
    if (
      token &&
      (typeof token !== "string" || tokens.has(token) || tokens.size >= 100)
    )
      throw geminiError("provider_error", "Invalid Gemini voice pagination");
    tokens.add(token);
  } while (token);
  return [...voices.values()];
}

/** Prepared for IPA #68. Deliberately not advertised until WAV is normative. */
export const geminiSynthesis = Object.freeze({
  defaultModel: GEMINI_TTS_MODELS[0],
  defaultVoice: "kore",
  listModels: (args = {}) => discoverAudioModels(GEMINI_TTS_MODELS, args),
  listVoices: listGeminiVoices,
  outputMediaTypes: Object.freeze(["audio/wav"]),
  maxTextCodePoints: 4096,
  maxOutputBytes: SYNTHESIS_OUTPUT_MAX_BYTES,
});

export async function geminiSynthesize({
  apiKey,
  model,
  voice = "kore",
  text,
  mediaType,
  signal,
  onAudioDelta,
}) {
  if (!GEMINI_TTS_MODELS.includes(model))
    throw geminiError("unavailable", "Select a dedicated Gemini TTS model");
  if (mediaType !== "audio/wav")
    throw geminiError(
      "unavailable",
      "Gemini synthesis requires WAV output (pending IPA #68)"
    );
  if (
    typeof text !== "string" ||
    !text.trim() ||
    countUnicodeCodePoints(text) > 4096
  )
    throw geminiError("invalid_request", "Invalid Gemini synthesis text");
  const voices = await listGeminiVoices({ apiKey, signal });
  if (!voices.some((candidate) => candidate.id === voice))
    throw geminiError(
      "unavailable",
      "Choose an available Gemini prebuilt voice"
    );
  const interaction = await geminiJson("/v1beta/interactions", {
    apiKey,
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      stream: false,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: {
        type: "audio",
        mime_type: "audio/wav",
        sample_rate: 24000,
      },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  checkGeminiAbort(signal);
  assertCompleted(interaction);
  const parts = (interaction.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "audio");
  if (parts.length !== 1 || parts[0].mime_type !== "audio/wav")
    throw geminiError(
      "provider_error",
      "Google Gemini returned an unexpected audio format"
    );
  const size = rawBase64ByteLength(parts[0].data);
  if (size < 44 || size > SYNTHESIS_OUTPUT_MAX_BYTES)
    throw geminiError(
      "provider_error",
      "Google Gemini audio is malformed or exceeds the output limit"
    );
  const bytes = Uint8Array.from(atob(parts[0].data), (character) =>
    character.charCodeAt(0)
  );
  const tag = (offset) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer);
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    throw geminiError(
      "provider_error",
      "Google Gemini returned invalid RIFF/WAVE audio"
    );
  let pcm = false,
    data = false;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length)
      throw geminiError(
        "provider_error",
        "Google Gemini returned a truncated WAV chunk"
      );
    if (tag(offset) === "fmt ")
      pcm =
        length >= 16 &&
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === 24000 &&
        view.getUint16(offset + 22, true) === 16;
    if (tag(offset) === "data") data = length > 0 && length % 2 === 0;
    offset += 8 + length + (length % 2);
  }
  if (!pcm || !data)
    throw geminiError(
      "provider_error",
      "Google Gemini WAV must contain 24 kHz mono 16-bit PCM"
    );
  for (
    let offset = 0;
    offset < bytes.length;
    offset += AUDIO_TRANSFER_CHUNK_BYTES
  ) {
    checkGeminiAbort(signal);
    await onAudioDelta(
      bytes.subarray(offset, offset + AUDIO_TRANSFER_CHUNK_BYTES)
    );
  }
  checkGeminiAbort(signal);
  return {
    model: interaction.model || model,
    audio: { mediaType: "audio/wav", byteLength: bytes.length },
  };
}
