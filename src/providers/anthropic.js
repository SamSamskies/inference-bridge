/**
 * Anthropic Messages API streaming adapter.
 * First-class BYOK provider — not OpenAI-compatible Chat Completions.
 */

import { ANTHROPIC_WEB_SEARCH_TOOL } from "./hosted-tools.js";
import { mapReasoningEffortForAnthropic } from "./reasoning-effort.js";
import { mapTemperatureForAnthropic } from "./temperature.js";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/** Curated chat models for the Options/approval UI — not a live Anthropic catalog. */
export const ANTHROPIC_MODELS = Object.freeze([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

/** @typedef {import("./types.js").ChatMessage} ChatMessage */
/** @typedef {import("./types.js").Tool} Tool */
/** @typedef {import("./types.js").ToolCall} ToolCall */
/** @typedef {import("./types.js").ToolChoice} ToolChoice */

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
 * @param {number} status
 * @param {string} detail
 * @returns {{ code: string, message: string }}
 */
export function mapAnthropicStatus(status, detail) {
  if (status === 401 || status === 403) {
    return { code: "provider_error", message: detail };
  }
  if (status === 429) {
    return { code: "provider_error", message: detail };
  }
  if (status === 529 || status >= 500) {
    return { code: "unavailable", message: detail };
  }
  return {
    code: "provider_error",
    message: detail || `Anthropic HTTP ${status}`,
  };
}

/**
 * Parse Bridge tool-call `arguments` (JSON string) into an Anthropic `input` object.
 * @param {string | undefined} args
 * @returns {Record<string, unknown>}
 */
function parseToolArguments(args) {
  if (typeof args !== "string" || !args) return {};
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
  } catch {
    // Invalid JSON — send empty input rather than fail the whole request.
  }
  return {};
}

/**
 * Map Bridge tools → Anthropic Messages `tools`.
 * Function tools become `name` / `description` / `input_schema`.
 * `{ type: "web_search" }` becomes the pinned server tool.
 * @param {Tool[]} tools
 * @returns {Array<Record<string, unknown>>}
 */
export function mapToolsForAnthropic(tools) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "web_search") {
      out.push({ ...ANTHROPIC_WEB_SEARCH_TOOL });
      continue;
    }
    if (t.type !== "function" || !t.function) continue;
    /** @type {Record<string, unknown>} */
    const mapped = {
      name: t.function.name,
      input_schema:
        t.function.parameters && typeof t.function.parameters === "object"
          ? t.function.parameters
          : { type: "object", properties: {} },
    };
    if (typeof t.function.description === "string" && t.function.description) {
      mapped.description = t.function.description;
    }
    out.push(mapped);
  }
  return out;
}

/**
 * Map Bridge `toolChoice` → Anthropic Messages API shape.
 * `auto` / `none` / `required` / named function → `auto` / `none` / `any` / `tool`.
 * @param {ToolChoice} toolChoice
 * @returns {{ type: "auto" } | { type: "none" } | { type: "any" } | { type: "tool", name: string }}
 */
export function mapToolChoiceForAnthropic(toolChoice) {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  return {
    type: "tool",
    name: toolChoice.function.name,
  };
}

/**
 * @param {ChatMessage} m
 * @returns {string | Array<Record<string, unknown>>}
 */
function mapAssistantContent(m) {
  const hasToolCalls =
    Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
  if (!hasToolCalls) {
    return m.content == null ? "" : m.content;
  }

  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  if (typeof m.content === "string" && m.content) {
    blocks.push({ type: "text", text: m.content });
  }
  for (const c of m.toolCalls || []) {
    blocks.push({
      type: "tool_use",
      id: c.id,
      name: c.function.name,
      input: parseToolArguments(c.function.arguments),
    });
  }
  return blocks;
}

/**
 * @param {string | Array<Record<string, unknown>>} a
 * @param {string | Array<Record<string, unknown>>} b
 * @returns {string | Array<Record<string, unknown>>}
 */
function mergeAnthropicContent(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    return a && b ? `${a}\n\n${b}` : a || b;
  }
  /** @type {Array<Record<string, unknown>>} */
  const left =
    typeof a === "string"
      ? a
        ? [{ type: "text", text: a }]
        : []
      : a;
  /** @type {Array<Record<string, unknown>>} */
  const right =
    typeof b === "string"
      ? b
        ? [{ type: "text", text: b }]
        : []
      : b;
  return [...left, ...right];
}

