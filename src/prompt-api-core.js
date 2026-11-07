/**
 * Shared Prompt API (LanguageModel) helpers — pure enough to unit-test without Chrome.
 * Used by the offscreen host, Options Install UX, and the on-device provider.
 */

import {
  isImageMediaType,
  messagesHaveImageParts,
  rawImageBase64,
} from "./image-parts.js";

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
 * Session options for turns that include IPA image parts.
 * Prompt API output is still text-only.
 */
export const PROMPT_API_VISION_SESSION_OPTIONS = Object.freeze({
  expectedInputs: Object.freeze([
    Object.freeze({ type: "text", languages: PROMPT_API_LANGUAGES }),
    Object.freeze({ type: "image" }),
  ]),
  expectedOutputs: PROMPT_API_SESSION_OPTIONS.expectedOutputs,
});

/**
 * Build native tool declarations without silently weakening toolChoice.
 * @param {{ wantsImage?: boolean, tools?: import("./providers/types.js").Tool[], toolChoice?: import("./providers/types.js").ToolChoice, wantsToolHistory?: boolean }} [options]
 * @see https://github.com/webmachinelearning/prompt-api#tool-use
 */
export function promptApiChatOptions({ wantsImage = false, tools = [], toolChoice, wantsToolHistory = false } = {}) {
  const functions = tools.filter((tool) => tool.type === "function");
  if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none") {
    throwInference("unavailable", 'On-device supports toolChoice "auto" and "none" only.');
  }
  const active = toolChoice === "none" ? [] : functions;
  const base = wantsImage ? PROMPT_API_VISION_SESSION_OPTIONS : PROMPT_API_SESSION_OPTIONS;
  const declarations = active.map(({ function: fn }) => {
    const inputSchema = fn.parameters ?? { type: "object", properties: {} };
    if (inputSchema.type !== "object") {
      throwInference("invalid_request", "On-device function parameters must have type object.");
    }
    return { name: fn.name, ...(fn.description ? { description: fn.description } : {}), inputSchema };
  });
  return {
    ...base,
    expectedInputs: [...base.expectedInputs,
      ...(active.length || wantsToolHistory ? [{ type: "tool-response" }] : []),
      ...(wantsToolHistory ? [{ type: "tool-call" }] : [])],
    expectedOutputs: [...base.expectedOutputs, ...(active.length ? [{ type: "tool-call" }] : [])],
    ...(declarations.length ? { tools: declarations } : {}),
  };
}

/** @param {import("./providers/types.js").ChatMessage[]} messages */
export function messagesHaveToolHistory(messages) {
  return messages.some((message) => message.role === "tool" || message.toolCalls?.length);
}

/** The native interfaces are gated by the same flag as tool use. */
export function assertPromptApiToolsAvailable(scope = globalThis) {
  if (!["LanguageModelToolCall", "LanguageModelToolSuccess", "LanguageModelToolError"]
    .every((name) => typeof scope[name] === "function")) {
    throwInference("unavailable", "On-device tool calling requires chrome://flags/#prompt-api-tool-use. Enable it and relaunch Chrome.");
  }
}

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
 * Fail closed unless the on-device model is ready to create a session.
 * Shared by stream and by the service worker so `accepted` is not sent first.
 * When `wantsImage` is set, uses vision error copy: text can be available
 * while image input is still downloadable or unsupported.
 * @param {OnDeviceAvailability} availability
 * @param {{ wantsImage?: boolean }} [options]
 * @returns {void}
 */
export function assertOnDeviceAvailable(availability, options = {}) {
  if (availability === "available") return;
  if (options.wantsImage) {
    if (availability === "downloadable" || availability === "downloading") {
      throwInference(
        "unavailable",
        "On-device vision is not installed. Re-run Install in Options, then try again."
      );
    }
    throwInference(
      "unavailable",
      "On-device vision is not available in this browser."
    );
  }
  if (availability === "downloadable" || availability === "downloading") {
    throwInference(
      "unavailable",
      "Install the on-device model in Inference Bridge Options before using this provider."
    );
  }
  throwInference(
    "unavailable",
    "On-device AI is unavailable on this device (hardware, OS, or browser flags)."
  );
}

/**
 * Probe LanguageModel in the current global. Does not start a download.
 * @param {typeof globalThis & { LanguageModel?: any }} [scope]
 * @returns {Promise<OnDeviceAvailability>}
 */
