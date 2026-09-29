/**
 * Map IPA `options.temperature` onto provider request fields.
 * Best-effort: omit when absent; adapters must not fail solely because a
 * model cannot honor the preference. IPA scale is `[0, 2]` (OpenAI-style);
 * providers with a narrower range are clamped. Providers that reject the
 * field are retried without it when the error identifies temperature.
 */

/**
 * OpenAI Chat Completions / OpenRouter / OpenAI-compat: top-level `temperature`.
 * @param {number | undefined} temperature
 * @returns {number | undefined}
 */
export function mapTemperatureForOpenAICompat(temperature) {
  if (temperature == null) return undefined;
  return temperature;
}

/**
 * True when the provider rejected `temperature` (not auth/rate-limit, and not
 * a reasoning-effort 400). This covers both OpenAI's unsupported-value errors
 * and Anthropic's deprecated-field errors.
 * @param {number} status
 * @param {string} message
 * @returns {boolean}
 */
export function isUnsupportedTemperatureError(status, message) {
  if (status !== 400 && status !== 422) return false;
  if (typeof message !== "string" || !message) return false;
  const lower = message.toLowerCase();
  if (!lower.includes("temperature")) return false;
  return (
    lower.includes("deprecated") ||
    lower.includes("not support") ||
    lower.includes("unsupported") ||
    lower.includes("only the default")
  );
}

/**
 * @param {number} status
 * @param {string} message
 * @param {number | undefined} sentTemperature
 * @returns {{ retry: false } | { retry: true }}
 */
export function nextOpenAICompatTemperatureAfterError(
  status,
  message,
  sentTemperature
) {
  if (sentTemperature === undefined) return { retry: false };
  if (!isUnsupportedTemperatureError(status, message)) {
    return { retry: false };
  }
  return { retry: true };
}

/**
 * Anthropic Messages API: top-level `temperature` in `[0, 1]` on older
 * models. Claude 4.7+ deprecates sampling controls, so use the model default.
 * @param {number | undefined} temperature
 * @param {string | undefined} model
 * @returns {number | undefined}
 */
export function mapTemperatureForAnthropic(temperature, model) {
  if (temperature == null) return undefined;
  const leaf = typeof model === "string" ? model.split("/").pop() : "";
  // A long numeric suffix is a snapshot date (e.g. claude-opus-4-20250514),
  // not a minor version.
  const match = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(leaf);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2] ?? 0);
    if (major > 4 || (major === 4 && minor >= 7)) return undefined;
  }
  return Math.min(temperature, 1);
}

/**
 * Ollama `/api/chat`: nested `options.temperature`.
 * @param {number | undefined} temperature
 * @returns {number | undefined}
 */
export function mapTemperatureForOllama(temperature) {
  if (temperature == null) return undefined;
  return temperature;
}
