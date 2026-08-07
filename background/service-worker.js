/**
 * Service worker: permission gating, provider orchestration, streaming.
 */

import { serializeInferenceError } from "../src/errors.js";
import {
  validateInferenceRequest,
  isValidOrigin,
} from "../src/validate.js";
import { getSettings } from "../src/storage.js";
import {
  ensurePermission,
  resolveApproval,
  getPendingApproval,
  handleApprovalWindowClosed,
  cancelApproval,
} from "../src/permissions.js";
import {
  getProvider,
  listProviders,
  resolveProviderModels,
} from "../src/providers/registry.js";
import { ensureOllamaOriginBypass } from "../src/ollama-origin-bypass.js";

// Drop chrome-extension Origin so local Ollama does not 403 chat requests.
// Provider calls await their own retry; this eager attempt must not create an
// unhandled rejection if Chrome rejects the rule update during worker startup.
void ensureOllamaOriginBypass().catch(() => {});

/** @typedef {"awaiting_permission" | "streaming"} StreamPhase */

/** @type {Map<string, {
 *   port: chrome.runtime.Port,
 *   controller: AbortController,
 *   tabId?: number,
 *   phase: StreamPhase,
 *   portDisconnected?: boolean,
 *   announced?: boolean,
 * }>} */
const activeStreams = new Map();

let streamCounter = 0;

function nextStreamId() {
  streamCounter += 1;
  return `stream_${Date.now()}_${streamCounter}`;
}

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