export async function probeLanguageModelAvailability(
  scope = globalThis,
  sessionOptions = PROMPT_API_SESSION_OPTIONS
) {
  const LM = scope.LanguageModel;
  if (!LM || typeof LM.availability !== "function") {
    return "missing";
  }
  try {
    const raw = await LM.availability({ ...sessionOptions });
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
 * @param {{ type?: unknown, mediaType?: unknown, data?: unknown }} part
 * @returns {Blob}
 */
function blobFromImagePart(part) {
  const mediaType = isImageMediaType(part.mediaType)
    ? part.mediaType
    : "image/png";
  const data = rawImageBase64(
    typeof part.data === "string" ? part.data : ""
  );
  if (!data) {
    throwInference("invalid_request", "Image part data must be valid base64.");
  }
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
  } catch {
    throwInference("invalid_request", "Image part data must be valid base64.");
  }
}

/**
 * Map IPA content to Prompt API `content` (string or `{ type, value }[]`).
 * @param {unknown} content
 * @returns {string | Array<{ type: string, value: unknown }>}
 */
export function mapContentForPromptApi(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  /** @type {Array<{ type: string, value: unknown }>} */
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ type?: unknown, text?: unknown, mediaType?: unknown, data?: unknown }} */ (
      part
    );
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", value: p.text });
    } else if (p.type === "image") {
      parts.push({ type: "image", value: blobFromImagePart(p) });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => String(p.value)).join("");
  }
  return parts;
}

/**
 * Map IPA chat messages into Prompt API session + final user prompt.
 * @param {import("./providers/types.js").ChatMessage[]} messages
 * @param {{ scope?: any }} [options] Native constructors, supplied only by the document host.
 * @returns {{
 *   initialPrompts: Array<{ role: string, content: string | Array<{ type: string, value: unknown }> }>,
 *   prompt: string | Array<{ type: string, value: unknown }>,
 * }}
 */
export function mapMessagesForPromptApi(messages, { scope } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throwInference("invalid_request", "On-device provider requires at least one message.");
  }
  const mappedMessages = [];
  const pendingCalls = new Map();
  const callIds = new Set();
  for (const message of messages) {
    const role = message.role;
    if (role === "system" && mappedMessages.length) {
      throwInference("invalid_request", "On-device provider allows a system message only as the first message.");
    }
    if (role === "tool") {
      const call = pendingCalls.get(message.toolCallId);
      if (!call) throwInference("invalid_request", "On-device tool result must match a preceding assistant tool call.");
      pendingCalls.delete(message.toolCallId);
      // Preserve the IPA result verbatim as text, including JSON nulls. Native
      // object results currently reject nested nulls in some Chrome builds.
      const init = { callId: call.id, callID: call.id, name: call.function.name,
        result: [{ type: "text", value: message.content }] };
      const part = { type: "tool-response", value: scope ? new scope.LanguageModelToolSuccess(init) : init };
      const previous = mappedMessages.at(-1);
      if (previous?.toolResults) previous.content.push(part);
      else mappedMessages.push({ role: "user", content: [part], toolResults: true });
      continue;
    }
    if (pendingCalls.size) {
      throwInference("invalid_request", "On-device requires a result for every assistant tool call before the next turn.");
    }
    let content = mapContentForPromptApi(message.content);
    if (role === "system" && Array.isArray(content)) {
      content = content.filter((p) => p.type === "text").map((p) => p.value).join("");
    }
    if (message.toolCalls?.length) {
      content = typeof content === "string" ? (content ? [{ type: "text", value: content }] : []) : content;
      for (const call of message.toolCalls) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch {
          throwInference("invalid_request", "On-device tool call arguments must be valid JSON objects.");
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throwInference("invalid_request", "On-device tool call arguments must be valid JSON objects.");
        }
        if (callIds.has(call.id)) throwInference("invalid_request", "On-device tool call IDs must be unique.");
        callIds.add(call.id);
        pendingCalls.set(call.id, call);
        const init = { callId: call.id, callID: call.id, name: call.function.name, arguments: args };
        content.push({ type: "tool-call", value: scope ? new scope.LanguageModelToolCall(init) : init });
      }
    }
    mappedMessages.push({ role, content });
  }
  const last = mappedMessages.pop();
  if (last.role !== "user") {
    throwInference("invalid_request", "On-device provider expects the last message to be from the user or a tool result.");
  }
  if (pendingCalls.size) {
    throwInference("invalid_request", "On-device requires a result for every assistant tool call before the next turn.");
  }
  return {
    initialPrompts: mappedMessages.map(({ role, content }) => ({ role, content })),
    prompt: last.content,
  };
}

/**
 * `promptStreaming()` accepts a string or `LanguageModelMessage[]`.
 * A content-parts array is not a message — Chrome then looks for `.content`
 * on each `{ type, value }` part and throws.
 *
 * @param {string | Array<{ type: string, value: unknown }>} prompt
 * @returns {string | Array<{ role: "user", content: Array<{ type: string, value: unknown }> }>}
 */
