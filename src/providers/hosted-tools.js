/**
 * Bridge-normalized hosted `{ type: "web_search" }` helpers.
 * Function-tool filtering stays in openai-compat-stream.js; this file is the
 * hosted-tool identity + OpenRouter mapping.
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
