/**
 * Map IPA `options.temperature` onto provider request fields.
 * Best-effort: omit when absent; adapters must not fail solely because a
 * model cannot honor the preference. IPA scale is `[0, 2]` (OpenAI-style);
 * providers with a narrower range are clamped.
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
