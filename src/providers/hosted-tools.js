/**
 * Bridge-normalized hosted `{ type: "web_search" }` helpers.
 * Function-tool filtering stays in openai-compat-stream.js; this file is the
 * hosted-tool identity + OpenRouter mapping. Ollama’s Bridge-executed
 * ollama.com loop lives in ollama-web-search.js.
 */

/** @typedef {import("./types.js").Tool} Tool */

export const HOSTED_WEB_SEARCH = "web_search";

/** OpenRouter Chat Completions server tool. */
export const OPENROUTER_WEB_SEARCH_TOOL = Object.freeze({
  type: "openrouter:web_search",
});

/**
 * Anthropic Messages API server tool. Pin the basic versioned type so
 * `allowed_callers` defaults to direct search (newer types default to
 * code-execution callers, which Bridge does not enable).
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
export const ANTHROPIC_WEB_SEARCH_TOOL = Object.freeze({
  type: "web_search_20250305",
  name: "web_search",
});

/** OpenAI Responses API hosted tool. */
export const OPENAI_WEB_SEARCH_TOOL = Object.freeze({
  type: "web_search",
});

/**
 * @param {Tool[] | undefined | null} tools
 * @returns {boolean}
 */
export function hasHostedWebSearch(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((t) => t != null && typeof t === "object" && t.type === "web_search");
}

/**
 * IPA: `toolChoice: "none"` suppresses hosted web_search as well as function calls.
 * @param {unknown} toolChoice
 * @returns {boolean}
 */
export function hostedWebSearchSuppressed(toolChoice) {
  return toolChoice === "none";
}

/**
 * True when hosted web_search is present and should actually run.
 * @param {Tool[] | undefined | null} tools
 * @param {unknown} [toolChoice]
 * @returns {boolean}
 */
export function hostedWebSearchActive(tools, toolChoice) {
  return hasHostedWebSearch(tools) && !hostedWebSearchSuppressed(toolChoice);
}

/**
 * Drop hosted `{ type: "web_search" }` when `toolChoice` is `"none"`.
 * Other tools are unchanged. Used so provider-executed search is omitted, not
 * merely sent with `tool_choice: "none"`.
 *
 * @param {Tool[] | undefined | null} tools
 * @param {unknown} [toolChoice]
 * @returns {Tool[] | undefined | null}
 */
export function omitHostedWebSearchIfNone(tools, toolChoice) {
  if (toolChoice !== "none" || !Array.isArray(tools)) return tools;
  const out = tools.filter(
    (t) => t != null && typeof t === "object" && t.type !== "web_search"
  );
  return out.length > 0 ? out : undefined;
}

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
 * @param {{
 *   id?: string,
 *   label?: string,
 * } | null | undefined} provider
 * @returns {string}
 */
export function hostedWebSearchUnavailableMessage(provider) {
  const isOpenAICompat =
    typeof provider?.id === "string" && provider.id.startsWith("compat:");
  if (isOpenAICompat) {
    return "Hosted web search is not available for OpenAI-compatible servers. Choose another provider.";
  }
  const label =
    provider && typeof provider.label === "string" && provider.label
      ? provider.label
      : "This provider";
  return `Hosted web search is not supported by ${label}. Choose another provider.`;
}

/**
 * Fail closed when hosted web_search is active but the provider cannot honor it.
 * `toolChoice: "none"` suppresses search, so this is a no-op in that case.
 *
 * @param {{
 *   id?: string,
 *   label?: string,
 *   hostedTools?: readonly string[],
 * } | null | undefined} provider
 * @param {Tool[] | undefined | null} tools
 * @param {unknown} [toolChoice]
 * @returns {void}
 */
export function assertHostedWebSearchSupported(provider, tools, toolChoice) {
  if (!hostedWebSearchActive(tools, toolChoice)) return;
  const hosted = Array.isArray(provider?.hostedTools) ? provider.hostedTools : [];
  if (hosted.includes("web_search")) return;
  throwInference("unavailable", hostedWebSearchUnavailableMessage(provider));
}

/**
 * Map Bridge tools onto OpenRouter Chat Completions `tools`.
 * Function tools stay OpenAI-shaped; `{ type: "web_search" }` becomes
 * `{ type: "openrouter:web_search" }`.
 * @param {Tool[] | undefined} tools
 * @returns {Array<Tool | { type: "openrouter:web_search" }> | undefined}
 */
export function mapToolsForOpenRouter(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  /** @type {Array<Tool | { type: "openrouter:web_search" }>} */
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "web_search") {
      out.push({ ...OPENROUTER_WEB_SEARCH_TOOL });
    } else if (t.type === "function") {
      out.push(t);
    }
  }
  return out.length > 0 ? out : undefined;
}
