import { ensureOllamaOriginBypass } from "../ollama-origin-bypass.js";
import {
  AUDIO_TRANSFER_CHUNK_BYTES,
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
  countUnicodeCodePoints,
} from "../speech.js";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_SHOW_URL = `${OLLAMA_BASE_URL}/api/show`;
const OLLAMA_TRANSCRIPTION_URL = `${OLLAMA_BASE_URL}/v1/audio/transcriptions`;
const OLLAMA_SYNTHESIS_URL = `${OLLAMA_BASE_URL}/v1/audio/speech`;

/** Ollama's multipart parser allows 25 MiB; Bridge's lower cap is authoritative. */
export const OLLAMA_MULTIPART_MAX_BYTES = 25 << 20;
export const OLLAMA_TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  "audio/wav",
  "audio/mpeg",
]);

// Ollama's `audio` capability does not declare accepted input formats.
// Keep compressed formats fail-closed until a model/runtime combination has
// been exercised against /v1/audio/transcriptions.
export const OLLAMA_MP3_TRANSCRIPTION_MODELS = Object.freeze(["gemma4:e4b"]);
export const OLLAMA_SYNTHESIS_MEDIA_TYPES = Object.freeze(["audio/wav"]);
export const OLLAMA_SYNTHESIS_DEFAULT_MODEL = "phonon";
export const OLLAMA_SYNTHESIS_DEFAULT_VOICE = "default";

/**
 * Potential media support before the fresh `/api/show` transcription probe.
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

/** Known Phonon names plus custom names discovered through `/api/show`. */
const speechModelIds = new Set();

/**
 * Phonon and tagged variants are speech-only. Custom names are remembered after
 * a fresh `/api/show` probe reports the `speech` capability.
 * @param {string} model
 */
export function isOllamaSpeechModel(model) {
  return (
    typeof model === "string" &&
    (speechModelIds.has(model) ||
      /^(?:library\/)?phonon(?::[a-zA-Z0-9._-]+)?$/i.test(model))
  );
}

/**
 * Ollama transcription needs both audio input and text generation. Audio
 * embedding models also advertise `audio` but cannot produce a transcript.
 * Calls are intentionally not cached: the worker
 * probes while listing and again immediately before upload because local
 * models and the Ollama daemon can change independently.
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [args]
 */
