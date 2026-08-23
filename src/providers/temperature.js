/**
 * Map IPA `options.temperature` onto provider request fields.
 * Best-effort: omit when absent; adapters must not fail solely because a
 * model cannot honor the preference. IPA scale is `[0, 2]` (OpenAI-style);
 * providers with a narrower range are clamped. OpenAI-compatible APIs retry
 * once without `temperature` when a 400 names that field (some GPT-5
 * reasoning models only accept the default `1`).
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
 * a reasoning-effort 400). gpt-5-nano (and some other GPT-5 reasoning models)
 * only accept the default `1`.
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
 * Anthropic Messages API: top-level `temperature` in `[0, 1]`.
 * @param {number | undefined} temperature
 * @returns {number | undefined}
 */
export function mapTemperatureForAnthropic(temperature) {
  if (temperature == null) return undefined;
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
