/**
 * Shared provider contract. Adapters and the registry import this typedef so
 * the shape cannot drift between openai.js / ollama.js / openrouter.js.
 */

/**
 * @typedef {{
 *   id: string,
 *   label?: string,
 *   inputModalities?: string[],
 *   outputModalities?: string[],
 * }} ModelInfo
 */

/**
 * @typedef {{
 *   id: string,
 *   label?: string,
 * }} VoiceInfo
 */

/**
 * Operation-scoped catalogs deliberately do not reuse the provider's chat
 * defaultModel/models fields.
 * @typedef {{
 *   defaultModel: string,
 *   models?: readonly (string | ModelInfo)[],
 *   listModels?: (args?: { signal?: AbortSignal, apiKey?: string }) => Promise<ModelInfo[]>,
 *   acceptedMediaTypes: readonly string[],
 *   maxInputBytes?: number,
 *   listAcceptedMediaTypesForModel?: (args: {
 *     model: string,
 *     signal?: AbortSignal,
 *     apiKey?: string,
 *   }) => Promise<string[]>,
 * }} TranscriptionDescriptor
 *
 * @typedef {{
 *   defaultModel: string,
 *   defaultVoice: string,
 *   models?: readonly (string | ModelInfo)[],
 *   listModels?: (args?: { signal?: AbortSignal, apiKey?: string }) => Promise<ModelInfo[]>,
 *   voices?: readonly (string | VoiceInfo)[],
 *   listVoices?: (args?: {
 *     model?: string,
 *     signal?: AbortSignal,
 *     apiKey?: string,
 *   }) => Promise<VoiceInfo[]>,
 *   outputMediaTypes: readonly string[],
 *   maxTextCodePoints?: number,
 *   maxOutputBytes?: number,
 * }} SynthesisDescriptor
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
 * Bridge-experimental tool definition. Hosted `{ type: "web_search" }` is
 * forwarded on OpenAI (Responses), Anthropic (Messages server tool), and
 * OpenRouter (Chat Completions). Ollama maps it to function tools and
 * Inference Bridge executes `https://ollama.com/api/web_search` (and
 * `web_fetch`) when an Ollama account API key is configured.
 * `toolChoice: "none"` omits hosted search (including the Ollama loop).
 * Adapters that do not honor hosted search fail closed with `unavailable`.
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
 * IPA generation preferences (subset Bridge currently maps).
 * @typedef {{
 *   reasoningEffort?: "auto" | "none" | "low" | "medium" | "high",
 *   temperature?: number,
 * }} InferenceOptions
 */

/**
 * @typedef {{ type: "text", text: string }} TextPart
 * Wire image part after the page injector. Page-facing `request` also accepts
 * `{ type: "image", url }` and `{ data: Blob }`; inject.js resolves those here.
 * @typedef {{
 *   type: "image",
 *   mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
 *   data: string,
 * }} ImagePart
 * @typedef {TextPart | ImagePart} ContentPart
 *
 * @typedef {{
 *   role: string,
 *   content: string | ContentPart[] | null,
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
 *   transcription?: TranscriptionDescriptor,
 *   synthesis?: SynthesisDescriptor,
 *   preflightMessages?: (messages: ChatMessage[]) => void,
 *   transcribe?: (args: {
 *     apiKey?: string,
 *     model: string,
 *     audio: {
 *       data: Blob,
 *       mediaType: string,
 *       byteLength: number,
 *     },
 *     language?: string,
 *     signal: AbortSignal,
 *     onDelta: (content: string) => void | Promise<void>,
 *   }) => Promise<{
 *     model: string,
 *     transcript: { text: string, language?: string },
 *     usage?: { inputSeconds?: number },
 *   }>,
 *   synthesize?: (args: {
 *     apiKey?: string,
 *     model: string,
 *     voice: string,
 *     text: string,
 *     mediaType: "audio/mpeg",
 *     signal: AbortSignal,
 *     onAudioDelta: (data: Uint8Array) => void | Promise<void>,
 *   }) => Promise<{
 *     model: string,
 *     audio: {
 *       mediaType: "audio/mpeg",
 *       byteLength: number,
 *     },
 *     usage?: { inputCharacters?: number, outputSeconds?: number },
 *   }>,
 *   streamChat: (args: {
 *     apiKey?: string,
 *     model: string,
 *     messages: ChatMessage[],
 *     tools?: Tool[],
 *     toolChoice?: ToolChoice,
 *     options?: InferenceOptions,
 *     output?: { images?: boolean },
 *     signal: AbortSignal,
 *     onDelta: (content: string) => void,
 *     onReasoningDelta?: (content: string) => void,
 *   }) => Promise<{
 *     model: string,
 *     message: {
 *       role: "assistant",
 *       content: string | ContentPart[],
 *       reasoning?: string,
 *       toolCalls?: ToolCall[],
 *     },
 *     usage?: { inputTokens?: number, outputTokens?: number },
 *   }>
 * }} Provider
 */

export {};
