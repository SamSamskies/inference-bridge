/** Adapter-owned limits; these are Bridge/provider limits, not IPA maxima. */
import { DECISION_IMAGE_MEDIA_TYPES, DECISION_IMAGE_MAX_BYTES, DECISION_IMAGES_MAX_BYTES, DECISION_MEDIA_TRANSPORT_MAX_BYTES } from "../decision-media.js";
import { byteLimitMessage } from "../format-bytes.js";
import { DECISION_BODY_MAX_BYTES, DECISION_MAX_QUESTIONS } from "../decisions.js";

const imageLimits = {
  imageMediaTypes: DECISION_IMAGE_MEDIA_TYPES,
  maxImageBytes: DECISION_IMAGE_MAX_BYTES,
  maxTotalImageBytes: DECISION_IMAGES_MAX_BYTES,
  maxMediaBodyBytes: DECISION_MEDIA_TRANSPORT_MAX_BYTES,
};
export const DECISION_LIMITS = Object.freeze({
  // https://developers.openai.com/api/docs/guides/decisions#ask-multiple-questions
  openai: Object.freeze({ ...imageLimits, maxQuestions: 400, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  // https://aistudio.google.com/docs/decisions-api#limits
  gemini: Object.freeze({ ...imageLimits, maxQuestions: 1000, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  // https://docs.ollama.com/openapi.yaml — SystemOneRequest.questions.maxProperties
  ollama: Object.freeze({ ...imageLimits, maxMediaBodyBytes: 32 * 1024 * 1024, imageInputRequiresModelCapability: true, maxQuestions: 64, maxBodyBytes: 64 * 1024 }),
  "ollama-cloud": Object.freeze({ ...imageLimits, maxImageBytes: 4 * 1024 * 1024, maxImagePixels: 16_000_000, maxTotalImageBytes: 8 * 1024 * 1024, maxMediaBodyBytes: 13 * 1024 * 1024, imageInputRequiresModelCapability: true, maxQuestions: 64, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  "on-device": Object.freeze({ maxQuestions: 16 }),
  // Neither aggregator documents a fixed maximum. Keep Bridge's resource cap;
  // selected upstream models may reject smaller requests with invalid_request.
  openrouter: Object.freeze({ ...imageLimits, imageInputRequiresModelCapability: true, maxQuestions: DECISION_MAX_QUESTIONS, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  ppq: Object.freeze({ maxQuestions: DECISION_MAX_QUESTIONS, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
});

/** Shared by the approval UI, grant persistence, worker, and direct adapters. */
export function decisionQuestionLimitMessage(label, maxQuestions, count) {
  return Number.isSafeInteger(maxQuestions) && count > maxQuestions
    ? `${label} decisions support at most ${maxQuestions} questions per request.`
    : "";
}

export function assertDecisionQuestionLimit(label, maxQuestions, questions) {
  const message = decisionQuestionLimitMessage(label, maxQuestions, Object.keys(questions || {}).length);
  if (message) throw Object.assign(new Error(message), { name: "InferenceError", code: "invalid_request" });
}

export function assertDecisionBodyLimit(label, maxBodyBytes, body) {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > maxBodyBytes) {
    throw Object.assign(new Error(
      byteLimitMessage(`${label} encoded decision request body`, bytes, maxBodyBytes)
    ), { name: "InferenceError", code: "invalid_request" });
  }
}
