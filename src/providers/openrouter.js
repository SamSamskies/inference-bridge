/**
 * OpenRouter chat Completions streaming adapter.
 * Models are discovered via the public GET /api/v1/models catalog.
 */

import { streamOpenAICompatChat } from "./openai-compat-stream.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwInference(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  throw error;
}

/**
 * @param {number} status
 * @param {string} detail
 * @returns {{ code: string, message: string }}
 */
function mapOpenRouterStatus(status, detail) {
  if (status === 401 || status === 403) {
    return { code: "provider_error", message: detail };
  }
  if (status === 402) {
    return {
      code: "provider_error",
      message: detail || "OpenRouter account has insufficient credits.",
    };
  }
  if (status === 429) {
    return { code: "provider_error", message: detail };
  }
  if (status === 503 || status >= 500) {
    return { code: "unavailable", message: detail };
  }
  return { code: "provider_error", message: detail };
}

/**
 * List OpenRouter models from the public catalog (no auth required).
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<import("./types.js").ModelInfo[]>}
 */
export async function listOpenRouterModels({ signal } = {}) {
  let response;
  try {
    response = await fetch(OPENROUTER_MODELS_URL, { signal });
  } catch (err) {
    if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
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
  } catch {
    throwInference("provider_error", "OpenRouter returned invalid JSON for /api/v1/models");
  }

  const entries = Array.isArray(body?.data) ? body.data : [];
  /** @type {import("./types.js").ModelInfo[]} */
  const models = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!id) continue;
    const label = typeof entry?.name === "string" && entry.name ? entry.name : undefined;
    models.push(label ? { id, label } : { id });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const openrouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  requiresApiKey: true,
  // Placeholder until /api/v1/models is queried; Auto Router is a safe starter.
  defaultModel: "openrouter/auto",

  listModels: listOpenRouterModels,

  async streamChat({ apiKey, model, messages, signal, onDelta, onReasoningDelta }) {
    if (!model) {
      throwInference(
        "unavailable",
        "No OpenRouter model selected. Choose a model in the extension Options or approval dialog."
      );
    }

    return streamOpenAICompatChat({
      url: OPENROUTER_CHAT_URL,
      apiKey,
      model,
      messages,
      signal,
      onDelta,
      onReasoningDelta,
      label: "OpenRouter",
      mapStatus: mapOpenRouterStatus,
    });
  },
};
