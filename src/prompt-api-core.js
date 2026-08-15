/**
 * Shared Prompt API (LanguageModel) helpers — pure enough to unit-test without Chrome.
 * Used by the offscreen host, Options Install UX, and the on-device provider.
 */

/** Stable provider id (not a company or model name). */
export const ON_DEVICE_PROVIDER_ID = "on-device";

/**
 * IPA `done.model` / grant sentinel — reported, not user-selected.
 * There is no Prompt API model id to choose.
 */
export const ON_DEVICE_MODEL_ID = "on-device";

/**
 * Languages Chrome's Prompt API currently accepts for text I/O.
 * Required on create/availability so Chrome can attest output safety.
 * This is the full supported set today (en, es, ja, de, fr); update when
 * Chrome adds more — see the Prompt API docs.
 * @see https://developer.chrome.com/docs/ai/prompt-api
 */
export const PROMPT_API_LANGUAGES = Object.freeze(["en", "es", "ja", "de", "fr"]);

/**
 * Shared LanguageModel.create / .availability options for text sessions.
 * Chrome warns (and may harden later) if expectedOutputs languages are omitted.
 */
export const PROMPT_API_SESSION_OPTIONS = Object.freeze({
  expectedInputs: Object.freeze([
    Object.freeze({ type: "text", languages: PROMPT_API_LANGUAGES }),
  ]),
  expectedOutputs: Object.freeze([
    Object.freeze({ type: "text", languages: PROMPT_API_LANGUAGES }),
  ]),
});

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
export function throwInference(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  throw error;
}

/**
 * @typedef {"missing" | "unavailable" | "downloadable" | "downloading" | "available"} OnDeviceAvailability
 */

/**
 * Probe LanguageModel in the current global. Does not start a download.
 * @param {typeof globalThis & { LanguageModel?: any }} [scope]
 * @returns {Promise<OnDeviceAvailability>}
 */
export async function probeLanguageModelAvailability(scope = globalThis) {
  const LM = scope.LanguageModel;
  if (!LM || typeof LM.availability !== "function") {
    return "missing";
  }
  try {
    const raw = await LM.availability({ ...PROMPT_API_SESSION_OPTIONS });
    if (
      raw === "unavailable" ||
      raw === "downloadable" ||
      raw === "downloading" ||
      raw === "available"
    ) {
      return raw;
    }
    // Older boolean / "readily" style — treat truthy as available.
    if (raw === true || raw === "readily") return "available";
    if (raw === false || raw === "after-download") return "downloadable";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Map IPA chat messages into Prompt API session + final user prompt.
 * @param {import("./providers/types.js").ChatMessage[]} messages
 * @returns {{ initialPrompts: Array<{ role: string, content: string }>, prompt: string }}
 */
export function mapMessagesForPromptApi(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throwInference("invalid_request", "On-device provider requires at least one message.");
  }

  /** @type {Array<{ role: string, content: string }>} */
  const initialPrompts = [];
  let prompt = "";

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const role = typeof message?.role === "string" ? message.role : "";
    if (role === "tool") {
      throwInference(
        "invalid_request",
        "On-device provider does not support tool result messages."
      );
    }
    if (message?.toolCalls?.length) {
      throwInference(
        "invalid_request",
        "On-device provider does not support assistant tool calls."
      );
    }
    const content =
      typeof message?.content === "string"
        ? message.content
        : message?.content == null
          ? ""
          : String(message.content);

    const isLast = i === messages.length - 1;
    if (isLast) {
      if (role !== "user") {
        throwInference(
          "invalid_request",
          "On-device provider expects the last message to be from the user."
        );
      }
      prompt = content;
      continue;
    }

    if (role === "system" || role === "user" || role === "assistant") {
      initialPrompts.push({ role, content });
    }
  }

  return { initialPrompts, prompt };
}

/**
 * Apply a streaming chunk that may be incremental or cumulative.
 * @param {string} full
 * @param {string} chunk
 * @returns {{ full: string, delta: string }}
 */
