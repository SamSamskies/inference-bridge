/**
 * Offscreen LanguageModel host. Owned by the service worker via chrome.offscreen.
 */

import {
  installLanguageModel,
  probeLanguageModelAvailability,
  streamLanguageModelChat,
} from "../src/prompt-api-core.js";

/** @type {AbortController | null} */
let installController = null;

/** @type {Map<string, AbortController>} */
const streamControllers = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "prompt-api-offscreen") return false;

  if (message.type === "prompt-api-availability") {
    void probeLanguageModelAvailability()
      .then((availability) => {
        sendResponse({ ok: true, availability });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          availability: "unavailable",
          error: err instanceof Error ? err.message : "availability failed",
        });
      });
    return true;
  }

  if (message.type === "prompt-api-install") {
    if (installController) {
      sendResponse({ ok: false, error: "Install already in progress" });
      return false;
    }
    installController = new AbortController();
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "install";

    void installLanguageModel({
      LanguageModel: globalThis.LanguageModel,
      signal: installController.signal,
      onProgress: (loaded) => {
        void chrome.runtime.sendMessage({
          type: "prompt-api-install-progress",
          requestId,
          loaded,
        });
      },
    })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          code: /** @type {any} */ (err)?.code || "provider_error",
          error: err instanceof Error ? err.message : "Install failed",
        });
      })
      .finally(() => {
        installController = null;
      });
    return true;
  }

  if (message.type === "prompt-api-cancel-install") {
    installController?.abort();
    installController = null;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "prompt-api-stream") {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) {
      sendResponse({ ok: false, error: "Missing requestId" });
      return false;
    }
    const controller = new AbortController();
    streamControllers.set(requestId, controller);

    void streamLanguageModelChat({
      LanguageModel: globalThis.LanguageModel,
      messages: Array.isArray(message.messages) ? message.messages : [],
      signal: controller.signal,
      onDelta: (content) => {
        void chrome.runtime.sendMessage({
          type: "prompt-api-stream-delta",
          requestId,
          content,
        });
      },
    })
      .then((result) => {
        sendResponse({ ok: true, result });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          code: /** @type {any} */ (err)?.code || "provider_error",
          error: err instanceof Error ? err.message : "Stream failed",
        });
      })
      .finally(() => {
        streamControllers.delete(requestId);
      });
    return true;
  }

  if (message.type === "prompt-api-abort-stream") {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "";
    const controller = streamControllers.get(requestId);
    controller?.abort();
    streamControllers.delete(requestId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
