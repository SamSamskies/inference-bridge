/**
 * Offscreen LanguageModel host. Owned by the service worker via chrome.offscreen.
 */

import {
  promptApiChatOptions,
  assertPromptApiToolsAvailable,
  installLanguageModel,
  probeLanguageModelAvailability,
  streamLanguageModelChat,
} from "../src/prompt-api-core.js";
import { decideWithDecisionModel, probeDecisionModelAvailability } from "../src/decision-api-core.js";

/** @type {AbortController | null} */
let installController = null;

/** @type {Map<string, AbortController>} */
const streamControllers = new Map();

/** Aborts that arrived before the matching stream was registered. */
/** @type {Set<string>} */
const pendingAbortRequestIds = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "prompt-api-offscreen") return false;

  // Handshake so ensurePromptApiOffscreen can wait past createDocument until
  // this module has registered (createDocument resolves before imports finish).
  if (message.type === "prompt-api-ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "prompt-api-availability") {
    void Promise.resolve().then(() => {
      const sessionOptions = promptApiChatOptions(message);
      if (sessionOptions.tools?.length || message.wantsToolHistory) {
        assertPromptApiToolsAvailable();
      }
      return probeLanguageModelAvailability(globalThis, sessionOptions);
    })
      .then((availability) => {
        sendResponse({ ok: true, availability });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          availability: "unavailable",
          code: err?.code,
          error: err instanceof Error ? err.message : "availability failed",
        });
      });
    return true;
  }

  if (message.type === "decision-api-availability") {
    void probeDecisionModelAvailability(globalThis, message.questions)
      .then((availability) => sendResponse({ ok: true, availability }))
      .catch((cause) => sendResponse({ ok: false, availability: "unavailable",
        code: cause?.code || "provider_error", error: cause.message }));
    return true;
  }

  if (message.type === "decision-api-decide") {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) {
      sendResponse({ ok: false, code: "invalid_request", error: "Missing requestId" });
      return false;
    }
    if (pendingAbortRequestIds.delete(requestId)) {
      sendResponse({ ok: false, code: "aborted", error: "Request aborted" });
      return false;
    }
    const controller = new AbortController();
    streamControllers.set(requestId, controller);
    void decideWithDecisionModel({ DecisionModel: globalThis.DecisionModel,
      state: message.state, questions: message.questions, signal: controller.signal })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((cause) => sendResponse({ ok: false, code: cause?.code || "provider_error", error: cause.message }))
      .finally(() => streamControllers.delete(requestId));
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
    // Abort may have arrived while the offscreen doc was still starting.
    if (pendingAbortRequestIds.delete(requestId)) {
      sendResponse({ ok: false, code: "aborted", error: "Request aborted" });
      return false;
    }
    const controller = new AbortController();
    streamControllers.set(requestId, controller);

    /** @type {Promise<unknown>[]} */
    const pendingDeltas = [];

    void streamLanguageModelChat({
      LanguageModel: globalThis.LanguageModel,
      messages: Array.isArray(message.messages) ? message.messages : [],
      tools: message.tools,
      toolChoice: message.toolChoice,
      signal: controller.signal,
      onDelta: (content) => {
        // Track delivery so we do not complete the RPC (and drop the SW
        // listener) while a delta is still in flight.
        pendingDeltas.push(
          chrome.runtime
            .sendMessage({
              type: "prompt-api-stream-delta",
              requestId,
              content,
            })
            .catch(() => {})
        );
      },
    })
      .then(async (result) => {
        await Promise.all(pendingDeltas);
        sendResponse({ ok: true, result });
      })
      .catch(async (err) => {
        await Promise.all(pendingDeltas);
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
    if (controller) {
      controller.abort();
      streamControllers.delete(requestId);
    } else if (requestId) {
      pendingAbortRequestIds.add(requestId);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
