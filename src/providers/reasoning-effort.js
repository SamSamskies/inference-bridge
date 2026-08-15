/**
 * Map IPA `options.reasoningEffort` onto provider request fields.
 * Best-effort: omit when auto/absent; adapters must not fail solely because a
 * model cannot honor the preference (unsupported models may ignore or 400 —
 * Bridge still sends the mapped field when the API has a known knob).
 */

/** @typedef {"auto" | "none" | "low" | "medium" | "high"} ReasoningEffort */

/** Anthropic extended-thinking budget tiers (tokens). */
export const ANTHROPIC_THINKING_BUDGETS = Object.freeze({
  low: 1024,
  medium: 4096,
  high: 16384,
});

/**
 * OpenAI Chat Completions / OpenRouter / OpenAI-compat: `reasoning_effort`.
 * @param {ReasoningEffort | undefined} effort
 * @returns {"none" | "low" | "medium" | "high" | undefined}
 */
export function mapReasoningEffortForOpenAICompat(effort) {
  if (effort == null || effort === "auto") return undefined;
  return effort;
}

/**
 * Anthropic Messages API: `thinking` (+ optional `max_tokens` bump for headroom).
 * @param {ReasoningEffort | undefined} effort
 * @param {number} defaultMaxTokens
 * @returns {{
 *   thinking: { type: "disabled" } | { type: "enabled", budget_tokens: number },
 *   max_tokens?: number,
 * } | undefined}
 */
export function mapReasoningEffortForAnthropic(effort, defaultMaxTokens) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") {
    return { thinking: { type: "disabled" } };
  }
  const budget_tokens = ANTHROPIC_THINKING_BUDGETS[effort];
  // max_tokens must exceed budget_tokens when thinking is enabled.
  const max_tokens = Math.max(defaultMaxTokens, budget_tokens + 4096);
  return {
    thinking: { type: "enabled", budget_tokens },
    ...(max_tokens !== defaultMaxTokens ? { max_tokens } : {}),
  };
}

/**
 * Ollama `/api/chat`: top-level `think` (boolean or level string).
 * @param {ReasoningEffort | undefined} effort
 * @returns {false | "low" | "medium" | "high" | undefined}
 */
export function mapReasoningEffortForOllama(effort) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") return false;
  return effort;
}
