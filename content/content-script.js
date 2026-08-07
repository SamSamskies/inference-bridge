/**
 * ISOLATED-world content script: relays between page (MAIN) and service worker.
 *
 * Establishes a MessageChannel with the MAIN-world bridge at document_start
 * (before page scripts run). Stream traffic stays on that port so other
 * MAIN-world scripts cannot forge or sniff window.postMessage events.
 */
(() => {
  const CHANNEL = "__ipa_inference__";
  /** How long to wait for a successful rebind after a mid-approval port drop. */
  const REBIND_TIMEOUT_MS = 3000;
  /** Ping interval so Chrome resets the SW idle timer during approval + generation. */
  const KEEP_ALIVE_MS = 20_000;

  /** @type {Map<string, chrome.runtime.Port>} */
  const ports = new Map();

  const { port1: bridgePort, port2 } = new MessageChannel();

  bridgePort.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "start") {
      handleStart(data);
      return;
    }

    if (data.type === "abort") {
      const port = ports.get(data.streamId);
      if (port) {
        try {
          port.postMessage({ type: "abort", streamId: data.streamId });
        } catch {
          // ignore
        }
      }
    }
  };

  // inject.js is listed first in the manifest so its init listener is ready.
  window.postMessage({ channel: CHANNEL, direction: "init" }, "*", [port2]);

  /**
   * @param {any} data
   */
  function handleStart(data) {
    const correlationId = data.id;

    /**
     * @param {object} payload
     */
    function postToPage(payload) {
      try {
        bridgePort.postMessage(payload);
      } catch {
        // ignore — page may have navigated away
      }
    }

    let port;
    try {
      port = chrome.runtime.connect({ name: "ipa-inference" });
    } catch (err) {
      postToPage({
        id: correlationId,
        error: {
          code: "unavailable",
          message: err instanceof Error ? err.message : "Extension unavailable",
        },
      });
      return;
    }

    let streamId = "";
    let started = false;
    /** True once we have a terminal chunk/error for the page — no rebind. */
    let gotOutcome = false;
    let cleanedUp = false;
    let rebindAttempted = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let rebindTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let keepAliveTimer = null;

    function pingKeepAlive() {
      if (cleanedUp) return;
      try {
        port.postMessage({ type: "ping" });
      } catch {
        // ignore — disconnect handler will clean up
      }
    }

    function startKeepAlive() {
      stopKeepAlive();
      pingKeepAlive();
      keepAliveTimer = setInterval(pingKeepAlive, KEEP_ALIVE_MS);
    }

    function stopKeepAlive() {
      if (keepAliveTimer != null) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    }

    /**
     * @param {chrome.runtime.Port} nextPort
     */
    function attachPortListeners(nextPort) {
      nextPort.onMessage.addListener((msg) => {
        if (msg.type === "started") {
          streamId = msg.streamId;
          ports.set(streamId, nextPort);
          started = true;
          postToPage({
            id: correlationId,
            streamId,
          });
          return;
        }

        if (msg.type === "rebind-ok") {
          if (rebindTimer != null) {
            clearTimeout(rebindTimer);
            rebindTimer = null;
          }
          ports.set(streamId, nextPort);
          return;
        }

        if (msg.type === "rebind-fail") {
          failDisconnected();
          return;
        }

        if (msg.type === "chunk") {
          gotOutcome = true;
          postToPage({
            streamId,
            type: "chunk",
            chunk: msg.chunk,
          });
          // Final done chunk ends the stream — drop the port map entry and disconnect.
          if (msg.chunk?.type === "done") {
            cleanup();
          }
          return;
        }

        if (msg.type === "error") {
          gotOutcome = true;
          if (!started) {
            postToPage({
              id: correlationId,
              error: msg.error,
            });
          } else {
            postToPage({
              streamId,
              type: "error",
              error: msg.error,
            });
          }
          cleanup();
        }
      });

      nextPort.onDisconnect.addListener(() => {
        if (cleanedUp) return;
        // During approval wait, try one rebind so a brief worker/port drop does
        // not abort the page while the approval popup is still open.
        if (started && !gotOutcome && streamId && !rebindAttempted) {
          if (attemptRebind()) return;
        }
        failDisconnected();
      });
    }

    function failDisconnected() {
      if (cleanedUp) return;
      if (!started) {
        postToPage({
          id: correlationId,
          error: {
            code: "unavailable",
            message: chrome.runtime.lastError?.message || "Extension disconnected",
          },
        });
      } else {
        postToPage({
          streamId,
          type: "error",
          error: { code: "aborted", message: "Extension disconnected" },
        });
      }
      cleanup();
    }

    /**
     * @returns {boolean} true if a rebind attempt was started
     */
    function attemptRebind() {
      rebindAttempted = true;
      let nextPort;
      try {
        nextPort = chrome.runtime.connect({ name: "ipa-inference" });
      } catch {
        return false;
      }

      port = nextPort;
      attachPortListeners(nextPort);
      try {
        nextPort.postMessage({ type: "rebind", streamId });
      } catch {
        return false;
      }

      rebindTimer = setTimeout(() => {
        rebindTimer = null;
        if (!cleanedUp && !gotOutcome) failDisconnected();
      }, REBIND_TIMEOUT_MS);
      return true;
    }

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      stopKeepAlive();
      if (rebindTimer != null) {
        clearTimeout(rebindTimer);
        rebindTimer = null;
      }
      if (streamId) ports.delete(streamId);
      try {
        port.disconnect();
      } catch {
        // ignore
      }
    }

    attachPortListeners(port);
    startKeepAlive();

    try {
      // Always use the tab's real origin — never trust a page-claimed origin.
      port.postMessage({
        type: "start",
        request: data.request,
        origin: location.origin,
        pageUrl: location.href,
      });
    } catch (err) {
      postToPage({
        id: correlationId,
        error: {
          code: "unavailable",
          message: err instanceof Error ? err.message : "Failed to start request",
        },
      });
      cleanup();
    }
  }
})();
