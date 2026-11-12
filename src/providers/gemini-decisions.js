/** Native Gemini Decisions API ↔ the bounded IPA JSON-state envelope.
 * https://aistudio.google.com/docs/decisions-api
 */
import { validateDecisionImages } from "../decision-media.js";
import { DECISION_LIMITS, assertDecisionQuestionLimit, assertDecisionBodyLimit } from "./decision-limits.js";
import {
  normalizeDecisionResponse,
  validateDecideRequest,
} from "../decisions.js";
import { checkGeminiAbort, geminiError, geminiJson } from "./gemini-api.js";

export const GEMINI_DECISION_MODEL = "gemini-decision-1";
export const geminiDecisions = {
  ...DECISION_LIMITS.gemini,
  defaultModel: GEMINI_DECISION_MODEL,
  models: [{ id: GEMINI_DECISION_MODEL, label: "Gemini Decision 1" }],
};

function prepare({ model, state, questions, attachments, signal }) {
  checkGeminiAbort(signal);
  if (model !== GEMINI_DECISION_MODEL)
    throw geminiError(
      "unavailable",
      "Choose Gemini Decision 1 in Options → Decisions."
    );
  const validated = validateDecideRequest({ method: "decide", state, questions, ...(attachments !== undefined ? { attachments } : {}) });
  if (!validated.ok) throw geminiError("invalid_request", validated.message);
  const request = validated.value;
  assertDecisionQuestionLimit("Google Gemini", geminiDecisions.maxQuestions, request.questions);
  // Google restricts question/option keys. Aliases preserve arbitrary IPA keys,
  // including Unicode and prototype-like names, without interpreting state.
  const entries = Object.entries(request.questions);
  const wireQuestions = Object.fromEntries(
    entries.map(([id, question], index) => {
      let criteria = question.criteria;
      if (question.type === "noul" && criteria) {
        criteria = Object.fromEntries(
          Object.entries(criteria).map(([key, value]) => [
            key === "true" ? "true_description" : "false_description",
            value,
          ])
        );
      } else if (question.type === "choice") {
        criteria = Object.fromEntries(
          Object.entries(criteria).map(([key, value], i) => [
            `option_${i}`,
            value === null || value === "" ? key : `${key}: ${value}`,
          ])
        );
      } else if (
        question.type === "score" &&
        criteria.some((value) => !value.trim())
      ) {
        throw geminiError(
          "invalid_request",
          `Gemini score question ${id} requires non-empty level descriptions.`
        );
      }
      return [
        `q${index}`,
        { ...question, ...(criteria !== undefined ? { criteria } : {}) },
      ];
    })
  );
  const wire = {
    model,
    input: typeof request.state === "string"
      ? request.state
      : JSON.stringify(request.state),
    questions: wireQuestions,
  };
  assertDecisionBodyLimit("Google Gemini", geminiDecisions.maxBodyBytes, JSON.stringify(wire));
  if (request.attachments?.length) wire.input = [
    { type: "text", text: wire.input },
    ...request.attachments.map((image) => ({ type: "image", data: image.data, mime_type: image.mediaType })),
  ];
  const body = JSON.stringify(wire);
  assertDecisionBodyLimit("Google Gemini", geminiDecisions.maxMediaBodyBytes, body);
  return { body, entries, questions: request.questions, attachments: request.attachments };
}

export function preflightGeminiDecide(args) {
  prepare(args);
}

export async function decideGemini(args) {
  const request = prepare(args);
  await validateDecisionImages(request.attachments, { signal: args.signal });
  let result;
  try {
    result = await geminiJson("/v1beta/decisions", {
      apiKey: args.apiKey,
      signal: args.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: request.body,
    });
  } catch (error) {
    checkGeminiAbort(args.signal);
    if ([400, 413, 422].includes(error.status)) error.code = "invalid_request";
    throw error;
  }
  checkGeminiAbort(args.signal);
  const invalid = () => {
    throw geminiError(
      "provider_error",
      "Google Gemini returned malformed decision answers."
    );
  };
  const record = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  if (
    !record(result?.answers) ||
    Object.keys(result.answers).length !== request.entries.length
  ) invalid();
  const answers = Object.fromEntries(
    request.entries.map(([id, question], index) => {
      const key = `q${index}`;
      const answer = own(result.answers, key) ? result.answers[key] : null;
      if (!record(answer) || answer.type !== question.type) invalid();
      if (question.type === "noul") {
        if (
          typeof answer.confidence !== "number" ||
          !Number.isFinite(answer.confidence) ||
          answer.confidence < 0 || answer.confidence > 1
        ) invalid();
        const { confidence: _confidence, ...rest } = answer;
        return [id, rest];
      }
      if (question.type !== "choice") return [id, answer];
      const keys = Object.keys(question.criteria);
      if (
        !record(answer.probabilities) ||
        Object.keys(answer.probabilities).length !== keys.length
      ) invalid();
      const probabilities = Object.fromEntries(keys.map((key, i) => {
        if (!own(answer.probabilities, `option_${i}`)) invalid();
        return [key, answer.probabilities[`option_${i}`]];
      }));
      const selected = keys.findIndex((_, i) => answer.choice === `option_${i}`);
      if (selected < 0) invalid();
      return [id, { ...answer, choice: keys[selected], probabilities }];
    })
  );
  // Google returns no model identity; report the model selected by the user.
  return normalizeDecisionResponse({
    model: args.model,
    answers,
    usage: {
      input_tokens: result.usage?.total_input_tokens,
      output_tokens: result.usage?.total_output_tokens,
    },
  }, request.questions);
}
