/**
 * Vercel AI Gateway Chat Completions streaming adapter.
 * Models are discovered via the public GET /v1/models catalog.
 */

import {
  mapToolsForVercel,
  omitHostedWebSearchIfNone,
} from "./hosted-tools.js";
import { streamOpenAICompatChat } from "./openai-compat-stream.js";
import {
  VERCEL_AI_GATEWAY_ORIGIN,
  VERCEL_DEFAULT_MODEL,
} from "../vercel-ai-gateway.js";

export { VERCEL_AI_GATEWAY_ORIGIN, VERCEL_DEFAULT_MODEL };

export const VERCEL_BASE_URL = `${VERCEL_AI_GATEWAY_ORIGIN}/v1`;
const VERCEL_CHAT_URL = `${VERCEL_BASE_URL}/chat/completions`;
const VERCEL_MODELS_URL = `${VERCEL_BASE_URL}/models`;

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
function mapVercelStatus(status, detail) {
  if (status === 401 || status === 403) {
    return { code: "provider_error", message: detail };
  }
  if (status === 402) {
    return {
      code: "provider_error",
      message: detail || "Vercel AI Gateway account has insufficient credits.",
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
 * List Vercel AI Gateway models from the public catalog (no auth required).
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<import("./types.js").ModelInfo[]>}
 */
export async function listVercelModels({ signal } = {}) {
  let response;
  try {
    response = await fetch(VERCEL_MODELS_URL, { signal });
  } catch (err) {
    if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "unavailable",
      err instanceof Error
        ? err.message
        : "Network error contacting Vercel AI Gateway while listing models"
    );
  }

  if (!response.ok) {
    throwInference(
      response.status >= 500 ? "unavailable" : "provider_error",
      `Vercel AI Gateway HTTP ${response.status} listing models`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throwInference(
      "provider_error",
      "Vercel AI Gateway returned invalid JSON for /v1/models"
    );
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
export const vercelProvider = {
  id: "vercel",
  label: "Vercel AI Gateway",
  requiresApiKey: true,
  defaultModel: VERCEL_DEFAULT_MODEL,
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),

  listModels: listVercelModels,

  async streamChat({
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    options,
    signal,
    onDelta,
    onReasoningDelta,
  }) {
    if (!model) {
      throwInference(
        "unavailable",
        "No Vercel AI Gateway model selected. Choose a model in the extension Options or approval dialog."
      );
    }

    const mappedTools = mapToolsForVercel(
      omitHostedWebSearchIfNone(tools, toolChoice)
    );
    return streamOpenAICompatChat({
      url: VERCEL_CHAT_URL,
      apiKey,
      model,
      messages,
      ...(mappedTools
        ? {
            tools: mappedTools,
            ...(toolChoice !== undefined ? { toolChoice } : {}),
          }
        : {}),
      ...(options ? { options } : {}),
      signal,
      onDelta,
      onReasoningDelta,
      label: "Vercel AI Gateway",
      mapStatus: mapVercelStatus,
    });
  },
};
