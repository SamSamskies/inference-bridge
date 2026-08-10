/**
 * Anthropic Messages API streaming adapter.
 * First-class BYOK provider — not OpenAI-compatible Chat Completions.
 */

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
 * Map IPA messages to Anthropic Messages API shape.
 * System roles become a top-level `system` string; outbound `reasoning` is dropped.
 * Consecutive same-role turns are merged so the result alternates user/assistant.
 * @param {Array<{ role: string, content: string, reasoning?: string }>} messages
 * @returns {{ system?: string, messages: Array<{ role: string, content: string }> }}
 */
export function mapMessagesForAnthropic(messages) {
  /** @type {string[]} */
  const systemParts = [];
  /** @type {Array<{ role: string, content: string }>} */
  const mapped = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) {
        systemParts.push(m.content);
      }
      continue;
    }
    const last = mapped[mapped.length - 1];
    if (last && last.role === m.role) {
      last.content =
        last.content && m.content
          ? `${last.content}\n\n${m.content}`
          : last.content || m.content;
      continue;
    }
    mapped.push({ role: m.role, content: m.content });
  }

  if (mapped.length === 0) {
    throwInference(
      "invalid_request",
      "Anthropic requires at least one non-system message"
    );
  }

  /** @type {{ system?: string, messages: Array<{ role: string, content: string }> }} */
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

  async streamChat({ apiKey, model, messages, signal, onDelta, onReasoningDelta }) {
    const mapped = mapMessagesForAnthropic(messages);

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
        body: JSON.stringify({
          model,
          max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
          stream: true,
          ...(mapped.system ? { system: mapped.system } : {}),
          messages: mapped.messages,
        }),
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
        }
        // input_json_delta / signature_delta: ignore (tools out of scope)
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

    /** @type {{ role: "assistant", content: string, reasoning?: string }} */
    const message = { role: "assistant", content };
    if (reasoning) {
      message.reasoning = reasoning;
    }

    return {
      model: resolvedModel,
      message,
      usage,
    };
  },
};
