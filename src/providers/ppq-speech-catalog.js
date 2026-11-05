/** Public PPQ audio discovery, independent of chat and decision catalogs. */
import { SYNTHESIS_TEXT_MAX_CODE_POINTS } from "../speech.js";

const BASE = "https://api.ppq.ai/v1/audio";
const MAX_AGE_MS = 60_000;
let audioCatalog = null, audioListedAt = 0;
let voiceCatalog = null, voicesListedAt = 0;
const knownSpeechModels = new Set(["nova-3", "nova-2", "deepgram_aura_2", "tinfoil-voxtral-tts"]);

export const PPQ_DEFAULT_TRANSCRIPTION_MODEL = "nova-3";
export const PPQ_DEFAULT_SYNTHESIS_MODEL = "deepgram_aura_2";
export const PPQ_DEFAULT_SYNTHESIS_VOICE = "aura-2-arcas-en";
export function isPPQSpeechModel(model) { return knownSpeechModels.has(model); }

function fail(message, code = "provider_error") {
  throw Object.assign(new Error(message), { name: "InferenceError", code });
}
function checkAbort(signal) {
  if (signal?.aborted) fail("Request aborted", "aborted");
}

async function publicJSON(path, signal) {
  checkAbort(signal);
  let response;
  try { response = await fetch(`${BASE}/${path}`, { signal }); }
  catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("Request aborted", "aborted");
    fail(`Could not load PayPerQ audio ${path}. Retry discovery in Options.`, "unavailable");
  }
  checkAbort(signal);
  if (!response.ok) fail(`PayPerQ HTTP ${response.status} listing audio ${path}. Retry discovery in Options.`, response.status >= 500 ? "unavailable" : "provider_error");
  let body;
  try { body = await response.json(); }
  catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("Request aborted", "aborted");
    fail(`PayPerQ returned invalid JSON listing audio ${path}.`);
  }
  checkAbort(signal);
  return body;
}

function modelEntries(entries, kind) {
  const models = new Map();
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || entry.type !== kind) continue;
    knownSpeechModels.add(id);
    // The TTS bucket currently includes ElevenLabs speech-to-speech models.
    // They require audio input and cannot implement IPA text synthesis.
    if (kind === "tts" && (id.includes("_sts_") || /speech[ -]to[ -]speech/i.test(entry.description || ""))) continue;
    const documentedLimit = entry.provider === "deepgram" ? 2000
      : entry.provider === "elevenlabs" ? 5000
        : id === "tinfoil-voxtral-tts" ? 1200 : SYNTHESIS_TEXT_MAX_CODE_POINTS;
    const catalogLimit = Number.isSafeInteger(entry.char_limit) && entry.char_limit > 0
      ? entry.char_limit : SYNTHESIS_TEXT_MAX_CODE_POINTS;
    models.set(id, {
      id,
      ...(typeof entry.name === "string" && entry.name ? { label: entry.name } : {}),
      languages: Array.isArray(entry.languages) ? entry.languages.filter((value) => typeof value === "string") : [],
      maxText: Math.min(documentedLimit, catalogLimit, SYNTHESIS_TEXT_MAX_CODE_POINTS),
    });
  }
  return models;
}

async function loadAudioCatalog({ signal, refresh = false } = {}) {
  checkAbort(signal);
  if (!refresh && audioCatalog && Date.now() - audioListedAt < MAX_AGE_MS) return audioCatalog;
  audioCatalog = null;
  audioListedAt = 0;
  const body = await publicJSON("models", signal);
  if (!Array.isArray(body?.data?.stt) || !Array.isArray(body?.data?.tts)) fail("PayPerQ returned an invalid audio model catalog.");
  audioCatalog = { transcribe: modelEntries(body.data.stt, "stt"), synthesize: modelEntries(body.data.tts, "tts") };
  audioListedAt = Date.now();
  return audioCatalog;
}

const publicModels = (models, method) => [...models.values()]
  .map(({ id, label }) => ({ id, ...(label ? { label } : {}), inputModalities: [method === "transcribe" ? "audio" : "text"], outputModalities: [method === "transcribe" ? "transcription" : "speech"] }))
  .sort((a, b) => a.id.localeCompare(b.id));

export async function listPPQTranscriptionModels(args = {}) {
  return publicModels((await loadAudioCatalog({ ...args, refresh: true })).transcribe, "transcribe");
}
export async function listPPQSynthesisModels(args = {}) {
  return publicModels((await loadAudioCatalog({ ...args, refresh: true })).synthesize, "synthesize");
}
export async function requirePPQSpeechModel(method, model, { signal } = {}) {
  const entry = (await loadAudioCatalog({ signal }))[method]?.get(model);
  if (!entry) fail(`Choose a model from the current PayPerQ ${method === "transcribe" ? "transcription" : "synthesis"} catalog.`, "unavailable");
  return entry;
}

async function loadVoices({ signal } = {}) {
  checkAbort(signal);
  if (voiceCatalog && Date.now() - voicesListedAt < MAX_AGE_MS) return voiceCatalog;
  voiceCatalog = null;
  voicesListedAt = 0;
  const body = await publicJSON("voices", signal);
  if (!Array.isArray(body?.data)) fail("PayPerQ returned an invalid voice catalog.");
  voiceCatalog = body.data.flatMap((entry) => {
    if (typeof entry?.id !== "string" || !entry.id.trim() || typeof entry.model_id !== "string" || !entry.model_id.trim()) return [];
    return [{
      id: entry.id.trim(), model: entry.model_id.trim(),
      name: typeof entry.name === "string" ? entry.name : "",
      language: typeof entry.language === "string" ? entry.language.toLowerCase() : "",
    }];
  });
  voicesListedAt = Date.now();
  return voiceCatalog;
}

/** Voice IDs are only valid for their exact model, not merely its provider.
 * Language labels inform selection; IPA synthesis has no language parameter. */
export async function listPPQVoices({ model = PPQ_DEFAULT_SYNTHESIS_MODEL, signal } = {}) {
  const entry = await requirePPQSpeechModel("synthesize", model, { signal });
  const voices = await loadVoices({ signal });
  const result = new Map();
  for (const voice of voices) {
    if (voice.model !== model) continue;
    if (entry.languages.length && !entry.languages.includes("multi") && voice.language && voice.language !== "multi" && !entry.languages.includes(voice.language)) continue;
    result.set(voice.id, {
      id: voice.id,
      label: `${voice.name || voice.id}${voice.language ? ` (${voice.language})` : ""}`,
    });
  }
  return [...result.values()].sort((a, b) => a.label.localeCompare(b.label));
}
