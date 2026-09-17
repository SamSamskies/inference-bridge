import {
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_OUTPUT_MEDIA_TYPE,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
  normalizeTranscriptionMediaType,
} from "../speech.js";

const OPENROUTER_TRANSCRIPTION_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENROUTER_SYNTHESIS_URL =
  "https://openrouter.ai/api/v1/audio/speech";

export const OPENROUTER_TRANSCRIPTION_MODELS = Object.freeze([
  Object.freeze({ id: "openai/gpt-transcribe", label: "OpenAI: GPT Transcribe" }),
  Object.freeze({
    id: "openai/gpt-4o-mini-transcribe",
    label: "OpenAI: GPT-4o Mini Transcribe",
  }),
  Object.freeze({
    id: "openai/gpt-4o-transcribe",
    label: "OpenAI: GPT-4o Transcribe",
  }),
]);

export const OPENROUTER_SYNTHESIS_MODELS = Object.freeze([
  Object.freeze({
    id: "mistralai/voxtral-mini-tts-2603",
    label: "Mistral: Voxtral Mini TTS",
  }),
  Object.freeze({
    id: "x-ai/grok-voice-tts-1.0",
    label: "xAI: Grok Voice TTS 1.0",
  }),
  Object.freeze({
    id: "microsoft/mai-voice-2",
    label: "Microsoft AI: MAI-Voice-2",
  }),
]);

const VOICES_BY_MODEL = Object.freeze({
  "mistralai/voxtral-mini-tts-2603": Object.freeze(["en_paul_neutral"]),
  "x-ai/grok-voice-tts-1.0": Object.freeze([
    "eve",
    "ara",
    "rex",
    "sal",
    "leo",
  ]),
  "microsoft/mai-voice-2": Object.freeze(["en-US-Harper:MAI-Voice-2"]),
});

export const OPENROUTER_TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

/**
 * OpenRouter voices are provider/model-specific and are not exposed in the
 * general model catalog. Keep this reviewed list closed rather than treating
 * a chat/audio modality as proof of a usable voice.
 * @param {string} model
 */
export function openRouterVoicesForModel(model) {
  return (VOICES_BY_MODEL[model] || []).map((id) => ({ id }));
}

/**
 * Video pass-through is enabled only for the curated OpenAI transcription
 * routes whose upstream endpoint accepts MP4/WebM containers.
 * @param {string} model
 */
export async function openRouterMediaTypesForModel({ model }) {
  if (
    !OPENROUTER_TRANSCRIPTION_MODELS.some(
      (candidate) => candidate.id === model
    )
  ) {
    return [];
  }
  return [...OPENROUTER_TRANSCRIPTION_MEDIA_TYPES];
}

/**
 * @param {{
 *   apiKey?: string,
 *   model: string,
 *   audio: { data: Blob, mediaType: string, byteLength: number },
 *   language?: string,
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void | Promise<void>,
 * }} args
 */
