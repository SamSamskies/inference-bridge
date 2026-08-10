/**
 * Ollama chat streaming adapter (local http://localhost:11434).
 * Models are discovered via GET /api/tags — no hardcoded catalog.
 */

import { ensureOllamaOriginBypass } from "../ollama-origin-bypass.js";
import { runToolLoop } from "./tool-loop.js";

export const OLLAMA_BASE_URL = "http://localhost:11434";

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
 * Map IPA messages to Ollama chat messages, round-tripping reasoning as
 * `thinking`, assistant tool_calls, and tool results.
 * Ollama has no tool-call ids; tool results pair with the preceding assistant
 * tool_calls by order, so ids are dropped.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function mapMessagesForOllama(messages) {
  return messages.map((m) => {
    /** @type {Record<string, unknown>} */
    const out = { role: m.role, content: m.content };
    if (typeof m.reasoning === "string" && m.reasoning) {
      out.thinking = m.reasoning;
    }
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      out.tool_calls = m.tool_calls.map((c) => ({
        function: {
          name: c.name,
          arguments:
            c.arguments && typeof c.arguments === "object"
              ? c.arguments
              : {},
        },
      }));
    }
    return out;
  });
}

/**
 * Map MCP-style tool definitions to the Ollama tools array shape.
 * @param {ToolDefinition[]} tools
 * @returns {Array<Record<string, unknown>>}
 */
export function mapToolsForOllama(tools) {
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
 * Stream a single Ollama /api/chat turn.
 * Ollama emits thinking, content, and (in the final message) tool_calls.
 * @param {{
 *   model: string,
 *   messages: Array<Record<string, unknown>>,
 *   tools?: ToolDefinition[],
 *   signal: AbortSignal,
 *   onDelta: (content: string) => void,
 *   onReasoningDelta?: (content: string) => void,
 * }} args
 * @returns {Promise<{
 *   model: string,
 *   content: string,
 *   reasoning: string,
 *   usage?: { inputTokens?: number, outputTokens?: number },
 *   toolCalls?: ToolCall[],
 * }>}
 */
async function streamOllamaChatTurn({
  model,
  messages,
  tools,
  signal,
  onDelta,
  onReasoningDelta,
}) {
  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ollama enables thinking by default for supported models; omit `think`
      // unless we add an explicit user control. See docs.ollama.com/capabilities/thinking.
      body: JSON.stringify({
        model,
        messages: mapMessagesForOllama(messages),
        ...(tools && tools.length > 0
          ? { tools: mapToolsForOllama(tools) }
          : {}),
        stream: true,
      }),
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
  /** @type {ToolCall[] | undefined} */
  let resolvedToolCalls;

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

    // Ollama sends the full tool_calls array in one message (typically the
    // final one, alongside done=true). Arguments may be an object or a string.
    if (Array.isArray(parsed.message?.tool_calls) && parsed.message.tool_calls.length > 0) {
      const calls = [];
      for (const tc of parsed.message.tool_calls) {
        const name = tc?.function?.name;
        if (typeof name !== "string" || !name) continue;
        let args = tc?.function?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        if (args == null || typeof args !== "object" || Array.isArray(args)) {
          args = {};
        }
        calls.push({ name, arguments: args });
      }
      if (calls.length > 0) {
        resolvedToolCalls = calls;
      }
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

/** @typedef {import("./types.js").Provider} Provider */

/** @type {Provider} */
export const ollamaProvider = {
  id: "ollama",
  label: "Ollama",
  requiresApiKey: false,
  // Placeholder until /api/tags is queried; never used as a hardcoded catalog.
  defaultModel: "",

  listModels: listOllamaModels,

  async streamChat({ model, messages, tools, signal, onDelta, onReasoningDelta, runTool }) {
    if (!model) {
      throwInference(
        "unavailable",
        "No Ollama model selected. Pull a model (e.g. ollama pull gemma4) and choose it in the extension."
      );
    }

    await ensureOllamaOriginBypass();

    const result = await runToolLoop({
      initialMessages: /** @type {Array<Record<string, unknown>>} */ (messages),
      runTool,
      turn: (msgs) =>
        streamOllamaChatTurn({
          model,
          messages: msgs,
          tools,
          signal,
          onDelta,
          onReasoningDelta,
        }),
    });

    return {
      model: result.model || model,
      message: result.message,
      usage: result.usage,
    };
  },
};
