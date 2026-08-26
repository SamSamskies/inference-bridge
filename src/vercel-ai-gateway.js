/**
 * Hostname detection and Options/approval helpers for leftover OpenAI-compatible
 * endpoints pointed at Vercel AI Gateway. Mapping hosted search still requires
 * the built-in `vercel` provider — URL sniffing never enables search on compat.
 */

export const VERCEL_AI_GATEWAY_HOST = "ai-gateway.vercel.sh";
export const VERCEL_AI_GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
export const VERCEL_DEFAULT_MODEL = "openai/gpt-5.6-luna";

export const VERCEL_AI_GATEWAY_COMPAT_WEB_SEARCH_MESSAGE =
  "This looks like Vercel AI Gateway — pick Vercel AI Gateway in the dropdown to allow search.";

export const VERCEL_AI_GATEWAY_COMPAT_SWITCH_HINT =
  "This named server is Vercel AI Gateway as an OpenAI-compatible endpoint. Switch to the built-in provider to enable hosted web search.";

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasNonEmptyKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Gateway catalog ids are `provider/model`.
 * @param {unknown} model
 * @returns {boolean}
 */
function isPlausibleVercelModel(model) {
  return typeof model === "string" && model.trim().includes("/");
}

/**
 * True when `baseUrl` is the Vercel AI Gateway host (path/query ignored).
 * @param {unknown} baseUrl
 * @returns {boolean}
 */
export function isVercelAiGatewayBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === VERCEL_AI_GATEWAY_HOST;
  } catch {
    return false;
  }
}

/**
 * True when a listed provider is a leftover named endpoint pointed at Gateway.
 * @param {{ id?: string, baseUrl?: string } | null | undefined} provider
 * @returns {boolean}
 */
export function isVercelAiGatewayCompatProvider(provider) {
  return (
    typeof provider?.id === "string" &&
    provider.id.startsWith("compat:") &&
    isVercelAiGatewayBaseUrl(provider.baseUrl)
  );
}

/**
 * Disambiguate leftover Gateway rows from the built-in in provider dropdowns.
 * @param {unknown} label
 * @returns {string}
 */
export function vercelAiGatewayCompatDropdownLabel(label) {
  const base =
    typeof label === "string" && label.trim() ? label.trim() : "OpenAI-compatible";
  if (/\(OpenAI-compatible\)\s*$/i.test(base)) return base;
  return `${base} (OpenAI-compatible)`;
}

/**
 * @param {{
 *   id?: string,
 *   label?: string,
 *   baseUrl?: string,
 * } | null | undefined} provider
 * @returns {string}
 */
export function providerDropdownLabel(provider) {
  const label = typeof provider?.label === "string" ? provider.label : "";
  if (isVercelAiGatewayCompatProvider(provider)) {
    return vercelAiGatewayCompatDropdownLabel(label);
  }
  return label;
}

/**
 * Options-list hint: skip when the built-in provider is already configured
 * or already selected as default.
 * @param {{
 *   apiKeys?: Record<string, string>,
 *   defaultProviderId?: string,
 *   selectedProviderId?: string,
 * }} [args]
 * @returns {boolean}
 */
export function shouldNudgeVercelAiGatewayCompat({
  apiKeys,
  defaultProviderId,
  selectedProviderId,
} = {}) {
  if (hasNonEmptyKey(apiKeys?.vercel)) return false;
  if (defaultProviderId === "vercel" || selectedProviderId === "vercel") {
    return false;
  }
  return true;
}

/**
 * Settings patch for **Use built-in provider**. Does not delete the compat row.
 * Copies the endpoint API key into `apiKeys.vercel` only when that slot is empty.
 * Copies the last model when it looks like `provider/model` and Vercel has none.
 *
 * @param {{
 *   endpointId: string,
 *   apiKeys?: Record<string, string>,
 *   defaultModels?: Record<string, string>,
 * }} args
 * @returns {{
 *   defaultProviderId: "vercel",
 *   apiKeys: Record<string, string>,
 *   defaultModels: Record<string, string>,
 * }}
 */
export function vercelAiGatewayFromCompatPatch({
  endpointId,
  apiKeys = {},
  defaultModels = {},
}) {
  /** @type {Record<string, string>} */
  const nextApiKeys = {};
  if (!hasNonEmptyKey(apiKeys.vercel) && hasNonEmptyKey(apiKeys[endpointId])) {
    nextApiKeys.vercel = /** @type {string} */ (apiKeys[endpointId]).trim();
  }

  /** @type {Record<string, string>} */
  const nextDefaultModels = {};
  if (!isPlausibleVercelModel(defaultModels.vercel)) {
    const fromCompat = defaultModels[endpointId];
    nextDefaultModels.vercel = isPlausibleVercelModel(fromCompat)
      ? fromCompat.trim()
      : VERCEL_DEFAULT_MODEL;
  }

  return {
    defaultProviderId: "vercel",
    apiKeys: nextApiKeys,
    defaultModels: nextDefaultModels,
  };
}
