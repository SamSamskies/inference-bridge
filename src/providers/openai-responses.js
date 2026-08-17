/**
 * OpenAI Responses API streaming path.
 * Used only when hosted `{ type: "web_search" }` is present; function-tool-only
 * requests stay on Chat Completions (openai-compat-stream.js).
 */

import { OPENAI_WEB_SEARCH_TOOL } from "./hosted-tools.js";
import {
  mapReasoningEffortForOpenAICompat,
  nextOpenAICompatReasoningEffortAfterError,
} from "./reasoning-effort.js";
import { mapTemperatureForOpenAICompat } from "./temperature.js";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** @typedef {import("./types.js").ChatMessage} ChatMessage */
/** @typedef {import("./types.js").Tool} Tool */
/** @typedef {import("./types.js").ToolCall} ToolCall */
/** @typedef {import("./types.js").ToolChoice} ToolChoice */
/** @typedef {import("./types.js").InferenceOptions} InferenceOptions */

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

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function openaiErrorMessage(err) {
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const message = /** @type {any} */ (err).message;
    if (typeof message === "string" && message) return message;
  }
  return undefined;
}

/**
 * Terminal Responses failures put the error on `response.error`, not the
 * top-level `error` field used by `type: "error"` SSE events.
 * @param {Record<string, unknown>} parsed
 * @param {string} type
 * @returns {string}
 */
function responsesStreamErrorMessage(parsed, type) {
  const top = openaiErrorMessage(parsed.error);
  if (top) return top;
  const resp = parsed.response;
  if (resp && typeof resp === "object") {
    const nested = openaiErrorMessage(/** @type {any} */ (resp).error);
    if (nested) return nested;
    const reason = /** @type {any} */ (resp).incomplete_details?.reason;
    if (typeof reason === "string" && reason) {
      return `OpenAI response incomplete: ${reason}`;
    }
  }
  if (type === "response.failed") return "OpenAI response failed";
  if (type === "response.incomplete") return "OpenAI response incomplete";
  return "OpenAI stream error";
}

/**
 * @param {number} status
 * @param {string} detail
 * @returns {{ code: string, message: string }}
 */
function mapOpenAIStatus(status, detail) {
  if (status === 401 || status === 403) {
    return { code: "provider_error", message: detail };
  }
  if (status === 429) {
    return { code: "provider_error", message: detail };
  }
  if (status >= 500) {
    return { code: "unavailable", message: detail };
  }
  return {
    code: "provider_error",
    message: detail || `OpenAI HTTP ${status}`,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string | undefined} effort
 */
function setResponsesReasoningEffort(body, effort) {
  if (effort === undefined) {
    delete body.reasoning;
  } else {
    body.reasoning = { effort };
  }
}

/**
 * @param {Response} response
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function readProviderErrorDetail(response, fallback) {
  try {
    const errBody = await response.json();
    if (errBody?.error?.message) return errBody.error.message;
  } catch {
    // ignore parse failure
  }
  return fallback;
}

/**
 * Map IPA / experimental messages onto Responses `input` items.
 * Function-call turns become `function_call` / `function_call_output` items
 * so a follow-up after page-executed tools can stay on this path.
 * @param {ChatMessage[]} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function mapMessagesForOpenAIResponses(messages) {
  /** @type {Array<Record<string, unknown>>} */
  const input = [];
  for (const m of messages) {
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: typeof m.toolCallId === "string" ? m.toolCallId : "",
        output: m.content == null ? "" : m.content,
      });
      continue;
    }
    if (
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.length > 0
    ) {
      if (typeof m.content === "string" && m.content) {
        input.push({ role: "assistant", content: m.content });
      }
      for (const c of m.toolCalls) {
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.function.name,
          arguments: c.function.arguments || "{}",
        });
      }
      continue;
    }
    input.push({ role: m.role, content: m.content });
  }
  return input;
}

