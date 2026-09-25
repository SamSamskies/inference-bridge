/**
 * Provider registry — add new adapters here without changing orchestration.
 */

import { openaiProvider } from "./openai.js";
import { anthropicProvider } from "./anthropic.js";
import { ollamaProvider } from "./ollama.js";
import { openrouterProvider } from "./openrouter.js";
import { onDeviceProvider } from "./on-device.js";
import { createOpenAICompatProvider } from "./openai-compat.js";
import { getSettings } from "../storage.js";
import { isFirefoxBuild } from "../runtime-browser.js";
import {
  SYNTHESIS_OUTPUT_MEDIA_TYPE,
  normalizeTranscriptionMediaType,
} from "../speech.js";

/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").ModelInfo} ModelInfo */
/** @typedef {import("./types.js").VoiceInfo} VoiceInfo */
/** @typedef {"chat" | "transcribe" | "synthesize"} InferenceMethod */

/** @type {Map<string, Provider>} */
const providers = new Map([
  [openaiProvider.id, openaiProvider],
  [anthropicProvider.id, anthropicProvider],
  [openrouterProvider.id, openrouterProvider],
  [ollamaProvider.id, ollamaProvider],
  [onDeviceProvider.id, onDeviceProvider],
]);

/**
 * Built-in providers only (no user-configured compat endpoints).
 * @returns {Provider[]}
 */
export function listProviders() {
  return [...providers.values()].filter(
    (provider) => provider.id !== "on-device" || !isFirefoxBuild()
  );
}

/**
 * @param {string} id
 * @returns {Provider | undefined}
 */
export function getProvider(id) {
  if (id === "on-device" && isFirefoxBuild()) return undefined;
  return providers.get(id);
}

/**
 * Default provider for this reference build (OpenAI).
 * @returns {Provider}
 */
export function getDefaultProvider() {
  return openaiProvider;
}

/**
 * Built-ins plus saved OpenAI-compatible endpoints.
 * If settings cannot be loaded, still returns built-ins (compat list is empty).
 * @returns {Promise<Provider[]>}
 */
export async function listAllProviders() {
  let compatEndpoints = [];
  try {
    ({ compatEndpoints } = await getSettings());
  } catch (err) {
    console.warn(
      "Failed to load compat endpoints; returning built-in providers",
      err
    );
  }
  return [
    ...listProviders(),
    ...compatEndpoints.map((endpoint) => createOpenAICompatProvider(endpoint)),
  ];
}

/**
 * Resolve a built-in or compat provider by id.
 * @param {string} id
 * @returns {Promise<Provider | undefined>}
 */
export async function getProviderAsync(id) {
  const builtIn = getProvider(id);
  if (builtIn) return builtIn;
  const { compatEndpoints } = await getSettings();
  const endpoint = compatEndpoints.find((e) => e.id === id);
  if (!endpoint) return undefined;
  return createOpenAICompatProvider(endpoint);
}

/**
 * Require both an operation descriptor and its implementation. This prevents a
 * partial adapter from being advertised by approval or options UI.
 * @param {Provider} provider
 * @param {InferenceMethod} method
 * @param {{ mediaType?: string }} [request]
 * @returns {boolean}
 */
export function providerSupportsMethod(provider, method, request = {}) {
  if (method === "chat") {
    return typeof provider?.streamChat === "function";
  }
  if (method === "transcribe") {
    if (
      !provider?.transcription ||
      typeof provider.transcribe !== "function" ||
      !Array.isArray(provider.transcription.acceptedMediaTypes)
    ) {
      return false;
    }
    if (request.mediaType === undefined) return true;
    const mediaType = normalizeTranscriptionMediaType(request.mediaType);
    if (!mediaType) return false;
    return provider.transcription.acceptedMediaTypes.some(
      (candidate) => normalizeTranscriptionMediaType(candidate) === mediaType
    );
  }
  if (method === "synthesize") {
    if (
      !provider?.synthesis ||
      typeof provider.synthesize !== "function" ||
      !Array.isArray(provider.synthesis.outputMediaTypes)
    ) {
      return false;
    }
    if (request.mediaType === undefined) return true;
    return (
      request.mediaType === SYNTHESIS_OUTPUT_MEDIA_TYPE &&
      provider.synthesis.outputMediaTypes.includes(SYNTHESIS_OUTPUT_MEDIA_TYPE)
    );
  }
  return false;
}

