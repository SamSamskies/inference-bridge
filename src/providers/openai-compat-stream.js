/**
 * Shared OpenAI-compatible chat Completions SSE streaming helper.
 * Used by OpenAI, OpenRouter, and user-configured compat adapters.
 */

import { runToolLoop } from "./tool-loop.js";

/** @typedef {import("./types.js").ToolCall} ToolCall */
/** @typedef {import("./types.js").ToolDefinition} ToolDefinition */

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
 * @param {string} label
 * @returns {{ code: string, message: string }}
 */
function defaultMapStatus(status, detail, label) {
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
    message: detail || `${label} HTTP ${status}`,
  };
}

/**
 * Map IPA messages to OpenAI-compat chat messages.
 * Intentionally omits `reasoning`: many Chat Completions servers (OpenAI,
 * vLLM, TRT-LLM, etc.) reject unknown message fields with HTTP 400.
 * Inbound reasoning is still extracted from streamed deltas.
 * Round-trips assistant `tool_calls` and `tool` role results.
 * @param {Array<{ role: string, content: string, reasoning?: string, tool_call_id?: string, tool_calls?: Array<{id?: string, name: string, arguments?: Record<string, unknown>}> }>} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function mapMessagesForOpenAICompat(messages) {
  return messages.map((m) => {
    /** @type {Record<string, unknown>} */
    const out = { role: m.role, content: m.content };
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      out.tool_calls = m.tool_calls.map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        type: "function",
        function: {
          name: c.name,
          arguments: JSON.stringify(c.arguments ?? {}),
        },
      }));
    }
    if (m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id) {
      out.tool_call_id = m.tool_call_id;
    }
    return out;
  });
}

/**
 * Map MCP-style tool definitions to the OpenAI `tools` array shape.
 * @param {ToolDefinition[]} tools
 * @returns {Array<Record<string, unknown>>}
 */
export function mapToolsForOpenAICompat(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
    },
  }));
}

/**
 * Prefer reasoning_content (DeepSeek-native) when both string fields exist.
 * Falls back to OpenRouter delta.reasoning_details[].text / .summary.
 * @param {Record<string, unknown> | undefined} delta
 * @returns {string}
 */
export function extractOpenAICompatReasoningDelta(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string" && delta.reasoning) {
    return delta.reasoning;
  }
  const details = delta.reasoning_details;
  if (!Array.isArray(details)) return "";
  let out = "";
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const d = /** @type {Record<string, unknown>} */ (detail);
    if (typeof d.text === "string" && d.text) {
      out += d.text;
    } else if (typeof d.summary === "string" && d.summary) {
      out += d.summary;
    }
  }
  return out;
}

/**
 * Stream a single OpenAI-compatible chat completion turn.
 * Streams content/reasoning deltas and reassembles any streamed tool_calls.
 *
 * @param {{
 *   url: string,
 *   apiKey?: string,
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: ToolDefinition[],
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 *   onReasoningDelta?: (content: string) => void,
 *   label: string,
 *   mapStatus?: (status: number, detail: string, label: string) => { code: string, message: string },
 *   extraHeaders?: Record<string, string>,
 * }} args
 * @returns {Promise<{
 *   model: string,
 *   content: string,
 *   reasoning: string,
 *   usage?: { inputTokens?: number, outputTokens?: number },
 *   toolCalls?: ToolCall[],
 * }>}
 */
