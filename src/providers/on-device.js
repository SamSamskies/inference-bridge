/**
 * On-device provider — browser Prompt API (LanguageModel).
 * No API key; no model picker. User installs the UA-chosen model in Options.
 */

import {
  ON_DEVICE_MODEL_ID,
  ON_DEVICE_PROVIDER_ID,
  mapMessagesForPromptApi,
  throwInference,
} from "../prompt-api-core.js";
import { streamOnDeviceChat } from "../prompt-api-client.js";

/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").ChatMessage} ChatMessage */

/** @type {Provider} */
export const onDeviceProvider = {
  id: ON_DEVICE_PROVIDER_ID,
  label: "On-device",
  requiresApiKey: false,
  defaultModel: ON_DEVICE_MODEL_ID,
  supportsFunctionTools: false,
  hostedTools: [],
  // Sentinel only — not a real catalog. UI replaces the model control with Install.
  models: [{ id: ON_DEVICE_MODEL_ID, label: "Browser-chosen on-device model" }],

  /**
   * Prompt API rejects tool turns and non-user finals. Surface that as
   * invalid_request before the `accepted` chunk instead of mid-stream.
   * @param {ChatMessage[]} messages
   */
  preflightMessages(messages) {
    mapMessagesForPromptApi(messages);
  },

  async streamChat({ messages, signal, onDelta }) {
    if (signal.aborted) {
      throwInference("aborted", "Request aborted");
    }
    return streamOnDeviceChat({ messages, signal, onDelta });
  },
};
