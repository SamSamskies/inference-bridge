/**
 * OpenAI streaming adapter.
 * Chat Completions by default; Responses API when hosted web_search is present,
 * `output.images` is set (internal `image_generation` tool, not page-facing),
 * or the model requires Responses for function tools (GPT-6 Astra).
 */

import {
  assertImagesSupported,
  openaiModelSupportsImageOutput,
  requestWantsImageOutput,
} from "../image-parts.js";
import {
  hasHostedWebSearch,
  omitHostedWebSearchIfNone,
} from "./hosted-tools.js";
import {
  filterFunctionTools,
  streamOpenAICompatChat,
} from "./openai-compat-stream.js";
import { streamOpenAIResponsesChat } from "./openai-responses.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Curated chat models for the Options/approval UI — not a live OpenAI catalog. */
export const OPENAI_MODELS = Object.freeze([
  "gpt-6-astra",
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

/**
 * GPT-6 Astra supports Chat Completions for text, but function calling requires
 * the Responses API (Chat Completions tool calls return HTTP 400).
 * @param {unknown} model
 * @returns {boolean}
 */
export function openaiModelRequiresResponsesForFunctionTools(model) {
  if (typeof model !== "string") return false;
  const id = model.trim().toLowerCase();
  return id.startsWith("gpt-6");
}

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const openaiProvider = {
  id: "openai",
  label: "OpenAI",
  requiresApiKey: true,
  models: OPENAI_MODELS,
  defaultModel: "gpt-5.6-luna",
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),

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
    const wantImages = requestWantsImageOutput(output);
    const canGenerateImages = openaiModelSupportsImageOutput(model);
    assertImagesSupported(this, messages, output, {
      imageOutput: wantImages && canGenerateImages,
    });
    const toolsForRequest = omitHostedWebSearchIfNone(tools, toolChoice);
    const functionTools = filterFunctionTools(toolsForRequest);
    const useResponses =
      hasHostedWebSearch(toolsForRequest) ||
      wantImages ||
      (openaiModelRequiresResponsesForFunctionTools(model) &&
        Boolean(functionTools));
    if (useResponses) {
      return streamOpenAIResponsesChat({
        apiKey,
        model,
        messages,
        tools: toolsForRequest,
        toolChoice,
        ...(options ? { options } : {}),
        includeAssistantImages: wantImages,
        signal,
        onDelta,
        onReasoningDelta,
      });
    }

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
      ...(options ? { options } : {}),
      signal,
      onDelta,
      onReasoningDelta,
      label: "OpenAI",
    });
  },
};
