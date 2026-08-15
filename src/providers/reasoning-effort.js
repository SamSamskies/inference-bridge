/**
 * Map IPA `options.reasoningEffort` onto provider request fields.
 * Best-effort: omit when auto/absent; adapters must not fail solely because a
 * model cannot honor the preference (unsupported models may ignore or 400 —
 * Bridge still sends the mapped field when the API has a known knob).
 */

/** @typedef {"auto" | "none" | "low" | "medium" | "high"} ReasoningEffort */

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
 * Anthropic Messages API: adaptive thinking + `output_config.effort`
 * (replaces deprecated `thinking.type: "enabled"` + `budget_tokens`).
 * @param {ReasoningEffort | undefined} effort
 * @returns {{
 *   thinking: { type: "disabled" } | { type: "adaptive" },
 *   output_config?: { effort: "low" | "medium" | "high" },
 * } | undefined}
 */
export function mapReasoningEffortForAnthropic(effort) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") {
    return { thinking: { type: "disabled" } };
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
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
