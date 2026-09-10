/**
 * OpenRouter chat Completions streaming adapter.
 * Models are discovered via the public GET /api/v1/models catalog.
 */

import {
  assertImagesSupported,
  messagesHaveImageParts,
  requestWantsImageOutput,
} from "../image-parts.js";
import {
  mapToolsForOpenRouter,
  omitHostedWebSearchIfNone,
} from "./hosted-tools.js";
import { streamOpenAICompatChat } from "./openai-compat-stream.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;

/** @type {Map<string, { inputImage: boolean, outputImage: boolean, outputText: boolean }>} */
const modalitiesByModel = new Map();

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}

/**
 * @param {string} id
 * @param {unknown} architecture
 */
function rememberModalities(id, architecture) {
  const arch =
    architecture && typeof architecture === "object" && !Array.isArray(architecture)
      ? /** @type {Record<string, unknown>} */ (architecture)
      : {};
  const input = stringList(arch.input_modalities);
  const output = stringList(arch.output_modalities);
  modalitiesByModel.set(id, {
    inputImage: input.includes("image"),
    outputImage: output.includes("image"),
    outputText: output.length === 0 || output.includes("text"),
  });
}

/**
 * Catalog lookup used by streamChat and Always-allow skip. Lists models if needed.
 * @param {string} model
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<{ inputImage: boolean, outputImage: boolean, outputText: boolean }>}
 */
export async function openrouterModelModalities(model, { signal } = {}) {
  if (!model) return { inputImage: false, outputImage: false, outputText: true };
  const cached = modalitiesByModel.get(model);
  if (cached) return cached;
  await listOpenRouterModels({ signal });
  return (
    modalitiesByModel.get(model) || {
      inputImage: false,
      outputImage: false,
      outputText: true,
    }
  );
}

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

export function resetOpenRouterModalitiesCache() {
  modalitiesByModel.clear();
}

/**
 * OpenRouter `:batch` slugs are Async Batch API-only (POST /api/beta/batches).
 * They cannot be used with interactive chat completions / streaming.
 * @param {string} model
 * @returns {boolean}
 */
export function isOpenRouterBatchModel(model) {
  return typeof model === "string" && model.endsWith(":batch");
}

/**
 * @param {string} model
 * @returns {string}
 */
function openRouterBatchModelMessage(model) {
  const syncTwin = model.slice(0, -":batch".length);
  const hint = syncTwin
    ? ` Use "${syncTwin}" for interactive chat, or pick a non-batch model.`
    : " Pick a non-batch model for interactive chat.";
  return `OpenRouter model "${model}" is Batch API-only and cannot be used for interactive chat.${hint}`;
}

/**
 * List OpenRouter models from the public catalog (no auth required).
 * Omits `:batch` variants — those require the async Batch API, not chat completions.
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
    if (!id || isOpenRouterBatchModel(id)) continue;
    rememberModalities(id, entry?.architecture);
    const label = typeof entry?.name === "string" && entry.name ? entry.name : undefined;
    /** @type {import("./types.js").ModelInfo} */
    const info = { id };
    if (label) info.label = label;
    const input = stringList(entry?.architecture?.input_modalities);
    const output = stringList(entry?.architecture?.output_modalities);
    if (input.length) info.inputModalities = input;
    if (output.length) info.outputModalities = output;
    models.push(info);
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
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),

  listModels: listOpenRouterModels,

  async streamChat({
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    options,
    output,
    signal,
    onDelta,
    onReasoningDelta,
  }) {
    if (!model) {
      throwInference(
        "unavailable",
        "No OpenRouter model selected. Choose a model in the extension Options or approval dialog."
      );
    }
    if (isOpenRouterBatchModel(model)) {
      throwInference("invalid_request", openRouterBatchModelMessage(model));
    }

    const wantImages = requestWantsImageOutput(output);
    const wantImageInput = messagesHaveImageParts(messages);
    /** @type {{ inputImage: boolean, outputImage: boolean, outputText: boolean }} */
    let caps = { inputImage: false, outputImage: false, outputText: true };
    if (wantImages || wantImageInput) {
      caps = await openrouterModelModalities(model, { signal });
    }
    if (wantImages && !caps.outputImage) {
      throwInference(
        "unavailable",
        `OpenRouter model "${model}" does not generate images. Choose a model whose output modalities include image.`
      );
    }
    if (wantImageInput && !caps.inputImage) {
      throwInference(
        "unavailable",
        `OpenRouter model "${model}" does not accept image input. Choose a vision-capable model.`
      );
    }
    assertImagesSupported(this, messages, output, {
      imageInput: caps.inputImage,
      imageOutput: caps.outputImage,
    });

    const mappedTools = mapToolsForOpenRouter(
      omitHostedWebSearchIfNone(tools, toolChoice)
    );
    /** @type {Record<string, unknown>} */
    const extraBody = {};
    if (wantImages) {
      extraBody.modalities = caps.outputText ? ["image", "text"] : ["image"];
    }
    return streamOpenAICompatChat({
      url: OPENROUTER_CHAT_URL,
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
      ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
      includeAssistantImages: wantImages,
      signal,
      onDelta,
      onReasoningDelta,
      label: "OpenRouter",
      mapStatus: mapOpenRouterStatus,
    });
  },
};