/**
 * Map Bridge tools onto Responses `tools` (flat function tools + hosted search).
 * @param {Tool[] | undefined} tools
 * @returns {Array<Record<string, unknown>>}
 */
export function mapToolsForOpenAIResponses(tools) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "web_search") {
      out.push({ ...OPENAI_WEB_SEARCH_TOOL });
      continue;
    }
    if (t.type !== "function" || !t.function) continue;
    /** @type {Record<string, unknown>} */
    const fn = {
      type: "function",
      name: t.function.name,
      parameters:
        t.function.parameters && typeof t.function.parameters === "object"
          ? t.function.parameters
          : { type: "object", properties: {} },
    };
    if (typeof t.function.description === "string" && t.function.description) {
      fn.description = t.function.description;
    }
    out.push(fn);
  }
  return out;
}

/**
 * Map IPA `toolChoice` onto Responses `tool_choice`.
 * Named function uses `{ type: "function", name }` (not Chat Completions nesting).
 * @param {ToolChoice | undefined} toolChoice
 * @returns {unknown}
 */
export function mapToolChoiceForOpenAIResponses(toolChoice) {
  if (toolChoice === undefined) return "auto";
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  return { type: "function", name: toolChoice.function.name };
}

/**
 * Stream an OpenAI Responses request. Hosted web_search is provider-executed
 * (not surfaced as IPA `toolCalls`). Page function tools still accumulate
 * into `message.toolCalls`.
 *
 * @param {{
 *   apiKey?: string,
 *   model: string,
 *   messages: ChatMessage[],
 *   tools?: Tool[],
 *   toolChoice?: ToolChoice,
 *   options?: InferenceOptions,
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 *   onReasoningDelta?: (content: string) => void,
 * }} args
 * @returns {Promise<{
 *   model: string,
 *   message: {
 *     role: "assistant",
 *     content: string,
 *     reasoning?: string,
 *     toolCalls?: ToolCall[],
 *   },
 *   usage?: { inputTokens?: number, outputTokens?: number },
 * }>}
 */
