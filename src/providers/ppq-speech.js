/** Dedicated bounded PPQ STT/TTS transports. No chat emulation or transcoding. */
import {
  SYNTHESIS_OUTPUT_MAX_BYTES, SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES, TRANSCRIPTION_MEDIA_TYPES,
  countUnicodeCodePoints, isValidSynthesisText, normalizeTranscriptionMediaType,
} from "../speech.js";
import { normalizeProviderError, readProviderErrorDetail } from "./provider-error.js";
import {
  PPQ_DEFAULT_TRANSCRIPTION_MODEL, PPQ_DEFAULT_SYNTHESIS_MODEL, PPQ_DEFAULT_SYNTHESIS_VOICE,
  listPPQTranscriptionModels, listPPQSynthesisModels, listPPQVoices, requirePPQSpeechModel,
} from "./ppq-speech-catalog.js";

const BASE = "https://api.ppq.ai/v1/audio";
function fail(code, message) {
  throw Object.assign(new Error(message), { name: "InferenceError", code });
}
function checkAbort(signal) { if (signal?.aborted) fail("aborted", "Request aborted"); }
function requireKey(apiKey) { if (!apiKey?.trim()) fail("unavailable", "PayPerQ API key not configured. Add it in Options."); }

/** PPQ accepts ISO 639-1 or multi, rather than arbitrary BCP 47 subtags. */
export function ppqLanguageHint(language) {
  if (typeof language !== "string" || !/^(?:[a-z]{2}|multi)$/i.test(language)) {
    fail("unavailable", "PayPerQ transcription needs a two-letter language code or multi; omit the hint for detection, or choose another provider.");
  }
  return language.toLowerCase();
}

async function speechFetch(path, options, signal) {
  checkAbort(signal);
  let response;
  try { response = await fetch(`${BASE}/${path}`, { ...options, signal }); }
  catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("unavailable", `Unable to contact PayPerQ for ${path}: ${cause instanceof Error ? cause.message : "network error"}`);
  }
  checkAbort(signal);
  if (!response.ok) {
    const detail = await readProviderErrorDetail(response, `PayPerQ HTTP ${response.status}`);
    checkAbort(signal);
    const status = response.status;
    const code = status === 404 || status >= 500 ? "unavailable"
      : [400, 413, 415, 422].includes(status) ? "invalid_request" : "provider_error";
    const hint = status === 401 || status === 403 ? "Check your PayPerQ API key in Options."
      : status === 402 ? "Check your PayPerQ balance and API-key spending limit."
        : status === 429 ? "PayPerQ rate limit reached. Retry later."
          : status === 404 ? "Refresh the audio catalog and choose an available model."
            : path === "speech" ? "Check the selected model, voice, text length, and output format."
              : "Check the audio format, language, and whether the file contains a decodable speech track.";
    fail(code, `${detail.slice(0, 800)} ${hint}`);
  }
  return response;
}

export async function ppqTranscriptionMediaTypes({ model, signal } = {}) {
  await requirePPQSpeechModel("transcribe", model, { signal });
  return [...TRANSCRIPTION_MEDIA_TYPES];
}

export async function transcribePPQ(args) {
  try {
    checkAbort(args.signal);
    requireKey(args.apiKey);
    const mediaType = normalizeTranscriptionMediaType(args.audio?.mediaType);
    if (!mediaType) fail("unavailable", "PayPerQ cannot transcribe this media type without conversion.");
    if (!(args.audio.data instanceof Blob) || args.audio.data.size !== args.audio.byteLength ||
        !Number.isSafeInteger(args.audio.byteLength) || args.audio.byteLength <= 0 || args.audio.byteLength > TRANSCRIPTION_INPUT_MAX_BYTES) {
      fail("invalid_request", "Invalid transcription audio bytes or input exceeds the Bridge 24 MB limit.");
    }
    const language = args.language === undefined ? undefined : ppqLanguageHint(args.language);
    await requirePPQSpeechModel("transcribe", args.model, { signal: args.signal });
    const extensions = { "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/webm": "webm", "video/mp4": "mp4", "video/webm": "webm" };
    const body = new FormData();
    body.append("model", args.model);
    body.append("response_format", "json");
    if (language) body.append("language", language);
    body.append("file", args.audio.data, `recording.${extensions[mediaType]}`);
    const response = await speechFetch("transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${args.apiKey}` }, body,
    }, args.signal);
    let payload;
    try { payload = await response.json(); }
    catch { checkAbort(args.signal); fail("provider_error", "PayPerQ returned malformed transcription JSON."); }
    checkAbort(args.signal);
    if (typeof payload?.text !== "string") fail("provider_error", "PayPerQ returned a malformed transcript.");
    if (!payload.text.trim()) fail("invalid_request", "No audible speech was detected in the media file.");
    const seconds = payload.usage?.seconds ?? payload.duration;
    return {
      model: args.model,
      transcript: { text: payload.text, ...(typeof payload.language === "string" && payload.language ? { language: payload.language } : {}) },
      ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? { usage: { inputSeconds: seconds } } : {}),
    };
  } catch (cause) { throw normalizeProviderError(cause, args); }
}

