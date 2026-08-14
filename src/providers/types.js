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
 * OpenAI-style function tool call (arguments are a JSON string).
 * @typedef {{
 *   id: string,
 *   type: "function",
 *   function: { name: string, arguments: string },
 * }} ToolCall
 */

/**
 * Bridge-experimental tool definition. Hosted tools (e.g. web_search) are
 * declared here for the capability matrix; Chat Completions adapters only
 * forward `type: "function"` entries.
 * @typedef {{
 *   type: "function",
 *   function: {
 *     name: string,
 *     description?: string,
 *     parameters?: object,
 *   },
 * } | { type: "web_search" }} Tool
 */

/**
 * @typedef {"auto" | "none" | "required" | { type: "function", function: { name: string } }} ToolChoice
 */

/**
 * @typedef {{
 *   role: string,
 *   content: string | null,
 *   reasoning?: string,
 *   toolCalls?: ToolCall[],
 *   toolCallId?: string,
 * }} ChatMessage
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   requiresApiKey: boolean,
 *   optionalApiKey?: boolean,
 *   defaultModel: string,
 *   supportsFunctionTools?: boolean,
 *   hostedTools?: readonly string[],
 *   models?: readonly (string | ModelInfo)[],
 *   listModels?: (args?: { signal?: AbortSignal, apiKey?: string }) => Promise<ModelInfo[]>,
 *   preflightMessages?: (messages: ChatMessage[]) => void,
 *   streamChat: (args: {
 *     apiKey?: string,
 *     model: string,
 *     messages: ChatMessage[],
 *     tools?: Tool[],
 *     toolChoice?: ToolChoice,
 *     signal: AbortSignal,
 *     onDelta: (content: string) => void,
 *     onReasoningDelta?: (content: string) => void,
 *   }) => Promise<{
 *     model: string,
 *     message: {
 *       role: "assistant",
 *       content: string,
 *       reasoning?: string,
 *       toolCalls?: ToolCall[],
 *     },
 *     usage?: { inputTokens?: number, outputTokens?: number },
 *   }>
 * }} Provider
 */

export {};