export async function transcribeOpenRouter(args) {
  const mediaType = normalizeTranscriptionMediaType(args.audio.mediaType);
  const accepted = await openRouterMediaTypesForModel({ model: args.model });
  if (!mediaType || !accepted.includes(mediaType)) {
    throw inferenceError(
      "unavailable",
      `OpenRouter cannot transcribe ${args.audio.mediaType} without conversion; choose a compatible provider or file.`
    );
  }
  if (
    !(args.audio.data instanceof Blob) ||
    args.audio.data.size !== args.audio.byteLength ||
    args.audio.byteLength <= 0 ||
    args.audio.byteLength > TRANSCRIPTION_INPUT_MAX_BYTES
  ) {
    throw inferenceError("invalid_request", "Invalid transcription audio bytes.");
  }

  const body = new FormData();
  body.append("model", args.model);
  body.append("response_format", "json");
  const language = openRouterLanguageHint(args.language);
  if (args.language && !language) {
    throw inferenceError(
      "unavailable",
      `OpenRouter cannot represent the transcription language hint "${args.language}" as ISO-639-1.`
    );
  }
  if (language) body.append("language", language);
  body.append(
    "file",
    args.audio.data,
    `recording.${extensionForMediaType(mediaType)}`
  );

  let response;
  try {
    response = await fetch(OPENROUTER_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey || ""}` },
      body,
      signal: args.signal,
    });
  } catch (err) {
    throw mapFetchError(err, args.signal);
  }
  if (!response.ok) {
    throw await mapOpenRouterError(response, "transcription");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw inferenceError(
      "provider_error",
      "OpenRouter returned malformed transcription JSON."
    );
  }
  const text =
    payload && typeof payload.text === "string" ? payload.text : "";
  if (!text.trim()) {
    throw inferenceError(
      "invalid_request",
      "No audible speech was detected in the media file."
    );
  }
  const inputSeconds =
    finiteNonNegative(payload?.usage?.seconds) ??
    finiteNonNegative(payload?.duration);
  return {
    model: args.model,
    transcript: {
      text,
      ...(typeof payload.language === "string" && payload.language
        ? { language: payload.language }
        : {}),
    },
    ...(inputSeconds !== undefined ? { usage: { inputSeconds } } : {}),
  };
}

/**
 * @param {{
 *   apiKey?: string,
 *   model: string,
 *   voice: string,
 *   text: string,
 *   mediaType: "audio/mpeg",
 *   signal: AbortSignal,
 *   onAudioDelta: (data: Uint8Array) => void | Promise<void>,
 * }} args
 */
export async function synthesizeOpenRouter(args) {
  if (args.mediaType !== SYNTHESIS_OUTPUT_MEDIA_TYPE) {
    throw inferenceError(
      "unavailable",
      'OpenRouter synthesis currently supports only "audio/mpeg".'
    );
  }
  if (
    !openRouterVoicesForModel(args.model).some(
      (candidate) => candidate.id === args.voice
    )
  ) {
    throw inferenceError(
      "unavailable",
      `OpenRouter synthesis voice is unavailable for ${args.model}: ${args.voice}.`
    );
  }
  if (
    typeof args.text !== "string" ||
    !args.text.trim() ||
    [...args.text].length > SYNTHESIS_TEXT_MAX_CODE_POINTS
  ) {
    throw inferenceError("invalid_request", "Invalid synthesis text.");
  }

  let response;
  try {
    response = await fetch(OPENROUTER_SYNTHESIS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        input: args.text,
        voice: args.voice,
        response_format: "mp3",
      }),
      signal: args.signal,
    });
  } catch (err) {
    throw mapFetchError(err, args.signal);
  }
  if (!response.ok) {
    throw await mapOpenRouterError(response, "synthesis");
  }
  const responseMediaType = (response.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (responseMediaType !== SYNTHESIS_OUTPUT_MEDIA_TYPE) {
    throw inferenceError(
      "provider_error",
      `OpenRouter returned unsupported synthesis media type: ${responseMediaType || "missing"}.`
    );
  }
  if (!response.body) {
    throw inferenceError(
      "provider_error",
      "OpenRouter returned an empty synthesis response."
    );
  }

  const reader = response.body.getReader();
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      byteLength += value.byteLength;
      if (byteLength > SYNTHESIS_OUTPUT_MAX_BYTES) {
        await reader.cancel();
        throw inferenceError(
          "provider_error",
          `OpenRouter synthesis exceeded the ${SYNTHESIS_OUTPUT_MAX_BYTES}-byte output limit.`
        );
      }
      await args.onAudioDelta(value);
    }
  } catch (err) {
    if (args.signal.aborted || /** @type {any} */ (err)?.name === "AbortError") {
      throw inferenceError("aborted", "Request aborted");
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    throw inferenceError(
      "provider_error",
      "OpenRouter returned an empty synthesis response."
    );
  }
  return {
    model: args.model,
    audio: {
      mediaType: SYNTHESIS_OUTPUT_MEDIA_TYPE,
      byteLength,
    },
    usage: { inputCharacters: [...args.text].length },
  };
}

function openRouterLanguageHint(language) {
  if (typeof language !== "string") return "";
  const primary = language.trim().split("-")[0].toLowerCase();
  return /^[a-z]{2}$/.test(primary) ? primary : "";
}

function extensionForMediaType(mediaType) {
  if (mediaType === "audio/mpeg") return "mp3";
  if (mediaType === "audio/mp4") return "m4a";
  if (mediaType === "audio/wav") return "wav";
  if (mediaType === "audio/webm") return "webm";
  if (mediaType === "video/mp4") return "mp4";
  return "webm";
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

async function mapOpenRouterError(response, operation) {
  let message = "";
  try {
    const payload = await response.json();
    message =
      typeof payload?.error?.message === "string"
        ? payload.error.message
        : typeof payload?.message === "string"
          ? payload.message
          : "";
  } catch {
    // use status fallback
  }
  const normalized = message.toLowerCase();
  if (
    operation === "transcription" &&
    (normalized.includes("audio track") ||
      normalized.includes("decode") ||
      normalized.includes("invalid file format") ||
      normalized.includes("corrupt") ||
      normalized.includes("no speech") ||
      normalized.includes("no audible speech") ||
      normalized.includes("silence"))
  ) {
    const noSpeech =
      normalized.includes("no speech") ||
      normalized.includes("no audible speech") ||
      normalized.includes("silence");
    return inferenceError(
      "invalid_request",
      noSpeech
        ? "No audible speech was detected in the media file."
        : "The media file has no decodable audio track."
    );
  }
  const code =
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 429 ||
    response.status >= 500 ||
    (normalized.includes("model") &&
      (normalized.includes("not found") ||
        normalized.includes("does not exist") ||
        normalized.includes("not available")))
      ? "unavailable"
      : "provider_error";
  return inferenceError(
    code,
    `OpenRouter ${operation} failed (${response.status})${message ? `: ${message}` : "."}`
  );
}

function mapFetchError(error, signal) {
  if (signal.aborted || /** @type {any} */ (error)?.name === "AbortError") {
    return inferenceError("aborted", "Request aborted");
  }
  return inferenceError(
    "provider_error",
    error instanceof Error ? error.message : "OpenRouter request failed."
  );
}

function inferenceError(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  return error;
}
