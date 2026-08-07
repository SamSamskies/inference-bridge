/**
 * Factory for user-configured OpenAI-compatible endpoints
 * (LM Studio, llama.cpp, vLLM, LocalAI, proxies, etc.).
 */

import { streamOpenAICompatChat } from "./openai-compat-stream.js";
import {
  hasHostPermissionForBaseUrl,
} from "../host-permissions.js";
import { ensureLoopbackOriginBypassForBaseUrl } from "../loopback-origin-bypass.js";

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
 * @param {string} baseUrl
 * @param {string} label
 * @returns {Promise<void>}
 */
async function ensureReady(baseUrl, label) {
  const allowed = await hasHostPermissionForBaseUrl(baseUrl);
  if (!allowed) {
    throwInference(
      "unavailable",
      `Host permission not granted for ${label}. Re-save the endpoint in extension Options to allow access.`
    );
  }
  try {
    await ensureLoopbackOriginBypassForBaseUrl(baseUrl);
  } catch (err) {
    console.warn("Failed to install loopback Origin bypass", err);
  }
}

/**
 * @param {{ id: string, name: string, baseUrl: string }} endpoint
 * @returns {import("./types.js").Provider & { optionalApiKey: true, baseUrl: string }}
 */
export function createOpenAICompatProvider(endpoint) {
  const { id, name, baseUrl } = endpoint;
  const label = `${name} (experimental)`;
  const modelsUrl = `${baseUrl}/models`;
  const chatUrl = `${baseUrl}/chat/completions`;

  return {
    id,
    label,
    requiresApiKey: false,
    optionalApiKey: true,
    baseUrl,
    defaultModel: "",

    async listModels({ signal } = {}) {
      // Host-permission failures must propagate: swallowing them as [] makes the
      // UI offer free-text entry while streamChat still fails on ensureReady.
      await ensureReady(baseUrl, label);

      let response;
      try {
        response = await fetch(modelsUrl, { signal });
      } catch {
        return [];
      }

      if (!response.ok) return [];

      let body;
      try {
        body = await response.json();
      } catch {
        return [];
      }

      const entries = Array.isArray(body?.data) ? body.data : [];
      /** @type {import("./types.js").ModelInfo[]} */
      const models = [];
      for (const entry of entries) {
        const modelId = typeof entry?.id === "string" ? entry.id : "";
        if (!modelId) continue;
        const modelLabel =
          typeof entry?.name === "string" && entry.name ? entry.name : undefined;
        models.push(modelLabel ? { id: modelId, label: modelLabel } : { id: modelId });
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      return models;
    },

    async streamChat({ apiKey, model, messages, signal, onDelta }) {
      if (!model) {
        throwInference(
          "unavailable",
          `No model selected for ${label}. Choose a model in the extension Options or approval dialog.`
        );
      }

      await ensureReady(baseUrl, label);

      return streamOpenAICompatChat({
        url: chatUrl,
        apiKey,
        model,
        messages,
        signal,
        onDelta,
        label,
      });
    },
  };
}