/** Reject obvious non-MP3 responses before exposing any binary bytes. */
function mp3Prefix(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) === 0x02 && (bytes[1] & 0x18) !== 0x08);
}

async function streamMP3(response, args) {
  const mediaType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "audio/mpeg") {
    try { await response.body?.cancel(); } catch { /* preserve format error */ }
    fail("provider_error", "PayPerQ did not return the requested MP3 audio (audio/mpeg). Try a compatible synthesis model.");
  }
  if (Number(response.headers.get("Content-Length")) > SYNTHESIS_OUTPUT_MAX_BYTES) {
    try { await response.body?.cancel(); } catch { /* preserve byte-limit error */ }
    fail("provider_error", "PayPerQ synthesis exceeded the Bridge output byte limit.");
  }
  if (!response.body) fail("provider_error", "PayPerQ returned an empty synthesis response.");
  const reader = response.body.getReader();
  const prefix = new Uint8Array(3);
  let prefixLength = 0, byteLength = 0, verified = false, finished = false;
  const pending = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  args.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      checkAbort(args.signal);
      const { value, done } = await reader.read();
      checkAbort(args.signal);
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array) || !value.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > SYNTHESIS_OUTPUT_MAX_BYTES) fail("provider_error", "PayPerQ synthesis exceeded the Bridge output byte limit.");
      if (!verified) {
        pending.push(value);
        const count = Math.min(3 - prefixLength, value.byteLength);
        prefix.set(value.subarray(0, count), prefixLength);
        prefixLength += count;
        if (prefixLength < 3) continue;
        if (!mp3Prefix(prefix)) fail("provider_error", "PayPerQ returned invalid MP3 bytes for speech synthesis.");
        verified = true;
        for (const chunk of pending) { checkAbort(args.signal); await args.onAudioDelta(chunk); }
        pending.length = 0;
      } else await args.onAudioDelta(value);
    }
    checkAbort(args.signal);
    if (!verified || !byteLength) fail("provider_error", "PayPerQ returned empty or invalid MP3 audio.");
    return byteLength;
  } finally {
    args.signal?.removeEventListener("abort", abort);
    if (!finished) { try { await reader.cancel(); } catch { /* preserve original error */ } }
    reader.releaseLock();
  }
}

export async function synthesizePPQ(args) {
  try {
    checkAbort(args.signal);
    requireKey(args.apiKey);
    if (args.mediaType !== "audio/mpeg") fail("unavailable", "PayPerQ synthesis currently supports MP3 (audio/mpeg) only.");
    if (!isValidSynthesisText(args.text)) fail("invalid_request", "Invalid synthesis text or text exceeds the Bridge limit.");
    const model = await requirePPQSpeechModel("synthesize", args.model, { signal: args.signal });
    const inputCharacters = countUnicodeCodePoints(args.text);
    if (inputCharacters > model.maxText) fail("invalid_request", `This PayPerQ synthesis model accepts at most ${model.maxText} characters per request. Shorten the text or choose another model.`);
    const voices = await listPPQVoices({ model: args.model, signal: args.signal });
    if (!voices.some((voice) => voice.id === args.voice)) fail("unavailable", "Choose a compatible PayPerQ synthesis voice for the selected model.");
    const response = await speechFetch("speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({ model: args.model, input: args.text, voice: args.voice, response_format: "mp3" }),
    }, args.signal);
    const byteLength = await streamMP3(response, args);
    checkAbort(args.signal);
    return { model: args.model, audio: { mediaType: "audio/mpeg", byteLength }, usage: { inputCharacters } };
  } catch (cause) { throw normalizeProviderError(cause, args); }
}

export const ppqTranscription = Object.freeze({
  defaultModel: PPQ_DEFAULT_TRANSCRIPTION_MODEL,
  listModels: listPPQTranscriptionModels,
  acceptedMediaTypes: TRANSCRIPTION_MEDIA_TYPES,
  maxInputBytes: TRANSCRIPTION_INPUT_MAX_BYTES,
  listAcceptedMediaTypesForModel: ppqTranscriptionMediaTypes,
  validateLanguageHint: ppqLanguageHint,
});
export const ppqSynthesis = Object.freeze({
  defaultModel: PPQ_DEFAULT_SYNTHESIS_MODEL,
  defaultVoice: PPQ_DEFAULT_SYNTHESIS_VOICE,
  listModels: listPPQSynthesisModels,
  listVoices: listPPQVoices,
  outputMediaTypes: Object.freeze(["audio/mpeg"]),
  maxTextCodePoints: SYNTHESIS_TEXT_MAX_CODE_POINTS,
  maxOutputBytes: SYNTHESIS_OUTPUT_MAX_BYTES,
});
