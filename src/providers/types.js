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
 * }} ChatMessage
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
 *     signal: AbortSignal,
 *     onDelta: (content: string) => void,
 *     onReasoningDelta?: (content: string) => void,
 *   }) => Promise<{
 *     model: string,
 *     message: { role: "assistant", content: string, reasoning?: string },
 *     usage?: { inputTokens?: number, outputTokens?: number },
 *   }>
 * }} Provider
 */

export {};