export async function ollamaModelSupportsTranscription(model, { signal } = {}) {
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
      payload.capabilities.includes("audio") &&
      payload.capabilities.includes("completion")
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
  if (!(await ollamaModelSupportsTranscription(args.model, { signal: args.signal }))) {
    throw inferenceError(
      "unavailable",
      `Ollama model "${args.model}" does not report the required "audio" and "completion" capabilities for transcription. Select an audio-capable text-generation model.`
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
    if (typeof payload?.text !== "string") {
      throw inferenceError("provider_error", "Ollama returned a malformed transcript.");
    }
    text = payload.text;
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

/**
 * Speech models advertise `speech` and fail closed for chat/transcription.
 * Each call hits `/api/show` so local models and the daemon can change
 * independently; a positive result is remembered for chat exclusion.
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [args]
 */
export async function ollamaModelSupportsSynthesis(model, { signal } = {}) {
  const shown = await showOllamaModel(model, { signal });
  const supported = Boolean(shown?.capabilities.includes("speech"));
  if (model) {
    if (supported) speechModelIds.add(model);
    else speechModelIds.delete(model);
  }
  return supported;
}

/**
 * @param {{ model?: string, signal?: AbortSignal }} [args]
 * @returns {Promise<import("./types.js").VoiceInfo[]>}
 */
export async function listOllamaSynthesisVoices({ model, signal } = {}) {
  const shown = await showOllamaModel(model, { signal, verbose: true });
  if (!shown?.capabilities.includes("speech")) return [];
  return voicesFromShow(shown.payload);
}

/**
 * @param {{
 *   model: string,
 *   voice: string,
 *   text: string,
 *   mediaType: "audio/mpeg" | "audio/wav",
 *   signal: AbortSignal,
 *   onAudioDelta: (data: Uint8Array) => void | Promise<void>,
 * }} args
 */
export async function synthesizeOllama(args) {
  if (args.mediaType !== "audio/wav") {
    throw inferenceError(
      "unavailable",
      'Ollama synthesis currently supports only "audio/wav".'
    );
  }
  if (
    typeof args.text !== "string" ||
    !args.text.trim() ||
    countUnicodeCodePoints(args.text) > SYNTHESIS_TEXT_MAX_CODE_POINTS
  ) {
    throw inferenceError("invalid_request", "Invalid synthesis text.");
  }

  const shown = await showOllamaModel(args.model, {
    signal: args.signal,
    verbose: true,
  });
  if (!shown?.capabilities.includes("speech")) {
    throw inferenceError(
      "unavailable",
      `Ollama model "${args.model}" does not report the required "speech" capability. Pull a speech model such as phonon (Ollama 0.40.9+).`
    );
  }
  const voices = voicesFromShow(shown.payload);
  if (!voices.some((candidate) => voicesMatch(candidate.id, args.voice))) {
    throw inferenceError(
      "unavailable",
      `Ollama synthesis voice is unavailable: ${args.voice}.`
    );
  }

  let response;
  try {
    response = await fetch(OLLAMA_SYNTHESIS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        input: args.text,
        voice: args.voice,
        response_format: "wav",
      }),
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
    throw await mapOllamaError(response, "synthesis");
  }
  const responseMediaType = (response.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    responseMediaType &&
    responseMediaType !== "audio/wav" &&
    responseMediaType !== "audio/wave" &&
    responseMediaType !== "audio/x-wav" &&
    responseMediaType !== "application/octet-stream"
  ) {
    throw inferenceError(
      "provider_error",
      `Ollama returned unsupported synthesis media type: ${responseMediaType}.`
    );
  }

  const raw = await readBoundedAudio(response, args.signal);
  const bytes = normalizeOllamaWav(raw);
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += AUDIO_TRANSFER_CHUNK_BYTES
  ) {
    if (args.signal.aborted) {
      throw inferenceError("aborted", "Request aborted");
    }
    await args.onAudioDelta(
      bytes.subarray(offset, offset + AUDIO_TRANSFER_CHUNK_BYTES)
    );
  }
  if (args.signal.aborted) {
    throw inferenceError("aborted", "Request aborted");
  }
  return {
    model: args.model,
    audio: {
      mediaType: "audio/wav",
      byteLength: bytes.byteLength,
    },
    usage: { inputCharacters: countUnicodeCodePoints(args.text) },
  };
}

/**
 * @param {string} model
 * @param {{ signal?: AbortSignal, verbose?: boolean }} [args]
 * @returns {Promise<{ payload: any, capabilities: string[] } | null>}
 */
async function showOllamaModel(model, { signal, verbose } = {}) {
  if (!model) return null;
  await ensureOllamaOriginBypass();
  let response;
  try {
    response = await fetch(OLLAMA_SHOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        name: model,
        ...(verbose ? { verbose: true } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || /** @type {any} */ (err)?.name === "AbortError") {
      throw inferenceError("aborted", "Request aborted");
    }
    return null;
  }
  if (!response.ok) return null;
  try {
    const payload = await response.json();
    return {
      payload,
      capabilities: Array.isArray(payload?.capabilities)
        ? payload.capabilities.filter((entry) => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * @param {any} payload
 * @returns {import("./types.js").VoiceInfo[]}
 */
function voicesFromShow(payload) {
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (typeof id !== "string" || !id.trim()) return;
    const key = normalizeVoiceId(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ids.push(id.trim());
  };
  add(OLLAMA_SYNTHESIS_DEFAULT_VOICE);
  // Documented catalog: POST /api/show → voices. Ollama 0.40.9 omits it
  // even when named speakers are present; verbose tensors still use the
  // same voices.<name> prefix the daemon uses internally.
  const raw = payload?.voices;
  if (Array.isArray(raw) && raw.length > 0) {
    for (const entry of raw) {
      add(
        typeof entry === "string"
          ? entry
          : entry && typeof entry.id === "string"
            ? entry.id
            : entry && typeof entry.name === "string"
              ? entry.name
              : ""
      );
    }
    return ids.map((id) => ({ id }));
  }
  const tensors = Array.isArray(payload?.tensors) ? payload.tensors : [];
  for (const tensor of tensors) {
    const name = typeof tensor === "string" ? tensor : tensor?.name;
    if (typeof name === "string" && name.startsWith("voices.")) {
      add(name.slice("voices.".length));
    }
  }
  return ids.map((id) => ({ id }));
}

function voicesMatch(left, right) {
  const a = normalizeVoiceId(left);
  const b = normalizeVoiceId(right);
  return Boolean(a) && a === b;
}

function normalizeVoiceId(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 */
async function readBoundedAudio(response, signal) {
  if (!response.body) {
    throw inferenceError(
      "provider_error",
      "Ollama returned an empty synthesis response."
    );
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
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
          `Ollama synthesis exceeded the ${SYNTHESIS_OUTPUT_MAX_BYTES}-byte output limit.`
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (signal.aborted || /** @type {any} */ (err)?.name === "AbortError") {
      throw inferenceError("aborted", "Request aborted");
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    throw inferenceError(
      "provider_error",
      "Ollama returned an empty synthesis response."
    );
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Rewrite Ollama's streaming WAV size fields (often 0xFFFFFFFF) and require
 * 24 kHz mono 16-bit PCM so the page receives one complete RIFF/WAVE file.
 * @param {Uint8Array} bytes
 */
function normalizeOllamaWav(bytes) {
  if (bytes.byteLength < 44) {
    throw inferenceError(
      "provider_error",
      "Ollama returned invalid RIFF/WAVE audio"
    );
  }
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const tag = (offset) =>
    String.fromCharCode(...out.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw inferenceError(
      "provider_error",
      "Ollama returned invalid RIFF/WAVE audio"
    );
  }
  view.setUint32(4, out.byteLength - 8, true);
  let pcm = false;
  let data = false;
  let offset = 12;
  while (offset < out.byteLength) {
    if (offset + 8 > out.byteLength || tag(offset) === "RIFF") {
      throw inferenceError(
        "provider_error",
        "Ollama returned invalid WAV chunks"
      );
    }
    let length = view.getUint32(offset + 4, true);
    const remaining = out.byteLength - offset - 8;
    if (length === 0xffffffff || length > remaining) {
      length = remaining;
      view.setUint32(offset + 4, length, true);
    }
    if (offset + 8 + length > out.byteLength) {
      throw inferenceError(
        "provider_error",
        "Ollama returned a truncated WAV chunk"
      );
    }
    if (tag(offset) === "fmt ") {
      if (pcm) {
        throw inferenceError(
          "provider_error",
          "Ollama returned repeated WAV format information"
        );
      }
      pcm =
        length >= 16 &&
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === 24000 &&
        view.getUint32(offset + 16, true) === 48000 &&
        view.getUint16(offset + 20, true) === 2 &&
        view.getUint16(offset + 22, true) === 16;
      if (!pcm) {
        throw inferenceError(
          "provider_error",
          "Ollama WAV must contain 24 kHz mono 16-bit PCM"
        );
      }
    }
    if (tag(offset) === "data") {
      if (!pcm || data || length === 0 || length % 2 !== 0) {
        throw inferenceError(
          "provider_error",
          "Ollama returned invalid WAV audio data"
        );
      }
      data = true;
    }
    offset += 8 + length + (length % 2);
    if (offset > out.byteLength) {
      if (offset - 1 === out.byteLength) break;
      throw inferenceError(
        "provider_error",
        "Ollama returned invalid WAV chunks"
      );
    }
  }
  if (offset !== out.byteLength || !pcm || !data) {
    throw inferenceError(
      "provider_error",
      "Ollama WAV must contain 24 kHz mono 16-bit PCM"
    );
  }
  return out;
}

async function mapOllamaError(response, operation = "transcription") {
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
    normalized.includes("no speech") ||
    normalized.includes("no audible speech") ||
    normalized.includes("silence")
  ) {
    return inferenceError(
      "invalid_request",
      "No audible speech was detected in the media file."
    );
  }
  if (
    normalized.includes("audio track") ||
    normalized.includes("decode") ||
    normalized.includes("invalid file format") ||
    normalized.includes("corrupt") ||
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
    `Ollama ${operation} failed (${response.status})${message ? `: ${message}` : "."}`
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
