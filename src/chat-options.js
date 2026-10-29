/** User preferences for chat generation, independent of permission scopes. */

/** @typedef {"page" | "auto" | "none" | "low" | "medium" | "high"} ChatReasoningEffort */
const CHAT_REASONING_EFFORTS = new Set([
  "page", "auto", "none", "low", "medium", "high",
]);

/** @param {unknown} value @returns {ChatReasoningEffort} */
export function normalizeChatReasoningEffort(value) {
  return CHAT_REASONING_EFFORTS.has(value)
    ? /** @type {ChatReasoningEffort} */ (value)
    : "page";
}

/**
 * Apply the user override after page validation and permission approval.
 * `page` preserves the request, including omission; `auto` overrides a page's
 * explicit effort with the provider/model default via the existing adapters.
 * @param {import("./providers/types.js").InferenceOptions | undefined} options
 * @param {ChatReasoningEffort} preference
 * @returns {import("./providers/types.js").InferenceOptions | undefined}
 */
export function applyChatReasoningEffort(options, preference) {
  const effort = normalizeChatReasoningEffort(preference);
  return effort === "page" ? options : { ...options, reasoningEffort: effort };
}