chrome.runtime.onConnect.addListener((port) => {
  // Approval popup pings this port so Chrome resets the SW idle timer while the
  // user decides (connect alone is not enough in current Chrome).
  if (port.name === "ipa-approval") {
    port.onMessage.addListener(() => {
      // Receiving the ping is the keepalive; no reply needed.
    });
    return;
  }

  if (port.name !== "ipa-inference") return;

  /** @type {string | null} */
  let boundStreamId = null;

  port.onMessage.addListener((msg) => {
    // Content-script keepalive during approval wait and long generations.
    if (msg.type === "ping") return;
    if (msg.type === "start") {
      void handleStart(port, msg, (id) => {
        boundStreamId = id;
      });
      return;
    }
    if (msg.type === "started-ack") {
      const id = typeof msg.streamId === "string" ? msg.streamId : "";
      const entry = id ? activeStreams.get(id) : undefined;
      if (entry && entry.phase === "awaiting_permission" && entry.port === port) {
        entry.announced = true;
        boundStreamId = id;
      }
      return;
    }
    if (msg.type === "rebind") {
      const id = typeof msg.streamId === "string" ? msg.streamId : "";
      const entry = id ? activeStreams.get(id) : undefined;
      const senderTabId = port.sender?.tab?.id;
      // Only the originating tab may rebind — streamId alone must not let
      // another tab take over an awaiting_permission stream.
      const sameTab =
        entry?.tabId != null &&
        senderTabId != null &&
        senderTabId === entry.tabId;
      if (entry && entry.phase === "awaiting_permission" && sameTab) {
        entry.port = port;
        entry.portDisconnected = false;
        // Rebind proves the content script has streamId (started-ack may have
        // been lost on the superseded port). Soft-disconnect needs announced.
        entry.announced = true;
        boundStreamId = id;
        try {
          port.postMessage({ type: "rebind-ok", streamId: id });
        } catch {
          // ignore
        }
      } else {
        try {
          port.postMessage({ type: "rebind-fail", streamId: id });
        } catch {
          // ignore
        }
      }
      return;
    }
    if (msg.type === "abort") {
      const id = typeof msg.streamId === "string" ? msg.streamId : boundStreamId;
      if (id) abortStream(id, "Request aborted");
    }
  });

  port.onDisconnect.addListener(() => {
    if (!boundStreamId) return;
    const entry = activeStreams.get(boundStreamId);
    // Ignore disconnect from a superseded port after a successful rebind —
    // otherwise portDisconnected flips true again and Approve waits forever.
    if (entry && entry.port !== port) return;
    // While the approval popup is open, a brief port drop must not cancel the
    // pending decision — the content script may rebind, and a late Approve
    // should still resolve. Only after the content script acks "started"
    // (announced); before that it has no streamId and cannot rebind.
    if (entry?.phase === "awaiting_permission" && entry.announced) {
      entry.portDisconnected = true;
      return;
    }
    abortStream(boundStreamId, "Port disconnected");
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-approval") {
    sendResponse({ request: getPendingApproval(message.requestId) });
    return false;
  }

  if (message?.type === "resolve-approval") {
    sendResponse({
      ok: resolveApproval(message.requestId, {
        decision: message.decision,
        providerId: message.providerId,
        model: message.model,
      }),
    });
    return false;
  }

  if (message?.type === "list-providers") {
    sendResponse({
      providers: listProviders().map((p) => ({
        id: p.id,
        label: p.label,
        requiresApiKey: Boolean(p.requiresApiKey),
        defaultModel: p.defaultModel,
        // Static catalogs only; dynamic providers omit models here.
        // Normalize string entries to ModelInfo so the UI always sees { id, label? }.
        models: p.models
          ? p.models.map((entry) =>
              typeof entry === "string" ? { id: entry } : entry
            )
          : undefined,
      })),
    });
    return false;
  }

  if (message?.type === "list-models") {
    const providerId =
      typeof message.providerId === "string" ? message.providerId : "";
    const provider = getProvider(providerId);
    if (!provider) {
      sendResponse({
        ok: false,
        error: { code: "invalid_request", message: `Unknown provider: ${providerId}` },
      });
      return false;
    }

    void resolveProviderModels(provider)
      .then((models) => {
        sendResponse({
          ok: true,
          providerId: provider.id,
          models,
          defaultModel: provider.defaultModel,
        });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          providerId: provider.id,
          error: {
            code: /** @type {any} */ (err)?.code || "unavailable",
            message:
              err instanceof Error
                ? err.message
                : "Failed to list models for provider",
          },
        });
      });
    return true; // async sendResponse
  }

  return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
  handleApprovalWindowClosed(windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, entry] of activeStreams.entries()) {
    if (entry.tabId === tabId) {
      abortStream(id, "Tab closed");
    }
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * @param {chrome.runtime.Port} port
 * @param {any} msg
 * @param {(id: string) => void} onStreamId
 * @returns {Promise<string | null>}
 */
async function handleStart(port, msg, onStreamId) {
  const streamId = nextStreamId();
  const controller = new AbortController();
  const tabId = port.sender?.tab?.id;

  activeStreams.set(streamId, {
    port,
    controller,
    tabId,
    phase: "awaiting_permission",
    announced: false,
  });
  onStreamId(streamId);

  /**
   * @param {string} code
   * @param {string} message
   */
  const sendError = (code, message) => {
    const entry = activeStreams.get(streamId);
    const target = entry?.port || port;
    try {
      target.postMessage({
        type: "error",
        error: serializeInferenceError(code, message),
      });
    } catch {
      // ignore
    }
  };

  try {
    const origin = typeof msg.origin === "string" ? msg.origin : "";
    const pageUrl = typeof msg.pageUrl === "string" ? msg.pageUrl : "";
    if (!isValidOrigin(origin)) {
      sendError("invalid_request", "Invalid origin.");
      activeStreams.delete(streamId);
      return null;
    }

    if (pageUrl && !isPageSecureContext(pageUrl)) {
      sendError(
        "unavailable",
        "window.inference is only available in a secure context."
      );
      activeStreams.delete(streamId);
      return null;
    }

    const validated = validateInferenceRequest(msg.request);
    if (!validated.ok) {
      sendError("invalid_request", validated.message);
      activeStreams.delete(streamId);
      return null;
    }

    // Acknowledge so the page can attach stream listeners before permission UI.
    // Do not set announced here — wait for started-ack so a disconnect in the
    // delivery gap aborts instead of orphaning an approval the page cannot rebind.
    port.postMessage({ type: "started", streamId });

    const permission = await ensurePermission({
      requestId: streamId,
      origin,
      messages: validated.value.messages,
    });

    // Aborted while the permission prompt was open (tab closed / explicit abort).
    let entry = activeStreams.get(streamId);
    if (!entry || controller.signal.aborted) {
      return streamId;
    }

    // Inference port may have dropped briefly; wait for content-script rebind
    // so Approve or Deny can still deliver to the page (posting to a stale
    // port would drop permission_denied and surface as aborted instead).
    // After Approve, wait until rebind (or abort): the content script retries
    // every few seconds while still awaiting an outcome, so a short timeout
    // would delete the stream while retries continue and abandon a granted
    // request. Deny still uses a bounded wait so we do not hang forever.
    if (entry.portDisconnected) {
      entry = await waitForPortRebind(
        streamId,
        permission.allowed ? Infinity : 3000
      );
      if (controller.signal.aborted) {
        activeStreams.delete(streamId);
        return streamId;
      }
      if (!entry) {
        if (!permission.allowed) {
          throwInference("permission_denied", "Permission denied by user.");
        }
        // Stream removed without abort (should be rare with unbounded wait).
        sendError(
          "aborted",
          "Extension disconnected before the request could continue."
        );
        activeStreams.delete(streamId);
        return streamId;
      }
    }

    if (!permission.allowed) {
      throwInference("permission_denied", "Permission denied by user.");
    }

    entry.phase = "streaming";
    const livePort = entry.port;

    const settings = await getSettings();
    const provider = getProvider(permission.providerId);
    if (!provider) {
      throwInference(
        "unavailable",
        `Unknown provider "${permission.providerId}". Open the Inference Bridge options and update this site's grant.`
      );
    }

    if (provider.requiresApiKey && !settings.apiKeys[provider.id]) {
      throwInference(
        "unavailable",
        `${provider.label} API key not configured. Open the Inference Bridge options to add your key.`
      );
    }

    // A saved grant can outlive or differ from the global default provider.
    // Never use settings.defaultModel here: it may name a model belonging to
    // another provider.
    const model = permission.model || provider.defaultModel;
    if (!model) {
      if (provider.id === "ollama") {
        throwInference(
          "unavailable",
          "No Ollama model selected. Start Ollama, pull a model (e.g. ollama pull gemma4), then choose it in the extension."
        );
      }
      if (provider.id === "openrouter") {
        throwInference(
          "unavailable",
          "No OpenRouter model selected. Choose a model in the extension Options or approval dialog."
        );
      }
      throwInference("unavailable", "No model selected for this provider.");
    }

    // SPEC: exactly one accepted chunk after permission/preflight, before provider work.
    livePort.postMessage({
      type: "chunk",
      chunk: { type: "accepted" },
    });

    const result = await provider.streamChat({
      apiKey: settings.apiKeys[provider.id],
      model,
      messages: validated.value.messages,
      signal: controller.signal,
      onDelta: (content) => {
        if (controller.signal.aborted) return;
        try {
          entry.port.postMessage({
            type: "chunk",
            chunk: { type: "delta", content },
          });
        } catch {
          controller.abort();
        }
      },
    });

    if (controller.signal.aborted) {
      throwInference("aborted", "Request aborted");
    }

    // Still tracked? Port may have already aborted/cleaned up.
    if (!activeStreams.has(streamId)) {
      return streamId;
    }

    entry.port.postMessage({
      type: "chunk",
      chunk: {
        type: "done",
        model: result.model,
        message: result.message,
        usage: result.usage,
      },
    });
    activeStreams.delete(streamId);
    return streamId;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code || "provider_error";
    const message = err instanceof Error ? err.message : "Inference failed";
    if (activeStreams.has(streamId)) {
      sendError(code, message);
    }
    cancelApproval(streamId);
    activeStreams.delete(streamId);
    return streamId;
  }
}

/**
 * @param {string} streamId
 * @param {string} reason
 */
function abortStream(streamId, reason) {
  const entry = activeStreams.get(streamId);
  cancelApproval(streamId);
  if (!entry) return;

  activeStreams.delete(streamId);
  try {
    entry.controller.abort();
  } catch {
    // ignore
  }
  try {
    entry.port.postMessage({
      type: "error",
      error: serializeInferenceError("aborted", reason),
    });
  } catch {
    // ignore
  }
}

/**
 * Wait until the content script rebinds the inference port after a disconnect
 * during the approval wait, or until timeout / stream removal / abort.
 * @param {string} streamId
 * @param {number} timeoutMs Use Infinity to wait until rebind or abort.
 * @returns {Promise<{
 *   port: chrome.runtime.Port,
 *   controller: AbortController,
 *   tabId?: number,
 *   phase: StreamPhase,
 *   portDisconnected?: boolean,
 *   announced?: boolean,
 * } | null>}
 */
async function waitForPortRebind(streamId, timeoutMs) {
  const deadline = Number.isFinite(timeoutMs)
    ? Date.now() + timeoutMs
    : Infinity;
  while (Date.now() < deadline) {
    const entry = activeStreams.get(streamId);
    if (!entry || entry.controller.signal.aborted) return null;
    if (!entry.portDisconnected) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const entry = activeStreams.get(streamId);
  if (!entry || entry.portDisconnected || entry.controller.signal.aborted) {
    return null;
  }
  return entry;
}

/**
 * @param {string} pageUrl
 */
function isPageSecureContext(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      return (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]"
      );
    }
    return false;
  } catch {
    return false;
  }
}