/**
 * Map IPA messages to Anthropic Messages API shape.
 * System roles become a top-level `system` string; outbound `reasoning` is dropped.
 * Assistant `toolCalls` become `tool_use` blocks; Bridge `role: "tool"` becomes
 * user `tool_result` content. Consecutive same-role turns are merged so the
 * result alternates user/assistant.
 * @param {ChatMessage[]} messages
 * @returns {{
 *   system?: string,
 *   messages: Array<{ role: string, content: string | Array<Record<string, unknown>> }>,
 * }}
 */
export function mapMessagesForAnthropic(messages) {
  /** @type {string[]} */
  const systemParts = [];
  /** @type {Array<{ role: string, content: string | Array<Record<string, unknown>> }>} */
  const mapped = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) {
        systemParts.push(m.content);
      }
      continue;
    }

    /** @type {{ role: string, content: string | Array<Record<string, unknown>> }} */
    let next;
    if (m.role === "tool") {
      next = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id:
              typeof m.toolCallId === "string" ? m.toolCallId : "",
            content: m.content == null ? "" : m.content,
          },
        ],
      };
    } else if (m.role === "assistant") {
      next = { role: "assistant", content: mapAssistantContent(m) };
    } else {
      next = {
        role: m.role,
        content: m.content == null ? "" : m.content,
      };
    }

    const last = mapped[mapped.length - 1];
    if (last && last.role === next.role) {
      last.content = mergeAnthropicContent(last.content, next.content);
      continue;
    }
    mapped.push(next);
  }

  if (mapped.length === 0) {
    throwInference(
      "invalid_request",
      "Anthropic requires at least one non-system message"
    );
  }
  if (mapped[0].role !== "user") {
    throwInference(
      "invalid_request",
      "Anthropic requires the first non-system message to be from the user"
    );
  }

  /** @type {{ system?: string, messages: Array<{ role: string, content: string | Array<Record<string, unknown>> }> }} */
  const out = { messages: mapped };
  if (systemParts.length > 0) {
    out.system = systemParts.join("\n\n");
  }
  return out;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function anthropicErrorMessage(body) {
  if (!body || typeof body !== "object") return "";
  const err = /** @type {Record<string, unknown>} */ (body).error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const message = /** @type {Record<string, unknown>} */ (err).message;
    if (typeof message === "string" && message) return message;
  }
  return "";
}

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const anthropicProvider = {
  id: "anthropic",
  label: "Anthropic",
  requiresApiKey: true,
  models: ANTHROPIC_MODELS,
  defaultModel: "claude-sonnet-5",
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),

  /**
   * Anthropic rejects threads with no non-system turn or an assistant-first
   * turn. Surface that as invalid_request before the `accepted` chunk instead
   * of mid-stream.
   * @param {ChatMessage[]} messages
   */
  preflightMessages(messages) {
    mapMessagesForAnthropic(messages);
  },

  async streamChat({
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
    const mapped = mapMessagesForAnthropic(messages);
    const mappedTools =
      Array.isArray(tools) && tools.length > 0 ? mapToolsForAnthropic(tools) : [];

    /** @type {Record<string, unknown>} */
    const requestBody = {
      model,
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: true,
      ...(mapped.system ? { system: mapped.system } : {}),
      messages: mapped.messages,
    };
    if (mappedTools.length > 0) {
      requestBody.tools = mappedTools;
      // Default matches validateExperimentalInferenceRequest when tools present.
      requestBody.tool_choice = mapToolChoiceForAnthropic(
        toolChoice !== undefined ? toolChoice : "auto"
      );
    }
    const thinking = mapReasoningEffortForAnthropic(
      options?.reasoningEffort,
      model
    );
    if (thinking) {
      requestBody.thinking = thinking.thinking;
      if (thinking.output_config !== undefined) {
        requestBody.output_config = thinking.output_config;
      }
    }
    const temperature = mapTemperatureForAnthropic(options?.temperature);
    if (temperature !== undefined) {
      requestBody.temperature = temperature;
    }

    let response;
    try {
      response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey || "",
          "anthropic-version": ANTHROPIC_VERSION,
          // Required for browser / extension fetch (CORS). Keys stay in the SW.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (err) {
      if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
        throwInference("aborted", "Request aborted");
      }
      throwInference(
        "unavailable",
        err instanceof Error ? err.message : "Network error contacting Anthropic"
      );
    }

    if (!response.ok) {
      let detail = `Anthropic HTTP ${response.status}`;
      try {
        const body = await response.json();
        const fromBody = anthropicErrorMessage(body);
        if (fromBody) detail = fromBody;
      } catch {
        // ignore parse failure
      }
      const mappedStatus = mapAnthropicStatus(response.status, detail);
      throwInference(mappedStatus.code, mappedStatus.message);
    }

    if (!response.body) {
      throwInference("provider_error", "Anthropic response had no body");
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
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const toolCallsByIndex = new Map();

    /**
     * @param {Record<string, unknown>} parsed
     */
    function handleEvent(parsed) {
      const type = typeof parsed.type === "string" ? parsed.type : currentEvent;

      if (type === "error") {
        const message =
          anthropicErrorMessage(parsed) || "Anthropic stream error";
        throwInference("provider_error", message);
      }

      if (type === "message_start") {
        const message = parsed.message;
        if (message && typeof message === "object") {
          const msg = /** @type {Record<string, unknown>} */ (message);
          if (typeof msg.model === "string" && msg.model) {
            resolvedModel = msg.model;
          }
          const startUsage = msg.usage;
          if (startUsage && typeof startUsage === "object") {
            const u = /** @type {Record<string, unknown>} */ (startUsage);
            usage = {
              ...(usage || {}),
              ...(typeof u.input_tokens === "number"
                ? { inputTokens: u.input_tokens }
                : {}),
              ...(typeof u.output_tokens === "number"
                ? { outputTokens: u.output_tokens }
                : {}),
            };
          }
        }
        return;
      }

      if (type === "content_block_start") {
        const block = parsed.content_block;
        const index = typeof parsed.index === "number" ? parsed.index : 0;
        if (block && typeof block === "object") {
          const b = /** @type {Record<string, unknown>} */ (block);
          if (b.type === "tool_use") {
            toolCallsByIndex.set(index, {
              id: typeof b.id === "string" ? b.id : "",
              name: typeof b.name === "string" ? b.name : "",
              arguments: "",
            });
          }
        }
        return;
      }

      if (type === "content_block_delta") {
        const delta = parsed.delta;
        if (!delta || typeof delta !== "object") return;
        const d = /** @type {Record<string, unknown>} */ (delta);
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          content += d.text;
          onDelta(d.text);
        } else if (
          d.type === "thinking_delta" &&
          typeof d.thinking === "string" &&
          d.thinking
        ) {
          reasoning += d.thinking;
          onReasoningDelta?.(d.thinking);
        } else if (
          d.type === "input_json_delta" &&
          typeof d.partial_json === "string"
        ) {
          const index = typeof parsed.index === "number" ? parsed.index : 0;
          const entry = toolCallsByIndex.get(index);
          if (entry) {
            entry.arguments += d.partial_json;
          }
        }
        // signature_delta: ignore (thinking signatures; not part of IPA)
        return;
      }

      if (type === "message_delta") {
        const deltaUsage = parsed.usage;
        if (deltaUsage && typeof deltaUsage === "object") {
          const u = /** @type {Record<string, unknown>} */ (deltaUsage);
          usage = {
            ...(usage || {}),
            ...(typeof u.input_tokens === "number"
              ? { inputTokens: u.input_tokens }
              : {}),
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
      // SSE comments
      if (line.startsWith(":")) return;

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        return;
      }

      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trimStart();
      if (!data) return;

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
    if (toolCallsByIndex.size > 0) {
      const toolCalls = [...toolCallsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, entry]) => ({
          id: entry.id,
          type: /** @type {"function"} */ ("function"),
          function: {
            name: entry.name,
            // Empty streamed input (no deltas) is valid `{}`.
            arguments: entry.arguments || "{}",
          },
        }))
        .filter((c) => c.id && c.function.name);
      if (toolCalls.length > 0) {
        message.toolCalls = toolCalls;
      }
    }

    return {
      model: resolvedModel,
      message,
      usage,
    };
  },
};
