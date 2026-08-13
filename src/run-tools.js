/**
 * Page-side multi-turn function-tool loop for experimental.request.
 *
 * Bridge does not execute tools — callers pass `execute` handlers. The loop
 * only relays via `request` (AsyncIterable) and appends role:"tool" messages.
 *
 * content/inject.js mirrors this for MAIN-world (classic script cannot import).
 */

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function makeError(code, message) {
  const error = new Error(message || code);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  return /** @type {Error & { code: string }} */ (error);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function serializeToolResult(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {string | undefined | null} argumentsJson
 * @param {string} toolName
 * @returns {unknown}
 */
export function parseToolArguments(argumentsJson, toolName) {
  const raw = argumentsJson == null || argumentsJson === "" ? "{}" : argumentsJson;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw makeError(
      "invalid_request",
      `Tool "${toolName}" arguments are not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * @param {{
 *   request: (req: object) => AsyncIterable<any>,
 *   messages: object[],
 *   tools?: object[],
 *   execute?: Record<string, (args: any) => unknown | Promise<unknown>>,
 *   maxRounds?: number,
 *   tool_choice?: unknown,
 *   onDelta?: (content: string) => void,
 *   onReasoningDelta?: (content: string) => void,
 *   signal?: AbortSignal,
 *   method?: string,
 * }} options
 * @returns {Promise<{ messages: object[], final: object }>}
 */
export async function runTools(options) {
  if (options == null || typeof options !== "object") {
    throw makeError("invalid_request", "runTools options must be an object.");
  }

  const {
    request,
    tools,
    execute,
    maxRounds = 5,
    tool_choice: toolChoice,
    onDelta,
    onReasoningDelta,
    signal,
    method = "chat",
  } = options;

  if (typeof request !== "function") {
    throw makeError("invalid_request", "runTools requires a request function.");
  }
  if (!Array.isArray(options.messages)) {
    throw makeError("invalid_request", "runTools requires a messages array.");
  }
  if (typeof maxRounds !== "number" || !Number.isFinite(maxRounds) || maxRounds < 1) {
    throw makeError("invalid_request", "maxRounds must be a positive number.");
  }

  /** @type {object[]} */
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
    if (toolChoice !== undefined) req.tool_choice = toolChoice;

    /** @type {object | undefined} */
    let done;
    for await (const chunk of request(req)) {
      if (signal?.aborted) {
        throw makeError("aborted", "Request aborted");
      }
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.type === "delta" && typeof onDelta === "function") {
        onDelta(chunk.content);
      } else if (chunk.type === "reasoning_delta" && typeof onReasoningDelta === "function") {
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
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
        ? message.tool_calls
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
      tool_calls: toolCalls,
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

      const executor = execute && typeof execute === "object" ? execute[name] : undefined;
      if (typeof executor !== "function") {
        throw makeError(
          "invalid_request",
          `No execute handler for tool "${name}".`
        );
      }

      const args = parseToolArguments(call.function.arguments, name);
      const result = await executor(args);
      messages = [
        ...messages,
        {
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(result),
        },
      ];
    }
  }

  throw makeError(
    "provider_error",
    `Tool loop exceeded maxRounds (${maxRounds}).`
  );
}
