/** User preferences for chat generation, independent of permission scopes. */

/** @typedef {"page" | "auto" | "none" | "low" | "medium" | "high"} ChatReasoningEffort */
/** @typedef {"global" | ChatReasoningEffort} SiteChatReasoningEffort */
const CHAT_REASONING_EFFORTS = new Set([
  "page", "auto", "none", "low", "medium", "high",
]);

/** @param {unknown} value @returns {ChatReasoningEffort} */
export function normalizeChatReasoningEffort(value) {
  return CHAT_REASONING_EFFORTS.has(value)
    ? /** @type {ChatReasoningEffort} */ (value)
    : "page";
}

/** @param {unknown} value @returns {SiteChatReasoningEffort} */
export function normalizeSiteChatReasoningEffort(value) {
  return CHAT_REASONING_EFFORTS.has(value)
    ? /** @type {ChatReasoningEffort} */ (value)
    : "global";
}

/**
 * Apply the user override after page validation and permission approval.
 * `page` preserves the request, including omission; `auto` overrides a page's
 * explicit effort with the provider/model default via the existing adapters.
 * @param {import("./providers/types.js").InferenceOptions | undefined} options
 * @param {ChatReasoningEffort} preference
 * @param {SiteChatReasoningEffort} [sitePreference]
 * @returns {import("./providers/types.js").InferenceOptions | undefined}
 */
export function applyChatReasoningEffort(options, preference, sitePreference = "global") {
  const site = normalizeSiteChatReasoningEffort(sitePreference);
  const effort = site === "global" ? normalizeChatReasoningEffort(preference) : site;
  return effort === "page" ? options : { ...options, reasoningEffort: effort };
}
