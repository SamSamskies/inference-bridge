/**
 * MAIN-world bridge: defines window.inference per SPEC.md.
 * Injected only into top-level frames (manifest all_frames: false).
 *
 * Talks to the isolated content script over a MessagePort established at
 * document_start (before page scripts run), so other MAIN-world scripts
 * cannot observe or forge stream events via window.postMessage.
 */
(() => {
  if (window !== window.top) return;
  if (window.inference) return;

  const CHANNEL = "__ipa_inference__";
  let nextId = 1;
  let nextMediaSourceId = 1;

  /** @type {MessagePort | null} */
  let bridgePort = null;
  /** @type {Map<string, (data: any) => void>} */
  const pending = new Map();
  /** @type {Map<string, (data: any) => void>} */
  const streamHandlers = new Map();
  /** One-shot deprecation notice for experimental.request (alias of request). */
  let warnedExperimentalRequest = false;
  /** One-shot notice for non-normative speech methods. */
  let warnedExperimentalSpeech = false;
  /** Fail-closed cache populated by the isolated content script. */
  let experimentalSpeechEnabled = false;
  /** One-shot nudge: prefer ipa-tools runTools in shipped apps. */
  let warnedExperimentalRunTools = false;

  function warnExperimentalRequestOnce() {
    if (warnedExperimentalRequest) return;
    warnedExperimentalRequest = true;
    console.warn(
      "[Inference Bridge] window.inference.experimental.request is deprecated; " +
        "prefer window.inference.request(). Images, tools, and hosted " +
        "web_search are on the stable surface (see getFeatures)."
    );
  }

  function warnExperimentalSpeechOnce() {
    if (warnedExperimentalSpeech) return;
    warnedExperimentalSpeech = true;
    console.warn(
      "[Inference Bridge] Transcription and speech synthesis are experimental, " +
        "non-normative Bridge methods and may change before IPA standardization."
    );
  }

  function warnExperimentalRunToolsOnce() {
    if (warnedExperimentalRunTools) return;
    warnedExperimentalRunTools = true;
    console.warn(
      "[Inference Bridge] experimental.runTools is a DevTools / no-bundler " +
        "helper. For shipped apps, prefer runTools from the ipa-tools package " +
        "with window.inference.request()."
    );
  }

  /**
   * @param {string} code
   * @param {string} message
   */
  function makeError(code, message) {
    const error = new Error(message || code);
    error.name = "InferenceError";
    /** @type {any} */ (error).code = code;
    return error;
  }

  const IMAGE_MEDIA_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);
  const TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/webm",
    "video/mp4",
    "video/webm",
  ]);

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeImageMediaType(value) {
    if (typeof value !== "string") return "";
    let mime = value.split(";")[0].trim().toLowerCase();
    if (mime === "image/jpg") mime = "image/jpeg";
    return IMAGE_MEDIA_TYPES.has(mime) ? mime : "";
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function mediaTypeFromImageUrl(url) {
    const trimmed = url.trim();
    const dataMatch = /^data:(image\/[a-zA-Z0-9.+-]+)/i.exec(trimmed);
    if (dataMatch) return normalizeImageMediaType(dataMatch[1]);
    try {
      const path = new URL(trimmed, "https://inference.invalid").pathname.toLowerCase();
      if (path.endsWith(".png")) return "image/png";
      if (path.endsWith(".webp")) return "image/webp";
      if (path.endsWith(".gif")) return "image/gif";
      if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    } catch {
      // ignore unparsable urls; fetch will fail instead
    }
    return "";
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Decode bounded public raw base64 into Blob parts without creating one
   * additional whole-payload binary string.
   * @param {string} data
   * @param {string} mediaType
   * @returns {Blob}
   */
  function rawBase64ToBlob(data, mediaType) {
    if (
      !data ||
      data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        data
      )
    ) {
      throw makeError("invalid_request", "media.data must be valid raw base64.");
    }
    const parts = [];
    // Keep slices quartet-aligned and temporary binary strings small.
    const encodedChunkChars = 32 * 1024;
    try {
      for (let offset = 0; offset < data.length; offset += encodedChunkChars) {
        const binary = atob(data.slice(offset, offset + encodedChunkChars));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        parts.push(bytes);
      }
    } catch {
      throw makeError("invalid_request", "media.data must be valid raw base64.");
    }
    return new Blob(parts, { type: mediaType });
  }

  /**
   * @param {unknown} data
   * @returns {Uint8Array}
   */
  function runtimeBase64ToBytes(data) {
    if (typeof data !== "string" || !data) {
      throw makeError("provider_error", "Malformed binary response chunk.");
    }
    let binary;
    try {
      binary = atob(data);
    } catch {
      throw makeError("provider_error", "Malformed binary response chunk.");
    }
    if (!binary.length) {
      throw makeError("provider_error", "Received an empty binary response chunk.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Resolve page-facing transcription input under page CORS and replace it
   * with metadata only. Bytes remain in the MAIN-world Blob until pulled.
   * @param {any} request
   * @param {AbortSignal} [signal]
   */
  async function prepareTranscriptionSource(request, signal) {
    const media = request.media;
    const declaredMediaType =
      typeof media.mediaType === "string" ? media.mediaType : "";
    let source;

    if (typeof media.url === "string" && media.url.trim()) {
      let response;
      try {
        response = await fetch(
          media.url.trim(),
          signal ? { signal } : undefined
        );
      } catch (err) {
        if (
          signal?.aborted ||
          (err && typeof err === "object" && err.name === "AbortError")
        ) {
          throw makeError("aborted", "Request aborted");
        }
        throw makeError(
          "invalid_request",
          "Could not fetch media URL (network or CORS). The page must be allowed to read it."
        );
      }
      if (!response.ok) {
        throw makeError(
          "invalid_request",
          `Media URL returned HTTP ${response.status}.`
        );
      }
      source = await response.blob();
    } else if (
      typeof Blob !== "undefined" &&
      media.data instanceof Blob
    ) {
      source = media.data;
    } else if (typeof media.data === "string") {
      if (!declaredMediaType) {
        throw makeError(
          "invalid_request",
          "media.mediaType is required for raw base64 data."
        );
      }
      source = rawBase64ToBlob(media.data, declaredMediaType);
    } else {
      throw makeError(
        "invalid_request",
        "media must include exactly one of data or url."
      );
    }

    const sourceId = `media_${nextMediaSourceId++}_${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    return {
      request: {
        ...request,
        media: {
          sourceId,
          byteLength: source.size,
          ...(declaredMediaType ? { mediaType: declaredMediaType } : {}),
          ...(source.type ? { detectedMediaType: source.type } : {}),
        },
      },
      source,
    };
  }

  /**
   * Page-facing image parts: spec-shaped `{ mediaType, data }` (base64),
   * `{ data: Blob }`, or `{ url }`. Fetch happens in the page (CORS) so the
   * extension still sends bytes to providers — local Ollama stays offline.
   *
   * @param {any} part
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async function resolveImagePart(part, signal) {
    const url = typeof part.url === "string" ? part.url.trim() : "";
    const blobData =
      typeof Blob !== "undefined" && part.data instanceof Blob ? part.data : null;
    const stringData = typeof part.data === "string" && part.data.trim() ? part.data : "";

    if (url && (blobData || stringData)) {
      throw makeError(
        "invalid_request",
        "Image parts must include url or data, not both."
      );
    }

    if (url) {
      let response;
      try {
        response = await fetch(url, signal ? { signal } : undefined);
      } catch (err) {
        if (
          (signal && signal.aborted) ||
          (err && typeof err === "object" && /** @type {{ name?: string }} */ (err).name === "AbortError")
        ) {
          throw makeError("aborted", "Request aborted");
        }
        throw makeError(
          "invalid_request",
          "Could not fetch image url (network or CORS). The page must be allowed to read it."
        );
      }
      if (!response.ok) {
        throw makeError(
          "invalid_request",
          `Image url returned HTTP ${response.status}.`
        );
      }
      const blob = await response.blob();
      if (!blob || blob.size === 0) {
        throw makeError("invalid_request", "Image url returned an empty body.");
      }
      const mediaType =
        normalizeImageMediaType(part.mediaType) ||
        normalizeImageMediaType(blob.type) ||
        mediaTypeFromImageUrl(url);
      if (!mediaType) {
        throw makeError(
          "invalid_request",
          'Image url must resolve to "image/jpeg", "image/png", "image/webp", or "image/gif". Set mediaType if the server omits Content-Type.'
        );
      }
      return { type: "image", mediaType, data: await blobToBase64(blob) };
    }

    if (blobData) {
      const mediaType =
        normalizeImageMediaType(part.mediaType) ||
        normalizeImageMediaType(blobData.type);
      if (!mediaType) {
        throw makeError(
          "invalid_request",
          'Image Blob must resolve to "image/jpeg", "image/png", "image/webp", or "image/gif". Set mediaType if the Blob type is missing or non-image.'
        );
      }
      return { type: "image", mediaType, data: await blobToBase64(blobData) };
    }

    return part;
  }

  /**
   * Encode image Blobs / fetch image urls to base64 before the extension round-trip.
   * @param {any} request
   * @param {AbortSignal} [signal]
   */
  async function encodeRequestImages(request, signal) {
    if (!request || typeof request !== "object" || !Array.isArray(request.messages)) {
      return request;
    }
    const messages = [];
    for (const message of request.messages) {
      if (!message || !Array.isArray(message.content)) {
        messages.push(message);
        continue;
      }
      const content = await Promise.all(
        message.content.map((part) =>
          part && part.type === "image"
            ? resolveImagePart(part, signal)
            : Promise.resolve(part)
        )
      );
      messages.push({ ...message, content });
    }
    return { ...request, messages };
  }

  function onWindowInit(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== "init") return;
    if (bridgePort || !event.ports || !event.ports[0]) return;

    bridgePort = event.ports[0];
    bridgePort.onmessage = onBridgeMessage;
    window.removeEventListener("message", onWindowInit);
  }

  window.addEventListener("message", onWindowInit);

  /**
   * @param {MessageEvent} event
   */
  function onBridgeMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "feature-state") {
      experimentalSpeechEnabled =
        data.experimentalSpeechEnabled === true;
      return;
    }

    if (typeof data.id === "string" && pending.has(data.id)) {
      const settle = pending.get(data.id);
      pending.delete(data.id);
      settle(data);
      return;
    }

    if (typeof data.streamId === "string" && streamHandlers.has(data.streamId)) {
      streamHandlers.get(data.streamId)(data);
    }
  }

  /**
   * One-shot request/response with the content script over the private port.
   * @param {object} payload
   */
  function sendToExtension(payload) {
    return new Promise((resolve, reject) => {
      if (!bridgePort) {
        reject(makeError("unavailable", "Extension bridge is not ready."));
        return;
      }

      const id = `req_${nextId++}_${Math.random().toString(36).slice(2, 9)}`;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(makeError("unavailable", "Extension did not respond."));
      }, 30_000);

      pending.set(id, (data) => {
        clearTimeout(timeout);
        if (data.error) {
          reject(makeError(data.error.code || "provider_error", data.error.message));
        } else {
          resolve(data);
        }
      });

      try {
        bridgePort.postMessage({ id, ...payload });
      } catch (err) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(
          makeError(
            "unavailable",
            err instanceof Error ? err.message : "Extension unavailable"
          )
        );
      }
    });
  }

  /**
   * Lazy AsyncIterable — the extension call starts when iteration begins.
   * @param {any} request
   * @param {{ experimental?: boolean, preflight?: () => void }} [options]
   */
  function createStream(request, options = {}) {
    const experimental = options.experimental === true;
    const signal = request && typeof request === "object" ? request.signal : undefined;

    return {
      [Symbol.asyncIterator]() {
        /** @type {"idle" | "open" | "closed"} */
        let state = "idle";
        /** @type {Array<{ kind: "chunk", value: any, acknowledge?: number } | { kind: "end" } | { kind: "error", error: Error }>} */
        const queue = [];
        /** @type {Set<() => void>} */
        const waiters = new Set();
        let streamId = "";
        /** @type {(() => void) | null} */
        let onAbort = null;
        /** @type {Promise<void> | null} */
        let startPromise = null;
        /** @type {Error | null} */
        let terminalError = null;
        /** @type {Blob | null} */
        let uploadSource = null;
        let uploadSequence = 0;
        let uploadOffset = 0;
        let uploadBusy = false;

        function wake() {
          if (waiters.size === 0) return;
          const pending = [...waiters];
          waiters.clear();
          for (const n of pending) n();
        }

        function enqueue(item) {
          if (state === "closed" && item.kind !== "error") return;
          queue.push(item);
          wake();
        }

        function cleanupListeners() {
          if (streamId) {
            streamHandlers.delete(streamId);
          }
          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
            onAbort = null;
          }
          uploadSource = null;
          uploadBusy = false;
        }

        function abortRemote() {
          if (!streamId || !bridgePort) return;
          try {
            bridgePort.postMessage({ type: "abort", streamId });
          } catch {
            // ignore
          }
        }

        function closeWithError(error) {
          if (state === "closed") return;
          state = "closed";
          // Keep the error so concurrent next() callers all throw (SPEC §4),
          // not just the one that dequeues the queued error item.
          terminalError = error;
          cleanupListeners();
          enqueue({ kind: "error", error });
        }

        function closeNormally() {
          if (state === "closed") return;
          state = "closed";
          cleanupListeners();
          enqueue({ kind: "end" });
        }

        /**
         * @param {any} data
         */
        function onStreamData(data) {
          if (data.type === "chunk") {
            enqueue({ kind: "chunk", value: data.chunk });
            if (data.chunk?.type === "done") {
              closeNormally();
            }
          } else if (data.type === "error") {
            closeWithError(
              makeError(data.error?.code || "provider_error", data.error?.message)
            );
          } else if (data.type === "binary-pull") {
            void handleUploadPull(data);
          } else if (data.type === "binary-data") {
            try {
              if (!Number.isSafeInteger(data.sequence) || data.sequence < 0) {
                throw makeError(
                  "provider_error",
                  "Malformed binary response sequence."
                );
              }
              const bytes = runtimeBase64ToBytes(data.data);
              enqueue({
                kind: "chunk",
                value: {
                  type: "audio_delta",
                  mediaType: "audio/mpeg",
                  data: bytes,
                },
                acknowledge: data.sequence,
              });
            } catch (err) {
              abortRemote();
              closeWithError(
                err instanceof Error
                  ? err
                  : makeError("provider_error", String(err))
              );
            }
          }
        }

        async function handleUploadPull(data) {
          if (
            !uploadSource ||
            uploadBusy ||
            !Number.isSafeInteger(data.sequence) ||
            data.sequence !== uploadSequence ||
            !Number.isSafeInteger(data.maxBytes) ||
            data.maxBytes <= 0
          ) {
            abortRemote();
            closeWithError(
              makeError("aborted", "Invalid binary upload sequence.")
            );
            return;
          }
          uploadBusy = true;
          try {
            const end = Math.min(
              uploadSource.size,
              uploadOffset + data.maxBytes
            );
            if (end <= uploadOffset) {
              throw makeError("aborted", "Binary upload requested past end.");
            }
            const buffer = await uploadSource
              .slice(uploadOffset, end)
              .arrayBuffer();
            if (state === "closed") return;
            bridgePort.postMessage(
              {
                type: "binary-chunk",
                streamId,
                sequence: uploadSequence,
                byteLength: buffer.byteLength,
                done: end === uploadSource.size,
                data: buffer,
              },
              [buffer]
            );
            uploadOffset = end;
            uploadSequence += 1;
          } catch (err) {
            abortRemote();
            closeWithError(
              err instanceof Error
                ? err
                : makeError("aborted", "Binary upload failed.")
            );
          } finally {
            uploadBusy = false;
          }
        }

        async function start() {
          options.preflight?.();

          if (!window.isSecureContext) {
            throw makeError(
              "unavailable",
              "window.inference is only available in a secure context (HTTPS or localhost)."
            );
          }

          if (signal?.aborted) {
            throw makeError("aborted", "Request aborted");
          }

          let serializable =
            request && typeof request === "object" ? { ...request } : {};
          delete serializable.signal;
          if (experimental && serializable.method === "transcribe") {
            const prepared = await prepareTranscriptionSource(
              serializable,
              signal
            );
            serializable = prepared.request;
            uploadSource = prepared.source;
          } else {
            serializable = await encodeRequestImages(serializable, signal);
          }

          // Register AbortSignal before the round-trip so abort during start
          // marks the iterator closed; abortRemote runs once streamId exists.
          if (signal) {
            if (signal.aborted) {
              throw makeError("aborted", "Request aborted");
            }
            onAbort = () => {
              abortRemote();
              closeWithError(makeError("aborted", "Request aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }

          const started = await sendToExtension({
            type: "start",
            request: serializable,
            ...(experimental ? { experimental: true } : {}),
          });

          streamId = started.streamId;

          // return()/throw()/AbortSignal may have closed us while start was
          // in flight — abortRemote was a no-op without streamId, so do it now.
          if (state === "closed") {
            abortRemote();
            cleanupListeners();
            return;
          }

          state = "open";
          streamHandlers.set(streamId, onStreamData);

          if (signal?.aborted) {
            abortRemote();
            throw makeError("aborted", "Request aborted");
          }
        }

        /**
         * Close locally and ensure any in-flight start still aborts the remote
         * once streamId is known.
         */
        async function closeLocal() {
          state = "closed";
          terminalError = null;
          queue.length = 0;
          wake();

          if (startPromise) {
            try {
              await startPromise;
            } catch {
              // Ignore start failures after the consumer already closed.
            }
          }

          abortRemote();
          cleanupListeners();
        }

        return {
          async next() {
            if (state === "idle") {
              // Share one in-flight start across concurrent next() callers.
              if (!startPromise) {
                startPromise = start().catch((err) => {
                  state = "closed";
                  terminalError = err instanceof Error ? err : makeError("provider_error", String(err));
                  cleanupListeners();
                  throw err;
                });
              }
              await startPromise;
            }

            while (true) {
              if (queue.length > 0) {
                const item = queue.shift();
                if (item.kind === "chunk") {
                  if (
                    item.acknowledge !== undefined &&
                    streamId &&
                    bridgePort
                  ) {
                    bridgePort.postMessage({
                      type: "binary-ack",
                      streamId,
                      sequence: item.acknowledge,
                    });
                  }
                  return { value: item.value, done: false };
                }
                if (item.kind === "end") return { value: undefined, done: true };
                if (item.kind === "error") throw item.error;
              }

              if (state === "closed") {
                // Concurrent next() may miss the queued error item after another
                // caller already shifted it — still throw the terminal failure.
                if (terminalError) throw terminalError;
                return { value: undefined, done: true };
              }

              await new Promise((resolve) => {
                waiters.add(resolve);
              });
            }
          },

          async return() {
            await closeLocal();
            return { value: undefined, done: true };
          },

          async throw(err) {
            await closeLocal();
            throw err;
          },
        };
      },
    };
  }

  /**
   * Page-side tool loop. Keep in sync with src/run-tools.js (unit-tested).
   * @param {any} options
   */
  async function runTools(options) {
    if (options == null || typeof options !== "object") {
      throw makeError("invalid_request", "runTools options must be an object.");
    }

    warnExperimentalRunToolsOnce();

    const {
      tools,
      execute,
      maxRounds = 5,
      toolChoice,
      onDelta,
      onReasoningDelta,
      onToolCall,
      signal,
      method = "chat",
    } = options;

    if (!Array.isArray(options.messages)) {
      throw makeError("invalid_request", "runTools requires a messages array.");
    }
    if (typeof maxRounds !== "number" || !Number.isFinite(maxRounds) || maxRounds < 1) {
      throw makeError("invalid_request", "maxRounds must be a positive number.");
    }

    /** @type {any[]} */
    let messages = [...options.messages];

    for (let round = 0; round < maxRounds; round++) {
      if (signal?.aborted) {
        throw makeError("aborted", "Request aborted");
      }

      /** @type {Record<string, unknown>} */
      const req = {
        method,
        messages,
        signal,
      };
      if (tools !== undefined) req.tools = tools;
      if (toolChoice !== undefined) req.toolChoice = toolChoice;

      /** @type {any} */
      let done;
      // Stable request (images + tools graduated); avoid experimental.request warn.
      for await (const chunk of createStream(req)) {
        if (signal?.aborted) {
          throw makeError("aborted", "Request aborted");
        }
        if (!chunk || typeof chunk !== "object") continue;
        if (chunk.type === "delta" && typeof onDelta === "function") {
          onDelta(chunk.content);
        } else if (
          chunk.type === "reasoning_delta" &&
          typeof onReasoningDelta === "function"
        ) {
          onReasoningDelta(chunk.content);
        } else if (chunk.type === "done") {
          done = chunk;
        }
      }

      if (!done || typeof done !== "object") {
        throw makeError("provider_error", "Stream ended without a done chunk.");
      }

      const message = done.message;
      const toolCalls =
        message &&
        typeof message === "object" &&
        Array.isArray(message.toolCalls) &&
        message.toolCalls.length > 0
          ? message.toolCalls
          : null;

      if (!toolCalls) {
        if (message && typeof message === "object") {
          messages = [...messages, message];
        }
        return { messages, final: done };
      }

      /** @type {Record<string, unknown>} */
      const assistantMessage = {
        role: "assistant",
        content: message.content ?? null,
        toolCalls,
      };
      if (typeof message.reasoning === "string" && message.reasoning) {
        assistantMessage.reasoning = message.reasoning;
      }

      messages = [...messages, assistantMessage];

      for (const call of toolCalls) {
        if (signal?.aborted) {
          throw makeError("aborted", "Request aborted");
        }

        const name =
          call &&
          typeof call === "object" &&
          call.function &&
          typeof call.function === "object"
            ? call.function.name
            : undefined;

        if (typeof name !== "string" || !name) {
          throw makeError("provider_error", "Tool call is missing a function name.");
        }

        const executor =
          execute && typeof execute === "object" ? execute[name] : undefined;
        if (typeof executor !== "function") {
          throw makeError(
            "invalid_request",
            `No execute handler for tool "${name}".`
          );
        }

        const rawArgs =
          call.function.arguments == null || call.function.arguments === ""
            ? "{}"
            : call.function.arguments;
        let args;
        try {
          args = JSON.parse(rawArgs);
        } catch (err) {
          throw makeError(
            "invalid_request",
            `Tool "${name}" arguments are not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }

        if (typeof onToolCall === "function") {
          onToolCall({ id: call.id, name, arguments: args });
        }

        const result = await executor(args);
        if (signal?.aborted) {
          throw makeError("aborted", "Request aborted");
        }
        const content =
          typeof result === "string"
            ? result
            : (() => {
                try {
                  // JSON.stringify(undefined) (and some other values) returns undefined, not a string.
                  const json = JSON.stringify(result);
                  return typeof json === "string" ? json : "null";
                } catch (err) {
                  throw makeError(
                    "invalid_request",
                    `Tool result is not JSON-serializable: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  );
                }
              })();

        messages = [
          ...messages,
          {
            role: "tool",
            toolCallId: call.id,
            content,
          },
        ];
      }
    }

    throw makeError(
      "provider_error",
      `Tool loop exceeded maxRounds (${maxRounds}).`
    );
  }

  const EXPERIMENTAL_CHAT_FIELDS = new Set([
    "method",
    "messages",
    "tools",
    "toolChoice",
    "options",
    "output",
    "signal",
  ]);
  const EXPERIMENTAL_TRANSCRIBE_FIELDS = new Set([
    "method",
    "media",
    "language",
    "signal",
  ]);
  const EXPERIMENTAL_SYNTHESIZE_FIELDS = new Set([
    "method",
    "text",
    "output",
    "signal",
  ]);
  const EXPERIMENTAL_MEDIA_FIELDS = new Set(["data", "url", "mediaType"]);

  /**
   * @param {any} request
   * @param {Set<string>} fields
   */
  function assertClosedRequest(request, fields) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw makeError("invalid_request", "Request must be an object.");
    }
    const unknown = Object.keys(request).find((key) => !fields.has(key));
    if (unknown) {
      throw makeError(
        "invalid_request",
        `Field "${unknown}" is not valid for method "${request.method}".`
      );
    }
  }

  /**
   * Page-side shape checks run lazily before any extension/provider work.
   * Bounds and MIME normalization are repeated by the worker from src/speech.js.
   * @param {any} request
   */
  function preflightExperimentalSpeechRequest(request) {
    if (!experimentalSpeechEnabled) {
      throw makeError(
        "invalid_request",
        "Experimental speech methods are disabled in Inference Bridge Options."
      );
    }

    if (request.method === "transcribe") {
      assertClosedRequest(request, EXPERIMENTAL_TRANSCRIBE_FIELDS);
      const media = request.media;
      if (!media || typeof media !== "object" || Array.isArray(media)) {
        throw makeError("invalid_request", "media must be an object.");
      }
      const unknown = Object.keys(media).find(
        (key) => !EXPERIMENTAL_MEDIA_FIELDS.has(key)
      );
      if (unknown) {
        throw makeError(
          "invalid_request",
          `Field "media.${unknown}" is not valid for transcription.`
        );
      }
      const hasData = Object.prototype.hasOwnProperty.call(media, "data");
      const hasUrl = Object.prototype.hasOwnProperty.call(media, "url");
      if (hasData === hasUrl) {
        throw makeError(
          "invalid_request",
          "media must include exactly one of data or url."
        );
      }
      if (
        media.mediaType !== undefined &&
        typeof media.mediaType !== "string"
      ) {
        throw makeError("invalid_request", "media.mediaType must be a string.");
      }
      if (
        request.language !== undefined &&
        typeof request.language !== "string"
      ) {
        throw makeError("invalid_request", "language must be a BCP 47 string.");
      }
    } else {
      assertClosedRequest(request, EXPERIMENTAL_SYNTHESIZE_FIELDS);
      if (typeof request.text !== "string" || !request.text.trim()) {
        throw makeError("invalid_request", "text must be a non-empty string.");
      }
      if (request.output !== undefined) {
        if (
          !request.output ||
          typeof request.output !== "object" ||
          Array.isArray(request.output)
        ) {
          throw makeError("invalid_request", "output must be an object.");
        }
        const unknown = Object.keys(request.output).find(
          (key) => key !== "mediaType"
        );
        if (unknown) {
          throw makeError(
            "invalid_request",
            `Field "output.${unknown}" is not valid for synthesis.`
          );
        }
        if (
          request.output.mediaType !== undefined &&
          request.output.mediaType !== "audio/mpeg"
        ) {
          throw makeError(
            "invalid_request",
            'output.mediaType must be "audio/mpeg".'
          );
        }
      }
    }

  }

  /**
   * @param {any} request
   */
  function createExperimentalStream(request) {
    const method =
      request && typeof request === "object" ? request.method : undefined;
    if (method === "chat") {
      warnExperimentalRequestOnce();
      return createStream(request, {
        experimental: true,
        preflight() {
          assertClosedRequest(request, EXPERIMENTAL_CHAT_FIELDS);
        },
      });
    }
    if (method === "transcribe" || method === "synthesize") {
      warnExperimentalSpeechOnce();
      return createStream(request, {
        experimental: true,
        preflight() {
          preflightExperimentalSpeechRequest(request);
        },
      });
    }
    return createStream(request, {
      experimental: true,
      preflight() {
        throw makeError(
          "invalid_request",
          'method must be "chat", "transcribe", or "synthesize".'
        );
      },
    });
  }

  Object.defineProperty(window, "inference", {
    value: Object.freeze({
      request(request) {
        return createStream(request);
      },
      /**
       * Snapshot of stable IPA surface. Sync; no prompt, permission, or I/O.
       * toolCalling / webSearch / imageInput / imageOutput advertise optional
       * request fields. options.reasoningEffort / options.temperature are
       * advertised once Bridge validates and maps them.
       */
      getFeatures() {
        return {
          toolCalling: true,
          webSearch: true,
          imageInput: true,
          imageOutput: true,
          options: { reasoningEffort: true, temperature: true },
        };
      },
      experimental: Object.freeze({
        request(request) {
          return createExperimentalStream(request);
        },
        getFeatures() {
          return {
            methods: {
              chat: true,
              ...(experimentalSpeechEnabled
                ? {
                    transcribe: {
                      acceptedMedia: TRANSCRIPTION_MEDIA_TYPES.map(
                        (mediaType) => ({ mediaType })
                      ),
                    },
                    synthesize: true,
                  }
                : {}),
            },
          };
        },
        runTools,
      }),
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
})();
