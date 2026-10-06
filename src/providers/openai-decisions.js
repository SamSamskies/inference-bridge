/** OpenAI Decisions beta adapter for the Bridge's experimental decide envelope. */
import {
  DECISION_BODY_MAX_BYTES,
  normalizeDecisionResponse,
  validateDecideRequest,
} from "../decisions.js";
import { readProviderErrorDetail } from "./provider-error.js";

// Independent from chat: the Decisions guide currently lists only this model.
// https://developers.openai.com/api/docs/guides/decisions
export const OPENAI_DECISION_MODELS = Object.freeze(["gpt-6-luna"]);
const DECISIONS_URL = "https://api.openai.com/v1/decisions";

function fail(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  error.code = code;
  throw error;
}

function toOpenAIQuestions(questions) {
  return Object.entries(questions).map(([name, question]) => {
    const { instructions, criteria } = question;
    if (question.type === "noul") {
      return {
        name,
        type: "predicate",
        instructions:
          criteria && Object.keys(criteria).length
            ? `${instructions}\n\nBoolean criteria (true/false descriptions):\n${JSON.stringify(criteria)}`
            : instructions,
      };
    }
    if (question.type === "choice") {
      return {
        name,
        type: "choice",
        instructions,
        choices: Object.entries(criteria).map(([value, description]) => ({
          value,
          ...(description !== null ? { description } : {}),
        })),
      };
    }
    return {
      name,
      type: "score",
      instructions,
      levels: criteria.map((description, index) => ({
        label: String(index),
        description,
      })),
    };
  });
}

/** Validate ordered, named wire answers before converting arrays to maps. */
function fromOpenAIResponse(body, questions) {
  const invalid = () =>
    fail("provider_error", "OpenAI returned malformed decision answers.");
  const entries = Object.entries(questions);
  if (!Array.isArray(body?.answers) || body.answers.length !== entries.length)
    invalid();
  const answers = Object.fromEntries(
    entries.map(([name, question], index) => {
      const answer = body.answers[index];
      if (!answer || answer.name !== name) invalid();
      if (answer.type === "refusal") return [name, { type: "refusal" }];
      if (question.type === "noul") {
        if (answer.type !== "predicate") invalid();
        return [name, { type: "noul", noul: answer.probability }];
      }
      if (answer.type !== question.type || !Array.isArray(answer.probabilities))
        invalid();
      const keys =
        question.type === "choice"
          ? Object.keys(question.criteria)
          : question.criteria.map((_, i) => String(i));
      if (answer.probabilities.length !== keys.length) invalid();
      const seen = new Set();
      const probabilities = Object.fromEntries(
        answer.probabilities.map((item) => {
          if (!item || typeof item !== "object") invalid();
          let key;
          if (question.type === "choice") {
            if (typeof item.value !== "string") invalid();
            key = item.value;
          } else {
            if (
              !Number.isSafeInteger(item.value) ||
              item.label !== String(item.value)
            )
              invalid();
            key = String(item.value);
          }
          if (!keys.includes(key) || seen.has(key)) invalid();
          seen.add(key);
          return [key, item.probability];
        })
      );
      const shared = {
        type: question.type,
        confidence: answer.confidence,
        probabilities,
      };
      return [
        name,
        question.type === "choice"
          ? { ...shared, choice: answer.choice }
          : {
              ...shared,
              score: answer.score,
              legend: Object.fromEntries(
                question.criteria.map((description, i) => [String(i), description])
              ),
            },
      ];
    })
  );
  return normalizeDecisionResponse({ ...body, answers }, questions);
}

export async function decideOpenAI({ apiKey, model, state, questions, signal }) {
  if (signal?.aborted) fail("aborted", "Request aborted");
  if (typeof apiKey !== "string" || !apiKey.trim())
    fail(
      "unavailable",
      "OpenAI API key not configured. Open Inference Bridge Options to add it."
    );
  if (!OPENAI_DECISION_MODELS.includes(model))
    fail(
      "unavailable",
      `Unknown OpenAI Decisions model: ${model}. Choose gpt-6-luna in Options.`
    );
  const validated = validateDecideRequest({ method: "decide", state, questions });
  if (!validated.ok) fail("invalid_request", validated.message);
  const request = validated.value;
  const body = JSON.stringify({
    model,
    input:
      typeof request.state === "string"
        ? request.state
        : JSON.stringify(request.state),
    questions: toOpenAIQuestions(request.questions),
  });
  if (new TextEncoder().encode(body).byteLength > DECISION_BODY_MAX_BYTES)
    fail("invalid_request", "Decision request body exceeds 64 KiB.");
  try {
    const response = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal,
    });
    if (signal?.aborted) fail("aborted", "Request aborted");
    if (!response.ok) {
      const detail = await readProviderErrorDetail(
        response,
        `OpenAI HTTP ${response.status}`
      );
      fail(
        [400, 413, 422].includes(response.status)
          ? "invalid_request"
          : response.status === 404 || response.status >= 500
            ? "unavailable"
            : "provider_error",
        detail
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      fail("provider_error", "OpenAI returned invalid decision JSON.");
    }
    if (signal?.aborted) fail("aborted", "Request aborted");
    return fromOpenAIResponse(result, request.questions);
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError")
      fail("aborted", "Request aborted");
    if (err?.name === "InferenceError") throw err;
    fail(
      "unavailable",
      `Unable to contact OpenAI for decisions: ${err instanceof Error ? err.message : "network error"}`
    );
  }
}
