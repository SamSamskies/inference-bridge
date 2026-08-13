/**
 * Ollama chat streaming adapter (local http://localhost:11434).
 * Models are discovered via GET /api/tags — no hardcoded catalog.
 */

import { ensureOllamaOriginBypass } from "../ollama-origin-bypass.js";
import { filterFunctionTools } from "./openai-compat-stream.js";

export const OLLAMA_BASE_URL = "http://localhost:11434";

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
 * @param {unknown} err
 * @param {AbortSignal} signal
 * @returns {never}
 */
function rethrowNetwork(err, signal) {
  if (signal.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
    throwInference("aborted", "Request aborted");
  }
  throwInference(
    "unavailable",
    err instanceof Error
      ? err.message
      : "Network error contacting Ollama. Is it running on localhost:11434?"
  );
}

/**
 * Parse IPA JSON-string arguments into an object for Ollama's native shape.
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
export function parseArgumentsForOllama(args) {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      // fall through
    }
    return {};
  }
  if (args != null && typeof args === "object" && !Array.isArray(args)) {
    return /** @type {Record<string, unknown>} */ (args);
  }
  return {};
}

/**
 * List locally installed Ollama models.
 * @param {{ signal?: AbortSignal }} [args]
 * @returns {Promise<import("./types.js").ModelInfo[]>}
 */
export async function listOllamaModels({ signal } = {}) {
  await ensureOllamaOriginBypass();

  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal });
  } catch (err) {
    if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
      throwInference("aborted", "Request aborted");
    }
    throwInference(
      "unavailable",
      err instanceof Error
        ? err.message
        : "Network error contacting Ollama. Is it running on localhost:11434?"
    );
  }

  if (!response.ok) {
    throwInference(
      response.status >= 500 ? "unavailable" : "provider_error",
      `Ollama HTTP ${response.status} listing models`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throwInference("provider_error", "Ollama returned invalid JSON for /api/tags");
  }

  const models = Array.isArray(body?.models) ? body.models : [];
  /** @type {import("./types.js").ModelInfo[]} */
  const names = [];
  for (const entry of models) {
    const name =
      typeof entry?.name === "string"
        ? entry.name
        : typeof entry?.model === "string"
          ? entry.model
          : "";
    if (name) names.push({ id: name });
  }
  names.sort((a, b) => a.id.localeCompare(b.id));
  return names;
}

/**
 * Map IPA / experimental messages to Ollama chat messages.
 * Round-trips reasoning as `thinking`, assistant `tool_calls` (object args),
 * and `role: "tool"` results via `tool_name` (Ollama has no tool_call_id).
 * @param {ChatMessage[]} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function mapMessagesForOllama(messages) {
  /** @type {Map<string, string>} */
  const toolCallIdToName = new Map();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      if (typeof c?.id === "string" && c.id && typeof c.function?.name === "string") {
        toolCallIdToName.set(c.id, c.function.name);
      }
    }
  }

  return messages.map((m) => {
    /** @type {Record<string, unknown>} */
    const out = {
      role: m.role,
      // Ollama requires string content; IPA may use null when only tool_calls.
      content: m.content == null ? "" : m.content,
    };
    if (typeof m.reasoning === "string" && m.reasoning) {
      out.thinking = m.reasoning;
    }
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      out.tool_calls = m.tool_calls.map((c) => ({
        type: "function",
        function: {
          name: c.function.name,
          arguments: parseArgumentsForOllama(c.function.arguments),
        },
      }));
    }
    if (m.role === "tool") {
      const name =
        typeof m.tool_call_id === "string" && m.tool_call_id
          ? toolCallIdToName.get(m.tool_call_id)
          : undefined;
      if (name) {
        out.tool_name = name;
      }
    }
    return out;
  });
}

/**
 * Next free map key at or above `start` (avoids colliding with sparse indices).
 * @param {Map<number, unknown>} toolCallsByIndex
 * @param {number} start
 * @returns {number}
 */
function nextFreeToolCallIndex(toolCallsByIndex, start) {
  let index = start;
  while (toolCallsByIndex.has(index)) index += 1;
  return index;
}

/**
 * True when this chunk is a distinct tool call reusing an occupied index
 * (Ollama quirk: parallel calls often all stream as index 0).
 * @param {{ id: string, name: string, arguments: string }} entry
 * @param {Record<string, unknown>} call
 * @param {Record<string, unknown> | null} fn
 * @returns {boolean}
 */
function isDistinctToolCallAtIndex(entry, call, fn) {
  const incomingId = typeof call.id === "string" && call.id ? call.id : "";
  if (incomingId && entry.id && incomingId !== entry.id) return true;

  const incomingName = typeof fn?.name === "string" && fn.name ? fn.name : "";
  if (incomingName && entry.name && incomingName !== entry.name) return true;

  // Native Ollama: a second complete object-args call at the same index.
  if (
    entry.name &&
    entry.arguments &&
    incomingName &&
    fn?.arguments != null &&
    typeof fn.arguments === "object"
  ) {
    return true;
  }

  return false;
}

/**
 * Normalize streamed Ollama tool_calls into IPA ToolCall entries.
 * Accumulates by index (tc.index or function.index); missing index defaults
 * to 0 so argument deltas continue the in-progress call (OpenAI-compat style).
 * When a chunk reuses an index for a distinct call (different id/name, or a
 * second native object-args payload), allocates the next free index instead
 * of overwriting — Ollama sometimes emits every parallel call as index 0.
 * Arguments may arrive as objects (native) or JSON strings (compat-ish streams).
 * Synthetic ids (`ollama_call_${index}`) are assigned when Ollama omits them.
 * @param {Map<number, { id: string, name: string, arguments: string }>} toolCallsByIndex
 * @param {unknown[]} rawCalls
 */
