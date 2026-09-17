/**
 * Provider-independent limits and format helpers for the experimental bounded
 * speech methods. These are Bridge incubation limits, not stable IPA limits.
 */

export const TRANSCRIPTION_INPUT_MAX_BYTES = 24_000_000;
export const SYNTHESIS_TEXT_MAX_CODE_POINTS = 4_096;
export const SYNTHESIS_OUTPUT_MAX_BYTES = 32_000_000;
export const AUDIO_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const SYNTHESIS_OUTPUT_MEDIA_TYPE = "audio/mpeg";

export const TRANSCRIPTION_MEDIA_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

const TRANSCRIPTION_MEDIA_TYPE_SET = new Set(TRANSCRIPTION_MEDIA_TYPES);
const TRANSCRIPTION_MEDIA_TYPE_ALIASES = new Map([
  ["audio/mp3", "audio/mpeg"],
  ["audio/x-m4a", "audio/mp4"],
  ["audio/wave", "audio/wav"],
  ["audio/x-wav", "audio/wav"],
  ["audio/vnd.wave", "audio/wav"],
]);

/**
 * Normalize MIME parameters and unambiguous aliases within the Bridge
 * transcription envelope.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTranscriptionMediaType(value) {
  if (typeof value !== "string") return "";
  const mime = value.split(";")[0].trim().toLowerCase();
  const normalized = TRANSCRIPTION_MEDIA_TYPE_ALIASES.get(mime) || mime;
  return TRANSCRIPTION_MEDIA_TYPE_SET.has(normalized) ? normalized : "";
}

/**
 * Return the decoded byte length of canonical raw base64 without allocating
 * the decoded payload. Data URLs and whitespace are deliberately rejected.
 * @param {unknown} value
 * @returns {number} -1 when malformed
 */
export function rawBase64ByteLength(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return -1;
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    return -1;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Count Unicode code points rather than UTF-16 code units.
 * @param {string} value
 * @returns {number}
 */
export function countUnicodeCodePoints(value) {
  return [...value].length;
}

/**
 * Validate an optional BCP 47 language hint using the browser runtime's
 * standards-backed locale parser.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStructurallyValidLanguageTag(value) {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  try {
    Intl.getCanonicalLocales(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidTranscriptionByteLength(value) {
  return (
    Number.isSafeInteger(value) &&
    /** @type {number} */ (value) > 0 &&
    /** @type {number} */ (value) <= TRANSCRIPTION_INPUT_MAX_BYTES
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSynthesisText(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    countUnicodeCodePoints(value) <= SYNTHESIS_TEXT_MAX_CODE_POINTS
  );
}
