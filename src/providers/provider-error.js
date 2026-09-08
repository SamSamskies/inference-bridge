/**
 * Format OpenAI / OpenRouter-style API error bodies for page-facing messages.
 *
 * OpenRouter often wraps upstream failures as a generic
 * "Provider returned error" / "Server tool request failed" while putting the
 * real reason in `error.metadata.raw` (JSON string) and `provider_name`.
 */

/**
 * Dig a human-readable message out of nested provider error JSON.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
function digErrorMessage(value, depth = 0) {
  if (depth > 5) return "";
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const rec = /** @type {Record<string, unknown>} */ (value);
  const nested =
    rec.error !== undefined ? digErrorMessage(rec.error, depth + 1) : "";
  const own =
    typeof rec.message === "string" && rec.message.trim()
      ? rec.message.trim()
      : "";

  // Prefer a nested message when it adds detail beyond the outer wrapper.
  if (nested && own && nested !== own) return nested;
  if (own) return own;
  if (nested) return nested;
  return "";
}

/**
 * @param {unknown} metadata
 * @returns {{ providerName: string, detail: string }}
 */
function readErrorMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { providerName: "", detail: "" };
  }
  const rec = /** @type {Record<string, unknown>} */ (metadata);
  const providerName =
    typeof rec.provider_name === "string" && rec.provider_name.trim()
      ? rec.provider_name.trim()
      : typeof rec.providerName === "string" && rec.providerName.trim()
        ? rec.providerName.trim()
        : "";

  const raw = rec.raw;
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    try {
      const parsed = JSON.parse(trimmed);
      const detail = digErrorMessage(parsed);
      if (detail) return { providerName, detail };
    } catch {
      // Non-JSON raw strings are still useful when short.
    }
    if (trimmed.length <= 500) return { providerName, detail: trimmed };
    return { providerName, detail: "" };
  }
  if (raw && typeof raw === "object") {
    const detail = digErrorMessage(raw);
    if (detail) return { providerName, detail };
  }
  return { providerName, detail: "" };
}

/**
 * @param {string} outer
 * @param {string} detail
 * @returns {boolean}
 */
function messageAlreadyIncludesDetail(outer, detail) {
  if (!outer || !detail) return false;
  return outer.toLowerCase().includes(detail.toLowerCase());
}

/**
 * Format a provider `error` field (object or string) into a single message.
 *
 * @param {unknown} error
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatProviderApiError(error, fallback = "Provider error") {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return fallback;
  }

  const rec = /** @type {Record<string, unknown>} */ (error);
  const outer =
    typeof rec.message === "string" && rec.message.trim()
      ? rec.message.trim()
      : "";
  const { providerName, detail } = readErrorMetadata(rec.metadata);

  if (detail && outer && !messageAlreadyIncludesDetail(outer, detail)) {
    if (providerName && !messageAlreadyIncludesDetail(outer, providerName)) {
      return `${outer} (${providerName}): ${detail}`;
    }
    return `${outer}: ${detail}`;
  }
  if (detail && !outer) {
    return providerName ? `${providerName}: ${detail}` : detail;
  }
  if (outer) {
    if (providerName && !messageAlreadyIncludesDetail(outer, providerName)) {
      return `${outer} (${providerName})`;
    }
    return outer;
  }
  return fallback;
}

/**
 * Read an HTTP error response body and format it for InferenceError.message.
 *
 * @param {Response} response
 * @param {string} fallback
 * @returns {Promise<string>}
 */
export async function readProviderErrorDetail(response, fallback) {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      return formatProviderApiError(
        /** @type {Record<string, unknown>} */ (body).error,
        fallback
      );
    }
    if (
      body &&
      typeof body === "object" &&
      typeof /** @type {Record<string, unknown>} */ (body).message === "string" &&
      /** @type {Record<string, unknown>} */ (body).message
    ) {
      return String(/** @type {Record<string, unknown>} */ (body).message);
    }
  } catch {
    // ignore parse failure
  }
  return fallback;
}