/**
 * @param {Provider[]} all
 * @param {InferenceMethod} method
 * @param {{ mediaType?: string }} [request]
 * @returns {Provider[]}
 */
export function filterProvidersForMethod(all, method, request = {}) {
  return all.filter((provider) =>
    providerSupportsMethod(provider, method, request)
  );
}

/**
 * Normalize a static catalog entry (string or ModelInfo) to ModelInfo.
 * @param {string | ModelInfo} entry
 * @returns {ModelInfo}
 */
function toModelInfo(entry) {
  if (typeof entry === "string") return { id: entry };
  return {
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    ...(Array.isArray(entry.inputModalities)
      ? { inputModalities: [...entry.inputModalities] }
      : {}),
    ...(Array.isArray(entry.outputModalities)
      ? { outputModalities: [...entry.outputModalities] }
      : {}),
  };
}

/**
 * @param {string | VoiceInfo} entry
 * @returns {VoiceInfo}
 */
function toVoiceInfo(entry) {
  if (typeof entry === "string") return { id: entry };
  return {
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
  };
}

/**
 * Resolve models for a provider (static catalog or async discovery).
 * Always returns ModelInfo[] so UI callers share one shape.
 * @param {Provider} provider
 * @param {{
 *   method?: InferenceMethod,
 *   mediaType?: string,
 *   signal?: AbortSignal,
 *   apiKey?: string,
 * }} [args]
 * @returns {Promise<ModelInfo[]>}
 */
export async function resolveProviderModels(provider, args = {}) {
  const method = args.method || "chat";
  const catalog =
    method === "transcribe"
      ? provider.transcription
      : method === "synthesize"
        ? provider.synthesis
        : provider;
  if (!catalog) return [];
  const catalogArgs = {
    ...(args.signal ? { signal: args.signal } : {}),
    ...("apiKey" in args ? { apiKey: args.apiKey } : {}),
  };
  const models =
    typeof catalog.listModels === "function"
      ? await catalog.listModels(catalogArgs)
      : catalog.models
        ? catalog.models.map(toModelInfo)
        : [];
  if (method !== "transcribe" || args.mediaType === undefined) {
    return models;
  }
  const mediaType = normalizeTranscriptionMediaType(args.mediaType);
  if (!mediaType) return [];
  const support = await Promise.all(
    models.map(async (model) => ({
      model,
      mediaTypes: await resolveTranscriptionMediaTypes(provider, {
        model: model.id,
        ...catalogArgs,
      }),
    }))
  );
  return support
    .filter((entry) => entry.mediaTypes.includes(mediaType))
    .map((entry) => entry.model);
}

/**
 * Resolve synthesis voices independently from chat/transcription catalogs.
 * @param {Provider} provider
 * @param {{ model?: string, signal?: AbortSignal, apiKey?: string }} [args]
 * @returns {Promise<VoiceInfo[]>}
 */
export async function resolveProviderVoices(provider, args = {}) {
  const catalog = provider.synthesis;
  if (!catalog) return [];
  if (typeof catalog.listVoices === "function") {
    return catalog.listVoices(args);
  }
  return catalog.voices ? catalog.voices.map(toVoiceInfo) : [];
}

/**
 * Resolve the provider-level transcription MIME declaration, narrowed by an
 * optional model probe. Results always remain inside the Bridge envelope.
 * @param {Provider} provider
 * @param {{ model: string, signal?: AbortSignal, apiKey?: string }} args
 * @returns {Promise<string[]>}
 */
export async function resolveTranscriptionMediaTypes(provider, args) {
  const catalog = provider.transcription;
  if (
    !catalog ||
    typeof provider.transcribe !== "function" ||
    !Array.isArray(catalog.acceptedMediaTypes)
  ) {
    return [];
  }
  const declared = new Set(
    catalog.acceptedMediaTypes
      .map(normalizeTranscriptionMediaType)
      .filter(Boolean)
  );
  if (typeof catalog.listAcceptedMediaTypesForModel !== "function") {
    return [...declared];
  }
  const modelTypes = await catalog.listAcceptedMediaTypesForModel(args);
  const narrowed = new Set(
    modelTypes.map(normalizeTranscriptionMediaType).filter(Boolean)
  );
  return [...declared].filter((mediaType) => narrowed.has(mediaType));
}
