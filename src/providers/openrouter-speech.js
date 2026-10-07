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
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TRANSCRIPTION_MODELS_URL = `${OPENROUTER_MODELS_URL}?output_modalities=transcription`;
const OPENROUTER_SPEECH_MODELS_URL = `${OPENROUTER_MODELS_URL}?output_modalities=speech`;

/** Stable starters until the live catalogs are queried. */
export const OPENROUTER_DEFAULT_TRANSCRIPTION_MODEL = "openai/gpt-transcribe";
export const OPENROUTER_DEFAULT_SYNTHESIS_MODEL =
  "mistralai/voxtral-mini-tts-2603";
export const OPENROUTER_DEFAULT_SYNTHESIS_VOICE = "en_paul_neutral";

const SPEECH_CATALOG_MAX_AGE_MS = 60_000;

/** @type {import("./types.js").ModelInfo[] | null} */
let transcriptionCatalog = null;
let transcriptionCatalogListedAt = 0;
/** @type {import("./types.js").ModelInfo[] | null} */
let synthesisCatalog = null;
let synthesisCatalogListedAt = 0;
/** @type {Map<string, string[]>} */
const voicesByModel = new Map();

export const OPENROUTER_TRANSCRIPTION_AUDIO_MEDIA_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
]);

/** Provider-level union; per-model probing may narrow video away. */
export const OPENROUTER_TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  ...OPENROUTER_TRANSCRIPTION_AUDIO_MEDIA_TYPES,
  "video/mp4",
  "video/webm",
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && v.trim());
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwInference(code, message) {
  throw inferenceError(code, message);
}

/**
 * Read a public model catalog without sending the stored API key.
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function fetchOpenRouterModelEntries(url, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (
      signal?.aborted ||
      (err && /** @type {Error} */ (err).name === "AbortError")
    ) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "unavailable",
      err instanceof Error
        ? err.message
        : "Network error contacting OpenRouter while listing models"
    );
  }

  if (!response.ok) {
    throwInference(
      response.status >= 500 ? "unavailable" : "provider_error",
      `OpenRouter HTTP ${response.status} listing models`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError")
      throwInference("aborted", "Request aborted");
    throwInference(
      "provider_error",
      "OpenRouter returned invalid JSON for /api/v1/models"
    );
  }
  if (signal?.aborted) throwInference("aborted", "Request aborted");

  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * @param {Record<string, any>} entry
 * @param {string} requiredOutput
 * @returns {import("./types.js").ModelInfo | null}
 */
function modelInfoFromEntry(entry, requiredOutput) {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const output = stringList(entry?.architecture?.output_modalities);
  if (!output.includes(requiredOutput)) return null;
  const label =
    typeof entry?.name === "string" && entry.name ? entry.name : undefined;
  /** @type {import("./types.js").ModelInfo} */
  const info = { id };
  if (label) info.label = label;
  const input = stringList(entry?.architecture?.input_modalities);
  if (input.length) info.inputModalities = input;
  if (output.length) info.outputModalities = output;
  return info;
}

/** STT models from the public catalog (`output_modalities=transcription`). */
export async function listOpenRouterTranscriptionModels(args = {}) {
  const entries = await fetchOpenRouterModelEntries(
    OPENROUTER_TRANSCRIPTION_MODELS_URL,
    args
  );
  /** @type {import("./types.js").ModelInfo[]} */
  const models = [];
  for (const entry of entries) {
    const info = modelInfoFromEntry(entry, "transcription");
    if (info) models.push(info);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  transcriptionCatalog = models;
  transcriptionCatalogListedAt = Date.now();
  return models.map((model) => ({ ...model }));
}

/**
 * TTS models from the public catalog (`output_modalities=speech`).
 * Only models with a non-empty `supported_voices` list are offered — Bridge
 * requires a concrete voice id for `/audio/speech`.
 */
export async function listOpenRouterSynthesisModels(args = {}) {
  const entries = await fetchOpenRouterModelEntries(
    OPENROUTER_SPEECH_MODELS_URL,
    args
  );
  /** @type {import("./types.js").ModelInfo[]} */
  const models = [];
  voicesByModel.clear();
  for (const entry of entries) {
    const info = modelInfoFromEntry(entry, "speech");
    if (!info) continue;
    const voices = stringList(entry?.supported_voices);
    if (voices.length === 0) continue;
    voicesByModel.set(info.id, voices);
    models.push(info);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  synthesisCatalog = models;
  synthesisCatalogListedAt = Date.now();
  return models.map((model) => ({ ...model }));
}

/**
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<import("./types.js").VoiceInfo[]>}
 */
export async function openRouterVoicesForModel(model, args = {}) {
  if (!model) return [];
  if (
    !synthesisCatalog ||
    Date.now() - synthesisCatalogListedAt >= SPEECH_CATALOG_MAX_AGE_MS
  ) {
    await listOpenRouterSynthesisModels(args);
  }
  return (voicesByModel.get(model) || []).map((id) => ({ id }));
}

export function resetOpenRouterSpeechCatalogs() {
  transcriptionCatalog = null;
  transcriptionCatalogListedAt = 0;
  synthesisCatalog = null;
  synthesisCatalogListedAt = 0;
  voicesByModel.clear();
}

/**
 * Ensure the transcription catalog is fresh enough for membership checks.
 * @param {{ signal?: AbortSignal }} [args]
 */
async function ensureTranscriptionCatalog(args = {}) {
  if (
    !transcriptionCatalog ||
    Date.now() - transcriptionCatalogListedAt >= SPEECH_CATALOG_MAX_AGE_MS
  ) {
    await listOpenRouterTranscriptionModels(args);
  }
  return transcriptionCatalog || [];
}

/**
 * Audio MIME types for any catalog STT model. Video containers stay limited to
 * OpenAI transcription routes whose upstream endpoints accept MP4/WebM.
 * @param {{ model: string, signal?: AbortSignal, apiKey?: string }} args
 */
export async function openRouterMediaTypesForModel({ model, signal }) {
  const catalog = await ensureTranscriptionCatalog({ signal });
  if (!catalog.some((entry) => entry.id === model)) {
    return [];
  }
  if (typeof model === "string" && model.startsWith("openai/")) {
    return [...OPENROUTER_TRANSCRIPTION_MEDIA_TYPES];
  }
  return [...OPENROUTER_TRANSCRIPTION_AUDIO_MEDIA_TYPES];
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
  const accepted = await openRouterMediaTypesForModel({
    model: args.model,
    signal: args.signal,
  });
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
  const voices = await openRouterVoicesForModel(args.model, {
    signal: args.signal,
  });
  if (!voices.some((candidate) => candidate.id === args.voice)) {
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
