/**
 * Service-worker / provider client for the Prompt API offscreen host.
 */

import {
  ON_DEVICE_MODEL_ID,
  throwInference,
} from "./prompt-api-core.js";
import { sendPromptApiOffscreenMessage } from "./prompt-api-offscreen.js";

/**
 * @returns {Promise<import("./prompt-api-core.js").OnDeviceAvailability>}
 */
export async function getOnDeviceAvailability() {
  try {
    const response = await sendPromptApiOffscreenMessage({
      type: "prompt-api-availability",
    });
    if (response?.ok && typeof response.availability === "string") {
      return response.availability;
    }
    if (response?.availability === "missing") return "missing";
    return "unavailable";
  } catch {
    // Offscreen permission missing, createDocument failed, or API absent.
    return "missing";
  }
}

/**
 * Stream a chat completion through the offscreen LanguageModel host.
 * @param {{
 *   messages: import("./providers/types.js").ChatMessage[],
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 * }} args
 */
export async function streamOnDeviceChat(args) {
  const { messages, signal, onDelta } = args;
  const requestId = `on_device_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  /** @param {any} message */
  const onMessage = (message) => {
    if (message?.type !== "prompt-api-stream-delta") return;
    if (message.requestId !== requestId) return;
    if (typeof message.content === "string" && message.content) {
      onDelta(message.content);
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);

  const abortOffscreen = () => {
    void sendPromptApiOffscreenMessage({
      type: "prompt-api-abort-stream",
      requestId,
    }).catch(() => {});
  };

  if (signal.aborted) {
    chrome.runtime.onMessage.removeListener(onMessage);
    throwInference("aborted", "Request aborted");
  }
  signal.addEventListener("abort", abortOffscreen, { once: true });

  try {
    const response = await sendPromptApiOffscreenMessage({
      type: "prompt-api-stream",
      requestId,
      messages,
    });

    if (!response?.ok) {
      const code = response?.code || "provider_error";
      throwInference(
        code,
        response?.error || "On-device prompt failed"
      );
    }

    return {
      model: response?.result?.model || ON_DEVICE_MODEL_ID,
      message: response?.result?.message || {
        role: "assistant",
        content: "",
      },
    };
  } finally {
    signal.removeEventListener("abort", abortOffscreen);
    chrome.runtime.onMessage.removeListener(onMessage);
  }
}

/**
 * Start model install in the offscreen document (Options may prefer in-page
 * LanguageModel for user activation; this path is for SW-mediated install).
 * @param {{
 *   signal?: AbortSignal,
 *   onProgress?: (loaded: number) => void,
 *   requestId?: string,
 * }} [args]
 */
export async function installOnDeviceModel(args = {}) {
  const requestId =
    args.requestId ||
    `install_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  /** @param {any} message */
  const onMessage = (message) => {
    if (message?.type !== "prompt-api-install-progress") return;
    if (message.requestId !== requestId) return;
    if (typeof message.loaded === "number") {
      args.onProgress?.(message.loaded);
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);

  const abortInstall = () => {
    void sendPromptApiOffscreenMessage({
      type: "prompt-api-cancel-install",
    }).catch(() => {});
  };

  if (args.signal?.aborted) {
    chrome.runtime.onMessage.removeListener(onMessage);
    throwInference("aborted", "Request aborted");
  }
  args.signal?.addEventListener("abort", abortInstall, { once: true });

  try {
    const response = await sendPromptApiOffscreenMessage({
      type: "prompt-api-install",
      requestId,
    });
    if (!response?.ok) {
      throwInference(
        response?.code || "provider_error",
        response?.error || "Install failed"
      );
    }
  } finally {
    args.signal?.removeEventListener("abort", abortInstall);
    chrome.runtime.onMessage.removeListener(onMessage);
  }
}

export async function cancelOnDeviceInstall() {
  try {
    await sendPromptApiOffscreenMessage({ type: "prompt-api-cancel-install" });
  } catch {
    // ignore
  }
}