export async function streamOpenAIResponsesChat({
  apiKey,
  model,
  messages,
  tools,
  toolChoice,
  options,
  signal,
  onDelta,
  onReasoningDelta,
}) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    input: mapMessagesForOpenAIResponses(messages),
    stream: true,
    tools: mapToolsForOpenAIResponses(tools),
    tool_choice: mapToolChoiceForOpenAIResponses(toolChoice),
  };
  const reasoningEffort = mapReasoningEffortForOpenAICompat(
    options?.reasoningEffort,
    model
  );
  setResponsesReasoningEffort(body, reasoningEffort);
  const temperature = mapTemperatureForOpenAICompat(options?.temperature);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  let response;
  try {
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      let detail = await readProviderErrorDetail(
        response,
        `OpenAI HTTP ${response.status}`
      );
      const next = nextOpenAICompatReasoningEffortAfterError(
        response.status,
        detail,
        reasoningEffort
      );
      if (next.retry) {
        setResponsesReasoningEffort(body, next.effort);
        response = await fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          detail = await readProviderErrorDetail(
            response,
            `OpenAI HTTP ${response.status}`
          );
          const mappedRetry = mapOpenAIStatus(response.status, detail);
          throwInference(mappedRetry.code, mappedRetry.message);
        }
      } else {
        const mapped = mapOpenAIStatus(response.status, detail);
        throwInference(mapped.code, mapped.message);
      }
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code) throw err;
    if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "unavailable",
      err instanceof Error ? err.message : "Network error contacting OpenAI"
    );
  }

  if (!response.body) {
    throwInference("provider_error", "OpenAI response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let resolvedModel = model;
  /** @type {{ inputTokens?: number, outputTokens?: number } | undefined} */
  let usage;
  /** @type {string} */
  let currentEvent = "";
  /** @type {Map<string, { id: string, name: string, arguments: string }>} */
  const functionCalls = new Map();
  /** @type {string[]} */
  const functionCallOrder = [];

  /**
   * @param {string} itemId
   * @param {{ id?: string, name?: string }} [seed]
   */
  function ensureFunctionCall(itemId, seed = {}) {
    let entry = functionCalls.get(itemId);
    if (!entry) {
      entry = { id: seed.id || "", name: seed.name || "", arguments: "" };
      functionCalls.set(itemId, entry);
      functionCallOrder.push(itemId);
    } else {
      if (seed.id) entry.id = seed.id;
      if (seed.name) entry.name = seed.name;
    }
    return entry;
  }

  /**
   * @param {Record<string, unknown>} parsed
   */
  function handleEvent(parsed) {
    const type = typeof parsed.type === "string" ? parsed.type : currentEvent;

    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete" ||
      parsed.error
    ) {
      throwInference("provider_error", responsesStreamErrorMessage(parsed, type));
    }

    if (type === "response.output_text.delta") {
      const delta =
        typeof parsed.delta === "string"
          ? parsed.delta
          : typeof parsed.text === "string"
            ? parsed.text
            : "";
      if (delta) {
        content += delta;
        onDelta(delta);
      }
      return;
    }

    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      const delta =
        typeof parsed.delta === "string"
          ? parsed.delta
          : typeof parsed.text === "string"
            ? parsed.text
            : "";
      if (delta) {
        reasoning += delta;
        onReasoningDelta?.(delta);
      }
      return;
    }

    if (type === "response.output_item.added") {
      const item = parsed.item;
      if (!item || typeof item !== "object") return;
      const it = /** @type {Record<string, unknown>} */ (item);
      if (it.type !== "function_call") return;
      const itemId = typeof it.id === "string" && it.id ? it.id : `fn-${functionCallOrder.length}`;
      ensureFunctionCall(itemId, {
        id: typeof it.call_id === "string" ? it.call_id : "",
        name: typeof it.name === "string" ? it.name : "",
      });
      if (typeof it.arguments === "string" && it.arguments) {
        functionCalls.get(itemId).arguments += it.arguments;
      }
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      if (!itemId || !delta) return;
      ensureFunctionCall(itemId).arguments += delta;
      return;
    }

    if (type === "response.completed" || type === "response.created") {
      const resp = parsed.response;
      if (!resp || typeof resp !== "object") return;
      const r = /** @type {Record<string, unknown>} */ (resp);
      if (typeof r.model === "string" && r.model) {
        resolvedModel = r.model;
      }
      if (r.usage && typeof r.usage === "object") {
        const u = /** @type {Record<string, unknown>} */ (r.usage);
        usage = {
          ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
          ...(typeof u.output_tokens === "number"
            ? { outputTokens: u.output_tokens }
            : {}),
        };
      }
    }
  }

  /**
   * @param {string} line
   */
  function handleLine(line) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) {
      currentEvent = "";
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    handleEvent(/** @type {Record<string, unknown>} */ (parsed));
  }

  /**
   * @param {boolean} flushRemainder
   */
  function drainBuffer(flushRemainder) {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
    if (flushRemainder && buffer.length > 0) {
      const line = buffer;
      buffer = "";
      handleLine(line);
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        drainBuffer(false);
      }
      if (done) {
        buffer += decoder.decode();
        drainBuffer(true);
        break;
      }
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code) throw err;
    if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  /** @type {{ role: "assistant", content: string, reasoning?: string, toolCalls?: ToolCall[] }} */
  const message = { role: "assistant", content };
  if (reasoning) {
    message.reasoning = reasoning;
  }
  const toolCalls = functionCallOrder
    .map((itemId) => functionCalls.get(itemId))
    .filter((entry) => entry && entry.id && entry.name)
    .map((entry) => ({
      id: entry.id,
      type: /** @type {"function"} */ ("function"),
      function: {
        name: entry.name,
        arguments: entry.arguments || "{}",
      },
    }));
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }

  return {
    model: resolvedModel,
    message,
    usage,
  };
}
