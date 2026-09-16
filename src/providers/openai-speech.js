import {
  SYNTHESIS_OUTPUT_MEDIA_TYPE,
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
  normalizeTranscriptionMediaType,
} from "../speech.js";

export const OPENAI_TRANSCRIPTION_MODELS = Object.freeze([
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

export const OPENAI_SYNTHESIS_MODELS = Object.freeze([
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
]);

export const OPENAI_SYNTHESIS_VOICES = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

const OPENAI_LEGACY_SYNTHESIS_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);

/**
 * @param {string} model
 */
export function openAIVoicesForModel(model) {
  const voices =
    model === "tts-1" || model === "tts-1-hd"
      ? OPENAI_SYNTHESIS_VOICES.filter((voice) =>
          OPENAI_LEGACY_SYNTHESIS_VOICES.has(voice)
        )
      : [...OPENAI_SYNTHESIS_VOICES];
  return voices.map((id) => ({ id }));
}

export const OPENAI_TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const SYNTHESIS_URL = "https://api.openai.com/v1/audio/speech";

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
export async function transcribeOpenAI(args) {
  const mediaType = normalizeTranscriptionMediaType(args.audio.mediaType);
  if (
    !mediaType ||
    !OPENAI_TRANSCRIPTION_MEDIA_TYPES.includes(mediaType)
  ) {
    throw inferenceError(
      "unavailable",
      `OpenAI cannot transcribe ${args.audio.mediaType} without conversion; choose a compatible provider or file.`
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
  if (args.language) body.append("language", args.language);
  body.append(
    "file",
    args.audio.data,
    `recording.${extensionForMediaType(mediaType)}`
  );

  let response;
  try {
    response = await fetch(TRANSCRIPTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey || ""}`,
      },
      body,
      signal: args.signal,
    });
  } catch (err) {
    throw mapFetchError(err, args.signal);
  }
  if (!response.ok) {
    throw await mapOpenAIError(response, "transcription");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw inferenceError(
      "provider_error",
      "OpenAI returned malformed transcription JSON."
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
  return {
    model: args.model,
    transcript: {
      text,
      ...(typeof payload.language === "string" && payload.language
        ? { language: payload.language }
        : {}),
    },
    ...(typeof payload.duration === "number" &&
    Number.isFinite(payload.duration)
      ? { usage: { inputSeconds: payload.duration } }
      : {}),
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
export async function synthesizeOpenAI(args) {
  if (args.mediaType !== SYNTHESIS_OUTPUT_MEDIA_TYPE) {
    throw inferenceError(
      "unavailable",
      'OpenAI synthesis currently supports only "audio/mpeg".'
    );
  }
  if (
    !openAIVoicesForModel(args.model).some(
      (candidate) => candidate.id === args.voice
    )
  ) {
    throw inferenceError(
      "unavailable",
      `OpenAI synthesis voice is unavailable: ${args.voice}.`
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
    response = await fetch(SYNTHESIS_URL, {
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
    throw await mapOpenAIError(response, "synthesis");
  }
  const responseMediaType = (response.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (responseMediaType && responseMediaType !== SYNTHESIS_OUTPUT_MEDIA_TYPE) {
    throw inferenceError(
      "provider_error",
      `OpenAI returned unsupported synthesis media type: ${responseMediaType}.`
    );
  }
  if (!response.body) {
    throw inferenceError(
      "provider_error",
      "OpenAI returned an empty synthesis response."
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
          `OpenAI synthesis exceeded the ${SYNTHESIS_OUTPUT_MAX_BYTES}-byte output limit.`
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
      "OpenAI returned an empty synthesis response."
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

function extensionForMediaType(mediaType) {
  if (mediaType === "audio/mpeg") return "mp3";
  if (mediaType === "audio/mp4") return "m4a";
  if (mediaType === "audio/wav") return "wav";
  if (mediaType === "audio/webm") return "webm";
  if (mediaType === "video/mp4") return "mp4";
  return "webm";
}

async function mapOpenAIError(response, operation) {
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
    try {
      message = await response.text();
    } catch {
      // use status fallback
    }
  }
  const normalized = message.toLowerCase();
  if (
    operation === "transcription" &&
    (normalized.includes("audio track") ||
      normalized.includes("decode") ||
      normalized.includes("invalid file format"))
  ) {
    return inferenceError(
      "invalid_request",
      "The media file has no decodable audio track."
    );
  }
  return inferenceError(
    "provider_error",
    `OpenAI ${operation} failed (${response.status})${message ? `: ${message}` : "."}`
  );
}

function mapFetchError(error, signal) {
  if (signal.aborted || /** @type {any} */ (error)?.name === "AbortError") {
    return inferenceError("aborted", "Request aborted");
  }
  return inferenceError(
    "provider_error",
    error instanceof Error ? error.message : "OpenAI request failed."
  );
}

function inferenceError(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  return error;
}