export function wrapPromptForPromptApi(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return "";
  return [{ role: "user", content: prompt }];
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

  const createArgs = {
    ...(signal ? { signal } : {}),
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const loaded = typeof e?.loaded === "number" ? e.loaded : 0;
        onProgress?.(loaded);
      });
    },
  };

  /** @type {any} */
  let session;
  try {
    session = await LM.create({
      ...PROMPT_API_VISION_SESSION_OPTIONS,
      ...createArgs,
    });
  } catch (err) {
    if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    try {
      session = await LM.create({
        ...PROMPT_API_SESSION_OPTIONS,
        ...createArgs,
      });
    } catch (err2) {
      if (signal?.aborted || (err2 && /** @type {Error} */ (err2).name === "AbortError")) {
        throwInference("aborted", "Request aborted");
      }
      throwInference(
        "provider_error",
        err2 instanceof Error ? err2.message : "Failed to install on-device model"
      );
    }
  }

  try {
    session?.destroy?.();
  } catch {
    // ignore destroy errors after successful create
  }
}

/**
 * One-shot chat via promptStreaming, including native function calls.
 * @param {{
 *   LanguageModel: any,
 *   messages: import("./providers/types.js").ChatMessage[],
 *   tools?: import("./providers/types.js").Tool[],
 *   toolChoice?: import("./providers/types.js").ToolChoice,
 *   toolScope?: any,
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 * }} args
 * @returns {Promise<{ model: string, message: { role: "assistant", content: string, toolCalls?: import("./providers/types.js").ToolCall[] } }>}
 */
export async function streamLanguageModelChat(args) {
  const { LanguageModel: LM, messages, tools, toolChoice, signal, onDelta } = args;
  if (!LM || typeof LM.create !== "function") {
    throwInference("unavailable", "Prompt API (LanguageModel) is not available in this browser.");
  }
  if (signal.aborted) {
    throwInference("aborted", "Request aborted");
  }

  const wantsImage = messagesHaveImageParts(messages);
  const wantsToolHistory = messagesHaveToolHistory(messages);
  const sessionOptions = promptApiChatOptions({ wantsImage, tools, toolChoice, wantsToolHistory });
  const scope = args.toolScope ?? globalThis;
  if (sessionOptions.tools?.length || wantsToolHistory) assertPromptApiToolsAvailable(scope);
  const availability = await probeLanguageModelAvailability(
    /** @type {any} */ ({ LanguageModel: LM }),
    sessionOptions
  );
  if (signal.aborted) throwInference("aborted", "Request aborted");
  assertOnDeviceAvailable(availability, { wantsImage });

  const { initialPrompts, prompt } = mapMessagesForPromptApi(messages, { scope });

  /** @type {any} */
  let session;
  try {
    session = await LM.create({
      ...sessionOptions,
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
  const toolCalls = [];
  const usedCallIds = new Set(messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)));
  try {
    if (signal.aborted) throwInference("aborted", "Request aborted");
    const stream = session.promptStreaming(wrapPromptForPromptApi(prompt), {
      signal,
    });
    for await (const chunk of stream) {
      if (signal.aborted) {
        throwInference("aborted", "Request aborted");
      }
      if (typeof chunk !== "string") {
        if (chunk?.type !== "tool-call" || !sessionOptions.tools?.length) {
          throwInference("provider_error", "Unexpected on-device response chunk.");
        }
        const call = chunk.value;
        const nativeId = call?.callId ?? call?.callID;
        if (typeof call?.name !== "string" || !call.name) {
          throwInference("provider_error", "Invalid on-device tool call: missing function name.");
        }
        // Native arguments are optional and the interface can expose null.
        // Some implementations also expose the JSON dictionary as a string.
        let args = call.arguments === "" ? {} : call.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch {
            throwInference("provider_error", "Invalid on-device tool call: arguments are not valid JSON.");
          }
        }
        args ??= {};
        if (typeof args !== "object" || Array.isArray(args)) {
          throwInference("provider_error", "Invalid on-device tool call: arguments must be a JSON object.");
        }
        // Every Bridge round creates a new native session. Native call IDs
        // may be empty or repeated; keep the page transcript unambiguous.
        // Replaying history accepts caller-assigned IDs, so no reverse map is needed.
        const baseId = typeof nativeId === "string" && nativeId ? nativeId : "on_device_tool";
        let id = baseId;
        for (let suffix = 1; usedCallIds.has(id); suffix++) id = `${baseId}_${suffix}`;
        usedCallIds.add(id);
        toolCalls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(args) } });
        continue;
      }
      const next = applyStreamChunk(full, chunk);
      full = next.full;
      if (next.delta) onDelta(next.delta);
    }
    if (signal.aborted) throwInference("aborted", "Request aborted");
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
    message: { role: "assistant", content: full, ...(toolCalls.length ? { toolCalls } : {}) },
  };
}
