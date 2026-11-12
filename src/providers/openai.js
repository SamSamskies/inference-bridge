/**
 * OpenAI streaming adapter.
 * Chat Completions by default; Responses API when hosted web_search is present,
 * `output.images` is set (internal `image_generation` tool, not page-facing),
 * or the model requires Responses for function tools (GPT-6 models).
 */

import { DECISION_LIMITS } from "./decision-limits.js";
import { withChatErrorBoundary } from "./chat-errors.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import {
  assertImagesSupported,
  requestWantsImageOutput,
} from "../image-parts.js";
import { openaiModelSupportsImageOutput } from "./openai-capabilities.js";
import {
  hasHostedWebSearch,
  omitHostedWebSearchIfNone,
} from "./hosted-tools.js";
import {
  filterFunctionTools,
  streamOpenAICompatChat,
} from "./openai-compat-stream.js";
import { streamOpenAIResponsesChat } from "./openai-responses.js";
import { decideOpenAI, preflightOpenAIDecide, OPENAI_DECISION_MODELS } from "./openai-decisions.js";
import {
  OPENAI_SYNTHESIS_MODELS,
  OPENAI_SYNTHESIS_MEDIA_TYPES,
  OPENAI_SYNTHESIS_VOICES,
  OPENAI_TRANSCRIPTION_MEDIA_TYPES,
  OPENAI_TRANSCRIPTION_MODELS,
  openAIVoicesForModel,
  synthesizeOpenAI,
  transcribeOpenAI,
} from "./openai-speech.js";
import {
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
} from "../speech.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Curated chat models for the Options/approval UI — not a live OpenAI catalog. */
export const OPENAI_MODELS = Object.freeze([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-5-nano",
]);

/**
 * GPT-6 models support Chat Completions for text, but OpenAI recommends the
 * Responses API for function calling. Astra, GPT-6.1 Sol and Terra require Responses;
 * GPT-6 Sol and Luna only support Chat Completions function calls at `none`.
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
  defaultModel: "gpt-6-luna",
  supportsFunctionTools: true,
  getModelCapabilities({ model }) {
    return {
      imageInput: null,
      imageOutput: openaiModelSupportsImageOutput(model) ? true : null,
      // Custom model IDs still use the native multimodal transport. A null
      // result does not assert that an arbitrary model supports image input.
      imageInputPassthrough: true,
    };
  },
  hostedTools: Object.freeze(["web_search"]),
  decisions: {
    ...DECISION_LIMITS["openai"],
    defaultModel: OPENAI_DECISION_MODELS[0],
    models: OPENAI_DECISION_MODELS,
  },
  decide: decideOpenAI,
  preflightDecide: preflightOpenAIDecide,
  transcription: {
    defaultModel: OPENAI_TRANSCRIPTION_MODELS[0],
    models: OPENAI_TRANSCRIPTION_MODELS,
    acceptedMediaTypes: OPENAI_TRANSCRIPTION_MEDIA_TYPES,
    maxInputBytes: TRANSCRIPTION_INPUT_MAX_BYTES,
  },
  synthesis: {
    defaultModel: OPENAI_SYNTHESIS_MODELS[0],
    defaultVoice: "alloy",
    models: OPENAI_SYNTHESIS_MODELS,
    voices: OPENAI_SYNTHESIS_VOICES,
    async listVoices({ model } = {}) {
      return openAIVoicesForModel(model || OPENAI_SYNTHESIS_MODELS[0]);
    },
    outputMediaTypes: OPENAI_SYNTHESIS_MEDIA_TYPES,
    maxTextCodePoints: SYNTHESIS_TEXT_MAX_CODE_POINTS,
    maxOutputBytes: SYNTHESIS_OUTPUT_MAX_BYTES,
  },
  transcribe: transcribeOpenAI,
  synthesize: synthesizeOpenAI,

  streamChat: withChatErrorBoundary(async function ({
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
    assertImagesSupported(this, messages, output, await resolveModelCapabilities(this, { model, apiKey, signal }));
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
  }),
};