export function applyStreamChunk(full, chunk) {
  const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
  if (!text) return { full, delta: "" };
  if (full && text.startsWith(full)) {
    return { full: text, delta: text.slice(full.length) };
  }
  if (text.length >= full.length && full && text.startsWith(full.slice(0, 1))) {
    // Cumulative replacement that diverged slightly — prefer newer full text.
    if (text.startsWith(full)) {
      return { full: text, delta: text.slice(full.length) };
    }
  }
  return { full: full + text, delta: text };
}

/**
 * Download/create the on-device model (Install path). Caller must have user activation
 * when the browser requires it. Destroys the session after create resolves.
 *
 * @param {{
 *   LanguageModel: any,
 *   signal?: AbortSignal,
 *   onProgress?: (loaded: number) => void,
 * }} args
 * @returns {Promise<void>}
 */
export async function installLanguageModel(args) {
  const { LanguageModel: LM, signal, onProgress } = args;
  if (!LM || typeof LM.create !== "function") {
    throwInference("unavailable", "Prompt API (LanguageModel) is not available in this browser.");
  }
  if (signal?.aborted) {
    throwInference("aborted", "Request aborted");
  }

  /** @type {any} */
  let session;
  try {
    session = await LM.create({
      ...PROMPT_API_SESSION_OPTIONS,
      ...(signal ? { signal } : {}),
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const loaded = typeof e?.loaded === "number" ? e.loaded : 0;
          onProgress?.(loaded);
        });
      },
    });
  } catch (err) {
    if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "provider_error",
      err instanceof Error ? err.message : "Failed to install on-device model"
    );
  }

  try {
    session?.destroy?.();
  } catch {
    // ignore destroy errors after successful create
  }
}

/**
 * One-shot chat via promptStreaming.
 * @param {{
 *   LanguageModel: any,
 *   messages: import("./providers/types.js").ChatMessage[],
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 * }} args
 * @returns {Promise<{ model: string, message: { role: "assistant", content: string } }>}
 */
export async function streamLanguageModelChat(args) {
  const { LanguageModel: LM, messages, signal, onDelta } = args;
  if (!LM || typeof LM.create !== "function") {
    throwInference("unavailable", "Prompt API (LanguageModel) is not available in this browser.");
  }
  if (signal.aborted) {
    throwInference("aborted", "Request aborted");
  }

  const availability = await probeLanguageModelAvailability(
    /** @type {any} */ ({ LanguageModel: LM })
  );
  if (availability === "missing" || availability === "unavailable") {
    throwInference(
      "unavailable",
      "On-device AI is unavailable on this device (hardware, OS, or browser flags)."
    );
  }
  if (availability === "downloadable" || availability === "downloading") {
    throwInference(
      "unavailable",
      "Install the on-device model in Inference Bridge Options before using this provider."
    );
  }

  const { initialPrompts, prompt } = mapMessagesForPromptApi(messages);

  /** @type {any} */
  let session;
  try {
    session = await LM.create({
      ...PROMPT_API_SESSION_OPTIONS,
      signal,
      ...(initialPrompts.length > 0 ? { initialPrompts } : {}),
    });
  } catch (err) {
    if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "provider_error",
      err instanceof Error ? err.message : "Failed to create on-device language model session"
    );
  }

  let full = "";
  try {
    const stream = session.promptStreaming(prompt, { signal });
    for await (const chunk of stream) {
      if (signal.aborted) {
        throwInference("aborted", "Request aborted");
      }
      const next = applyStreamChunk(full, chunk);
      full = next.full;
      if (next.delta) onDelta(next.delta);
    }
  } catch (err) {
    if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    if (err && /** @type {any} */ (err).name === "InferenceError") throw err;
    throwInference(
      "provider_error",
      err instanceof Error ? err.message : "On-device prompt failed"
    );
  } finally {
    try {
      session?.destroy?.();
    } catch {
      // ignore
    }
  }

  return {
    model: ON_DEVICE_MODEL_ID,
    message: { role: "assistant", content: full },
  };
}
