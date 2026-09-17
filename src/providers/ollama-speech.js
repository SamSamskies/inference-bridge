import { ensureOllamaOriginBypass } from "../ollama-origin-bypass.js";
import { TRANSCRIPTION_INPUT_MAX_BYTES } from "../speech.js";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_SHOW_URL = `${OLLAMA_BASE_URL}/api/show`;
const OLLAMA_TRANSCRIPTION_URL = `${OLLAMA_BASE_URL}/v1/audio/transcriptions`;

/** Ollama's multipart parser allows 25 MiB; Bridge's lower cap is authoritative. */
export const OLLAMA_MULTIPART_MAX_BYTES = 25 << 20;
export const OLLAMA_TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  "audio/wav",
  "audio/mpeg",
]);

// Ollama exposes only a coarse `audio` capability, not accepted input formats.
// Keep compressed formats fail-closed until a model/runtime combination has
// been exercised against /v1/audio/transcriptions.
export const OLLAMA_MP3_TRANSCRIPTION_MODELS = Object.freeze(["gemma4:e4b"]);

/**
 * Potential media support before the fresh `/api/show` audio-capability probe.
 * @param {string} model
 * @returns {string[]}
 */
export function ollamaTranscriptionMediaTypesForModel(model) {
  const mediaTypes = ["audio/wav"];
  if (OLLAMA_MP3_TRANSCRIPTION_MODELS.includes(model.trim().toLowerCase())) {
    mediaTypes.push("audio/mpeg");
  }
  return mediaTypes;
}

/**
 * Fail-closed model probe. Calls are intentionally not cached: the worker
 * probes while listing and again immediately before upload because local
 * models and the Ollama daemon can change independently.
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [args]
 */
export async function ollamaModelHasAudio(model, { signal } = {}) {
  if (!model) return false;
  await ensureOllamaOriginBypass();
  let response;
  try {
    response = await fetch(OLLAMA_SHOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, name: model }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || /** @type {any} */ (err)?.name === "AbortError") {
      throw inferenceError("aborted", "Request aborted");
    }
    return false;
  }
  if (!response.ok) return false;
  try {
    const payload = await response.json();
    return (
      Array.isArray(payload?.capabilities) &&
      payload.capabilities.includes("audio")
    );
  } catch {
    return false;
  }
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
export async function transcribeOllama(args) {
  if (
    !ollamaTranscriptionMediaTypesForModel(args.model).includes(
      args.audio.mediaType
    )
  ) {
    throw inferenceError(
      "unavailable",
      `Ollama model "${args.model}" cannot transcribe ${args.audio.mediaType} without conversion; WAV is the most compatible input.`
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
  if (args.audio.byteLength >= OLLAMA_MULTIPART_MAX_BYTES) {
    throw inferenceError(
      "invalid_request",
      "Transcription exceeds Ollama's multipart upload limit."
    );
  }
  if (!(await ollamaModelHasAudio(args.model, { signal: args.signal }))) {
    throw inferenceError(
      "unavailable",
      `Ollama model "${args.model}" does not report the required "audio" capability.`
    );
  }

  const body = new FormData();
  body.append("model", args.model);
  body.append("response_format", "json");
  if (args.language) body.append("language", args.language);
  body.append(
    "file",
    args.audio.data,
    args.audio.mediaType === "audio/mpeg" ? "recording.mp3" : "recording.wav"
  );

  let response;
  try {
    response = await fetch(OLLAMA_TRANSCRIPTION_URL, {
      method: "POST",
      body,
      signal: args.signal,
    });
  } catch (err) {
    if (args.signal.aborted || /** @type {any} */ (err)?.name === "AbortError") {
      throw inferenceError("aborted", "Request aborted");
    }
    throw inferenceError(
      "unavailable",
      err instanceof Error
        ? err.message
        : "Network error contacting Ollama. Is it running on localhost:11434?"
    );
  }
  if (!response.ok) {
    throw await mapOllamaError(response);
  }

  const contentType = (response.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  let text = "";
  let language;
  let inputSeconds;
  if (contentType === "text/plain") {
    text = await response.text();
  } else {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw inferenceError(
        "provider_error",
        "Ollama returned malformed transcription JSON."
      );
    }
    text = typeof payload?.text === "string" ? payload.text : "";
    language =
      typeof payload?.language === "string" && payload.language
        ? payload.language
        : undefined;
    inputSeconds =
      finiteNonNegative(payload?.usage?.seconds) ??
      finiteNonNegative(payload?.duration);
  }
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
      ...(language ? { language } : {}),
    },
    ...(inputSeconds !== undefined ? { usage: { inputSeconds } } : {}),
  };
}

async function mapOllamaError(response) {
  let message = "";
  try {
    const payload = await response.json();
    message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.error?.message === "string"
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
    normalized.includes("audio track") ||
    normalized.includes("decode") ||
    normalized.includes("invalid file format") ||
    normalized.includes("unrecognized audio format")
  ) {
    return inferenceError(
      "invalid_request",
      "The media file has no decodable audio track."
    );
  }
  return inferenceError(
    response.status === 404 || response.status >= 500
      ? "unavailable"
      : "provider_error",
    `Ollama transcription failed (${response.status})${message ? `: ${message}` : "."}`
  );
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function inferenceError(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  return error;
}
