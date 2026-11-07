/**
 * On-device provider — browser Prompt API (LanguageModel).
 * No API key; no model picker. User installs the UA-chosen model in Options.
 */

import { withChatErrorBoundary } from "./chat-errors.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import {
  ON_DEVICE_MODEL_ID,
  ON_DEVICE_PROVIDER_ID,
  assertOnDeviceAvailable,
  mapMessagesForPromptApi,
  messagesHaveToolHistory,
  promptApiChatOptions,
  throwInference,
} from "../prompt-api-core.js";
import { getOnDeviceAvailability, streamOnDeviceChat } from "../prompt-api-client.js";
import { assertImagesSupported, messagesHaveImageParts } from "../image-parts.js";
import { assertHostedWebSearchSupported } from "./hosted-tools.js";

/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").ChatMessage} ChatMessage */

/** @type {Provider} */
export const onDeviceProvider = {
  id: ON_DEVICE_PROVIDER_ID,
  label: "On-device",
  requiresApiKey: false,
  defaultModel: ON_DEVICE_MODEL_ID,
  supportsFunctionTools: true,
  async getModelCapabilities({ model }) {
    const availability = model === ON_DEVICE_MODEL_ID
      ? await getOnDeviceAvailability({ wantsImage: true }) : null;
    return {
      // A download requirement proves support, but native readiness still
      // gates execution before accepted. Missing/failed probes stay unknown.
      imageInput: ["available", "downloadable", "downloading"].includes(availability) ? true : null,
      imageOutput: false,
      imageInputNote: "On-device vision uses the browser Prompt API. Image generation is not available.",
    };
  },
  hostedTools: [],
  // Sentinel only — not a real catalog. UI replaces the model control with Install.
  models: [{ id: ON_DEVICE_MODEL_ID, label: "Browser-chosen on-device model" }],

  /**
   * Validate message history and tool-result correlation. Surface failures as
   * invalid_request before the `accepted` chunk instead of mid-stream.
   * @param {ChatMessage[]} messages
   */
  preflightMessages(messages) {
    mapMessagesForPromptApi(messages);
  },

  async preflightChat({ messages, tools, toolChoice, signal }) {
    const wantsImage = messagesHaveImageParts(messages);
    const wantsToolHistory = messagesHaveToolHistory(messages);
    promptApiChatOptions({ wantsImage, tools, toolChoice, wantsToolHistory });
    assertHostedWebSearchSupported(this, tools, toolChoice);
    const availability = await getOnDeviceAvailability({ wantsImage, tools, toolChoice, wantsToolHistory });
    if (signal?.aborted) throwInference("aborted", "Request aborted");
    // Always-allow also needs this readiness gate before accepted. A supported
    // model can still need a download, including a separate vision install.
    assertOnDeviceAvailable(availability, { wantsImage });
  },

  streamChat: withChatErrorBoundary(async function ({ messages, tools, toolChoice, output, signal, onDelta }) {
    if (signal.aborted) {
      throwInference("aborted", "Request aborted");
    }
    assertImagesSupported(this, messages, output, messagesHaveImageParts(messages)
      ? await resolveModelCapabilities(this, { model: ON_DEVICE_MODEL_ID, signal })
      : { imageInput: null, imageOutput: false });
    assertHostedWebSearchSupported(this, tools, toolChoice);
    promptApiChatOptions({ tools, toolChoice });
    return streamOnDeviceChat({ messages, tools, toolChoice, signal, onDelta });
  }),
};
