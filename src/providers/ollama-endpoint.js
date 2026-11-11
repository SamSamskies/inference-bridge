import { ensureOllamaOriginBypass } from "../ollama-origin-bypass.js";

// These routes are extension-owned. Pages cannot supply a host or credentials.
export const LOCAL_OLLAMA_ENDPOINT = Object.freeze({
  baseUrl: "http://localhost:11434",
  label: "Ollama",
  cloud: false,
  headers: Object.freeze({}),
  prepare: ensureOllamaOriginBypass,
});

export function ollamaCloudEndpoint(apiKey, { required = false } = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (required && !key) {
    const error = new Error("Ollama Cloud needs an API key. Add one in Options.");
    error.name = "InferenceError";
    error.code = "unavailable";
    throw error;
  }
  return {
    baseUrl: "https://ollama.com",
    label: "Ollama Cloud",
    cloud: true,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    async prepare() {},
  };
}

export function ollamaHttpErrorCode(status) {
  if (status === 404 || status >= 500) return "unavailable";
  return "provider_error";
}