async function streamOpenAICompatChatTurn({
  url,
  apiKey,
  model,
  messages,
  tools,
  signal,
  onDelta,
  onReasoningDelta,
  label,
  mapStatus = defaultMapStatus,
  extraHeaders = {},
}) {
  let response;
  try {
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: mapMessagesForOpenAICompat(messages),
        ...(tools && tools.length > 0
          ? { tools: mapToolsForOpenAICompat(tools) }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "unavailable",
      err instanceof Error ? err.message : `Network error contacting ${label}`
    );
  }

  if (!response.ok) {
    let detail = `${label} HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // ignore parse failure
    }
    const mapped = mapStatus(response.status, detail, label);
    throwInference(mapped.code, mapped.message);
  }

  if (!response.body) {
    throwInference("provider_error", `${label} response had no body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let resolvedModel = model;
  /** @type {{ inputTokens?: number, outputTokens?: number } | undefined} */
  let usage;
  /** @type {Map<number, { id: string, name: string, arguments: string }>} */
  const toolCalls = new Map();

  /**
   * @param {string} line
   */
  function handleLine(line) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // Skip SSE comments (e.g. ": OPENROUTER PROCESSING") and blank lines.
    if (!line.startsWith("data:")) return;

    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    // Mid-stream errors arrive as data events with a top-level error field
    // (HTTP status is already 200). OpenAI does not send these, but the check
    // is harmless when the field is absent.
    if (parsed.error) {
      const message =
        typeof parsed.error?.message === "string" && parsed.error.message
          ? parsed.error.message
          : typeof parsed.error === "string"
            ? parsed.error
            : `${label} stream error`;
      throwInference("provider_error", message);
    }

    if (typeof parsed.model === "string" && parsed.model) {
      resolvedModel = parsed.model;
    }

    if (parsed.usage) {
      usage = {
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.completion_tokens,
      };
    }

    const choice = parsed.choices?.[0];
    const deltaObj = choice?.delta;
    const reasoningDelta = extractOpenAICompatReasoningDelta(deltaObj);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      onReasoningDelta?.(reasoningDelta);
    }

    const delta = deltaObj?.content;
    if (typeof delta === "string" && delta.length > 0) {
      content += delta;
      onDelta(delta);
    }

    // Tool calls stream in deltas keyed by index; id/name arrive once, the
    // arguments string is split across deltas and must be concatenated.
    if (Array.isArray(deltaObj?.tool_calls)) {
      for (const tc of deltaObj.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const index = typeof tc.index === "number" ? tc.index : 0;
        let entry = toolCalls.get(index);
        if (!entry) {
          entry = { id: "", name: "", arguments: "" };
          toolCalls.set(index, entry);
        }
        if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name) {
          entry.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string") {
          entry.arguments += tc.function.arguments;
        }
      }
    }
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
        // Flush decoder state and any final SSE line without a trailing newline.
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

  /** @type {ToolCall[] | undefined} */
  let resolvedToolCalls;
  if (toolCalls.size > 0) {
    resolvedToolCalls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => {
        let args;
        try {
          args = JSON.parse(entry.arguments || "{}");
        } catch {
          args = {};
        }
        return {
          ...(entry.id ? { id: entry.id } : {}),
          name: entry.name,
          arguments:
            args && typeof args === "object" && !Array.isArray(args)
              ? args
              : {},
        };
      });
  }

  return {
    model: resolvedModel,
    content,
    reasoning,
    usage,
    ...(resolvedToolCalls && resolvedToolCalls.length > 0
      ? { toolCalls: resolvedToolCalls }
      : {}),
  };
}

/**
 * Stream an OpenAI-compatible chat completion, running the full tool-calling
 * loop when the model requests tool calls. When a turn ends in tool_calls the
 * given `runTool` callback executes each call on the page and the result is
 * fed back to the model for the next turn.
 *
 * Lines that do not start with `data:` are ignored (covers OpenRouter's
 * `: OPENROUTER PROCESSING` SSE keep-alive comments).
 *
 * @param {{
 *   url: string,
 *   apiKey?: string,
 *   model: string,
 *   messages: Array<{ role: string, content: string, reasoning?: string, tool_call_id?: string, tool_calls?: Array<{id?: string, name: string, arguments?: Record<string, unknown>}> }>,
 *   tools?: ToolDefinition[],
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 *   onReasoningDelta?: (content: string) => void,
 *   runTool?: (call: ToolCall) => Promise<string>,
 *   label: string,
 *   mapStatus?: (status: number, detail: string, label: string) => { code: string, message: string },
 *   extraHeaders?: Record<string, string>,
 * }} args
 * @returns {Promise<{ model: string, message: { role: "assistant", content: string, reasoning?: string, tool_calls?: Array<ToolCall & { result?: string }> }, usage?: { inputTokens?: number, outputTokens?: number } }>}
 */
export async function streamOpenAICompatChat({
  url,
  apiKey,
  model,
  messages,
  tools,
  signal,
  onDelta,
  onReasoningDelta,
  runTool,
  label,
  mapStatus,
  extraHeaders,
}) {
  const result = await runToolLoop({
    initialMessages: /** @type {Array<Record<string, unknown>>} */ (messages),
    runTool,
    turn: (msgs) =>
      streamOpenAICompatChatTurn({
        url,
        apiKey,
        model,
        messages: msgs,
        tools,
        signal,
        onDelta,
        onReasoningDelta,
        label,
        mapStatus,
        extraHeaders,
      }),
  });

  return {
    model: result.model || model,
    message: result.message,
    usage: result.usage,
  };
}
