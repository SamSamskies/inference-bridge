/**
 * Shared provider contract. Adapters and the registry import this typedef so
 * the shape cannot drift between openai.js / ollama.js / openrouter.js.
 */

/**
 * @typedef {{
 *   id: string,
 *   label?: string,
 * }} ModelInfo
 */

/**
 * @typedef {{
 *   role: string,
 *   content: string,
 *   reasoning?: string,
 *   tool_call_id?: string,
 *   tool_calls?: ToolCall[],
 * }} ChatMessage
 */

/**
 * MCP-style function definition exposed to the model as a callable tool.
 * The page bridge attaches an `execute` function in the MAIN world; providers
 * only ever see the serializable { name, description, inputSchema } subset.
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   inputSchema?: object,
 * }} ToolDefinition
 */

/**
 * Normalized tool invocation emitted by a provider (and round-tripped back).
 * `arguments` is a parsed JSON object; providers stringify per wire format.
 * `id` is absent for providers without tool-call ids (e.g. Ollama).
 * @typedef {{
 *   id?: string,
 *   name: string,
 *   arguments: Record<string, unknown>,
 * }} ToolCall
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   requiresApiKey: boolean,
 *   optionalApiKey?: boolean,
 *   defaultModel: string,
 *   models?: readonly (string | ModelInfo)[],
 *   listModels?: (args?: { signal?: AbortSignal, apiKey?: string }) => Promise<ModelInfo[]>,
 *   streamChat: (args: {
 *     apiKey?: string,
 *     model: string,
 *     messages: ChatMessage[],
 *     tools?: ToolDefinition[],
 *     signal: AbortSignal,
 *     onDelta: (content: string) => void,
 *     onReasoningDelta?: (content: string) => void,
 *     runTool?: (call: ToolCall) => Promise<string>,
 *   }) => Promise<{
 *     model: string,
 *     message: { role: "assistant", content: string, reasoning?: string, tool_calls?: Array<ToolCall & { result?: string }> },
 *     usage?: { inputTokens?: number, outputTokens?: number },
 *   }>
 * }} Provider
 */

export {};