export function accumulateOllamaToolCalls(toolCallsByIndex, rawCalls) {
  for (const tc of rawCalls) {
    if (!tc || typeof tc !== "object") continue;
    const call = /** @type {Record<string, unknown>} */ (tc);
    const fn =
      call.function && typeof call.function === "object"
        ? /** @type {Record<string, unknown>} */ (call.function)
        : null;
    let index =
      typeof call.index === "number"
        ? call.index
        : typeof fn?.index === "number"
          ? /** @type {number} */ (fn.index)
          : 0;

    let entry = toolCallsByIndex.get(index);
    if (entry && isDistinctToolCallAtIndex(entry, call, fn)) {
      index = nextFreeToolCallIndex(toolCallsByIndex, toolCallsByIndex.size);
      entry = undefined;
    }
    if (!entry) {
      entry = { id: "", name: "", arguments: "" };
      toolCallsByIndex.set(index, entry);
    }

    if (typeof call.id === "string" && call.id) {
      entry.id = call.id;
    }

    if (!fn) continue;

    if (typeof fn.name === "string" && fn.name) {
      entry.name = fn.name;
    }

    if (typeof fn.arguments === "string") {
      entry.arguments += fn.arguments;
    } else if (fn.arguments != null && typeof fn.arguments === "object") {
      // Native Ollama sends a complete arguments object (often once per index).
      entry.arguments = JSON.stringify(fn.arguments);
    }
  }
}

/**
 * @param {Map<number, { id: string, name: string, arguments: string }>} toolCallsByIndex
 * @returns {ToolCall[]}
 */
export function finalizeOllamaToolCalls(toolCallsByIndex) {
  return [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entry]) => ({
      id: entry.id || `ollama_call_${index}`,
      type: /** @type {"function"} */ ("function"),
      function: {
        name: entry.name,
        arguments: entry.arguments || "{}",
      },
    }))
    .filter((c) => c.function.name);
}

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const ollamaProvider = {
  id: "ollama",
  label: "Ollama",
  requiresApiKey: false,
  // Placeholder until /api/tags is queried; never used as a hardcoded catalog.
  defaultModel: "",
  supportsFunctionTools: true,
  hostedTools: Object.freeze([]),

  listModels: listOllamaModels,

  async streamChat({
    model,
    messages,
    tools,
    toolChoice,
    signal,
    onDelta,
    onReasoningDelta,
  }) {
    if (!model) {
      throwInference(
        "unavailable",
        "No Ollama model selected. Pull a model (e.g. ollama pull gemma4) and choose it in the extension."
      );
    }

    await ensureOllamaOriginBypass();

    const functionTools = filterFunctionTools(tools);

    let response;
    try {
      /** @type {Record<string, unknown>} */
      const body = {
        model,
        messages: mapMessagesForOllama(messages),
        stream: true,
      };
      if (functionTools) {
        body.tools = functionTools;
        if (toolChoice !== undefined) {
          body.tool_choice = toolChoice;
        }
      }

      response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Ollama enables thinking by default for supported models; omit `think`
        // unless we add an explicit user control. See docs.ollama.com/capabilities/thinking.
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      rethrowNetwork(err, signal);
    }

    if (!response.ok) {
      let detail = `Ollama HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body?.error === "string" && body.error) detail = body.error;
      } catch {
        // ignore parse failure
      }
      if (response.status === 403) {
        detail =
          "Ollama rejected the request (HTTP 403). Chrome extensions send a chrome-extension:// Origin that Ollama blocks by default. Reload this extension (so it can strip that header), or restart Ollama with OLLAMA_ORIGINS=chrome-extension://*";
      }
      const code =
        response.status === 403
          ? "unavailable"
          : response.status === 404
            ? "provider_error"
            : response.status >= 500
              ? "unavailable"
              : "provider_error";
      throwInference(code, detail);
    }

    if (!response.body) {
      throwInference("provider_error", "Ollama response had no body");
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
    const toolCallsByIndex = new Map();

    /**
     * @param {string} line
     */
    function handleLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (typeof parsed.error === "string" && parsed.error) {
        throwInference("provider_error", parsed.error);
      }

      if (typeof parsed.model === "string" && parsed.model) {
        resolvedModel = parsed.model;
      }

      const thinking = parsed.message?.thinking;
      if (typeof thinking === "string" && thinking.length > 0) {
        reasoning += thinking;
        onReasoningDelta?.(thinking);
      }

      const delta = parsed.message?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        onDelta(delta);
      }

      if (Array.isArray(parsed.message?.tool_calls) && parsed.message.tool_calls.length > 0) {
        accumulateOllamaToolCalls(toolCallsByIndex, parsed.message.tool_calls);
      }

      if (parsed.done) {
        const input =
          typeof parsed.prompt_eval_count === "number"
            ? parsed.prompt_eval_count
            : undefined;
        const output =
          typeof parsed.eval_count === "number" ? parsed.eval_count : undefined;
        if (input != null || output != null) {
          usage = { inputTokens: input, outputTokens: output };
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

    /** @type {{ role: "assistant", content: string, reasoning?: string, tool_calls?: ToolCall[] }} */
    const message = { role: "assistant", content };
    if (reasoning) {
      message.reasoning = reasoning;
    }
    const tool_calls = finalizeOllamaToolCalls(toolCallsByIndex);
    if (tool_calls.length > 0) {
      message.tool_calls = tool_calls;
    }

    return {
      model: resolvedModel,
      message,
      usage,
    };
  },
};
