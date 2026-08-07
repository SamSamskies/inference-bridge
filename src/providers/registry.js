/**
 * Provider registry — add new adapters here without changing orchestration.
 */

import { openaiProvider } from "./openai.js";
import { ollamaProvider } from "./ollama.js";
import { openrouterProvider } from "./openrouter.js";
import { createOpenAICompatProvider } from "./openai-compat.js";
import { getSettings } from "../storage.js";

/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").ModelInfo} ModelInfo */

/** @type {Map<string, Provider>} */
const providers = new Map([
  [openaiProvider.id, openaiProvider],
  [ollamaProvider.id, ollamaProvider],
  [openrouterProvider.id, openrouterProvider],
]);

/**
 * Built-in providers only (no user-configured compat endpoints).
 * @returns {Provider[]}
 */
export function listProviders() {
  return [...providers.values()];
}

/**
 * @param {string} id
 * @returns {Provider | undefined}
 */
export function getProvider(id) {
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
 * @returns {Promise<Provider[]>}
 */
export async function listAllProviders() {
  const { compatEndpoints } = await getSettings();
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
 * Normalize a static catalog entry (string or ModelInfo) to ModelInfo.
 * @param {string | ModelInfo} entry
 * @returns {ModelInfo}
 */
function toModelInfo(entry) {
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
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<ModelInfo[]>}
 */
export async function resolveProviderModels(provider, args = {}) {
  if (typeof provider.listModels === "function") {
    return provider.listModels(args);
  }
  return provider.models ? provider.models.map(toModelInfo) : [];
}
