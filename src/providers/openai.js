/**
 * OpenAI chat Completions streaming adapter.
 * Implements the provider interface used by the registry.
 */

import {
  filterFunctionTools,
  streamOpenAICompatChat,
} from "./openai-compat-stream.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Curated chat models for the Options/approval UI — not a live OpenAI catalog. */
export const OPENAI_MODELS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
  "gpt-4o",
]);

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const openaiProvider = {
  id: "openai",
  label: "OpenAI",
  requiresApiKey: true,
  models: OPENAI_MODELS,
  defaultModel: "gpt-5.6-luna",
  supportsFunctionTools: true,
  hostedTools: Object.freeze([]),

  async streamChat({
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    signal,
    onDelta,
    onReasoningDelta,
  }) {
    const functionTools = filterFunctionTools(tools);
    return streamOpenAICompatChat({
      url: OPENAI_URL,
      apiKey,
      model,
      messages,
      ...(functionTools
        ? {
            tools: functionTools,
            ...(toolChoice !== undefined ? { toolChoice } : {}),
          }
        : {}),
      signal,
      onDelta,
      onReasoningDelta,
      label: "OpenAI",
    });
  },
};
