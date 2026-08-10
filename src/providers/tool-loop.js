/**
 * Shared multi-turn tool-calling loop for streaming providers.
 *
 * The service worker drives the loop: a provider turn may end with tool_calls
 * (no final answer yet). The loop asks the page to execute each call via the
 * injected `runTool` callback, appends the assistant tool_calls + tool results
 * to the message history, and starts a new provider turn. Content and
 * reasoning deltas accumulate across turns so `done.message.content` still
 * equals the concatenation of every `delta` chunk.
 */

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

/** @typedef {import("./types.js").ToolCall} ToolCall */

/**
 * @param {{
 *   turn: (messages: Array<Record<string, unknown>>) => Promise<{
 *     content: string,
 *     reasoning?: string,
 *     usage?: { inputTokens?: number, outputTokens?: number },
 *     model?: string,
 *     toolCalls?: ToolCall[],
 *   }>,
 *   initialMessages: Array<Record<string, unknown>>,
 *   runTool?: (call: ToolCall) => Promise<string>,
 *   maxTurns?: number,
 * }} args
 * @returns {Promise<{
 *   model?: string,
 *   message: { role: "assistant", content: string, reasoning?: string, tool_calls?: Array<ToolCall & { result?: string }> },
 *   usage?: { inputTokens?: number, outputTokens?: number },
 * }>}
 */
export async function runToolLoop({
  turn,
  initialMessages,
  runTool,
  maxTurns = 25,
}) {
  let messages = initialMessages;
  /** @type {{ inputTokens?: number, outputTokens?: number } | undefined} */
  let usage;
  let content = "";
  let reasoning = "";
  let model;
  /** @type {Array<ToolCall & { result?: string }>} */
  const toolCallsSeen = [];

  for (let i = 0; i < maxTurns; i++) {
    const result = await turn(messages);
    if (typeof result.content === "string") content += result.content;
    if (typeof result.reasoning === "string") reasoning += result.reasoning;
    if (result.usage) {
      if (!usage) {
        usage = { ...result.usage };
      } else {
        usage = {
          ...(usage.inputTokens != null || result.usage.inputTokens != null
            ? {
                inputTokens:
                  (usage.inputTokens || 0) + (result.usage.inputTokens || 0),
              }
            : {}),
          ...(usage.outputTokens != null || result.usage.outputTokens != null
            ? {
                outputTokens:
                  (usage.outputTokens || 0) + (result.usage.outputTokens || 0),
              }
            : {}),
        };
      }
    }
    if (typeof result.model === "string" && result.model) {
      model = result.model;
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      if (typeof runTool !== "function") {
        throwInference(
          "provider_error",
          "The provider requested a tool call, but no tool executor is available."
        );
      }
      /** @type {Array<Record<string, unknown>>} */
      const toolMessages = [];
      for (const call of result.toolCalls) {
        const toolResult = await runTool(call);
        toolCallsSeen.push({ ...call, result: toolResult });
        const toolMessage = { role: "tool", content: toolResult };
        if (call.id) {
          toolMessage.tool_call_id = call.id;
        }
        toolMessages.push(toolMessage);
      }
      messages = [
        ...messages,
        { role: "assistant", content: result.content, tool_calls: result.toolCalls },
        ...toolMessages,
      ];
      continue;
    }

    /** @type {{ role: "assistant", content: string, reasoning?: string, tool_calls?: Array<ToolCall & { result?: string }> }} */
    const message = { role: "assistant", content };
    if (reasoning) message.reasoning = reasoning;
    if (toolCallsSeen.length > 0) message.tool_calls = toolCallsSeen;
    return { model, message, usage };
  }

  throwInference(
    "provider_error",
    "Tool call loop exceeded the maximum number of turns"
  );
}
