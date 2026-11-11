/** Adapter-owned limits; these are Bridge/provider limits, not IPA maxima. */
import { DECISION_BODY_MAX_BYTES, DECISION_MAX_QUESTIONS } from "../decisions.js";

export const DECISION_LIMITS = Object.freeze({
  // https://developers.openai.com/api/docs/guides/decisions#ask-multiple-questions
  openai: Object.freeze({ maxQuestions: 400, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  // https://aistudio.google.com/docs/decisions-api#limits
  gemini: Object.freeze({ maxQuestions: 1000, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  // https://docs.ollama.com/openapi.yaml — SystemOneRequest.questions.maxProperties
  ollama: Object.freeze({ maxQuestions: 64, maxBodyBytes: 64 * 1024 }),
  "ollama-cloud": Object.freeze({ maxQuestions: 64, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
  "on-device": Object.freeze({ maxQuestions: 16 }),
  // Neither aggregator documents a fixed maximum. Keep Bridge's resource cap;
  // selected upstream models may reject smaller requests with invalid_request.
  openrouter: Object.freeze({ maxQuestions: DECISION_MAX_QUESTIONS, maxBodyBytes: DECISION_BODY_MAX_BYTES }),
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
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    throw Object.assign(new Error(
      `${label} decision request body exceeds ${maxBodyBytes / 1024} KiB (${maxBodyBytes} UTF-8 bytes), including the model and translated questions.`
    ), { name: "InferenceError", code: "invalid_request" });
  }
}
