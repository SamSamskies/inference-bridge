/** Bridge-experimental decision envelope shared by provider adapters. */
export const DECISION_PAYLOAD_MAX_BYTES = 63 * 1024;
export const DECISION_BODY_MAX_BYTES = 64 * 1024;
export const DECISION_MAX_QUESTIONS = 64;
export const DECISION_MAX_CHOICES = 26;
// The common envelope: TypeSafe scores currently accept at most ten levels.
export const DECISION_MAX_SCORE_LEVELS = 10;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return (
    proto === null ||
    (Object.getPrototypeOf(proto) === null &&
      proto.constructor?.name === "Object")
  );
};
const probability = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

function assertJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 64)
    throw new Error(
      "state and questions must not exceed 64 levels of nesting."
    );
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !record(value)) {
    throw new Error(
      "state and questions must contain only JSON values (no binary, undefined, or non-finite numbers)."
    );
  }
  if (ancestors.has(value))
    throw new Error("state and questions must not contain cycles.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1)
      assertJson(value[i], ancestors, depth + 1);
  } else {
    for (const entry of Object.values(value))
      assertJson(entry, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** Closed v1 schema. Returns a JSON snapshot so callers cannot change the payload. */
export function validateDecideRequest(req) {
  const invalid = (message) => ({ ok: false, message });
  const unknown = Object.keys(req).find(
    (key) => !["method", "state", "questions", "signal"].includes(key)
  );
  if (unknown)
    return invalid(`Field "${unknown}" is not valid for method "decide".`);
  if (
    typeof req.state !== "string" &&
    !Array.isArray(req.state) &&
    !record(req.state)
  ) {
    return invalid("state must be a string, JSON object, or array.");
  }
  if (typeof req.state === "string" && !req.state.trim())
    return invalid("state must not be an empty string.");
  if (!record(req.questions)) return invalid("questions must be an object.");
  const entries = Object.entries(req.questions);
  if (entries.length < 1 || entries.length > DECISION_MAX_QUESTIONS)
    return invalid("questions must contain 1–64 questions.");
  try {
    assertJson({ state: req.state, questions: req.questions });
    for (const [id, question] of entries) {
      if (!id.trim()) return invalid("Question ids must not be empty.");
      if (!record(question))
        return invalid(`questions.${id} must be an object.`);
      const unknownQuestion = Object.keys(question).find(
        (key) => !["type", "instructions", "criteria"].includes(key)
      );
      if (unknownQuestion)
        return invalid(
          `Field "questions.${id}.${unknownQuestion}" is not supported.`
        );
      if (
        typeof question.instructions !== "string" ||
        !question.instructions.trim()
      ) {
        return invalid(
          `questions.${id}.instructions must be a non-empty string.`
        );
      }
      const criteria = question.criteria;
      if (question.type === "noul") {
        if (
          own(question, "criteria") &&
          (!record(criteria) ||
            Object.entries(criteria).some(
              ([key, value]) =>
                !["true", "false"].includes(key) || typeof value !== "string"
            ))
        )
          return invalid(
            `questions.${id}.criteria must contain only true/false string descriptions.`
          );
      } else if (question.type === "choice") {
        if (
          !record(criteria) ||
          Object.keys(criteria).length < 2 ||
          Object.keys(criteria).length > DECISION_MAX_CHOICES ||
          Object.entries(criteria).some(
            ([key, value]) =>
              !key.trim() || (typeof value !== "string" && value !== null)
          )
        )
          return invalid(
            `questions.${id}.criteria must contain 2–26 named choices with string or null descriptions.`
          );
      } else if (question.type === "score") {
        if (
          !Array.isArray(criteria) ||
          criteria.length < 2 ||
          criteria.length > DECISION_MAX_SCORE_LEVELS ||
          criteria.some((value) => typeof value !== "string")
        ) {
          return invalid(
            `questions.${id}.criteria must contain 2–10 score descriptions.`
          );
        }
      } else
        return invalid(
          `questions.${id}.type must be "noul", "choice", or "score".`
        );
    }
    const json = JSON.stringify({ state: req.state, questions: req.questions });
    if (new TextEncoder().encode(json).byteLength > DECISION_PAYLOAD_MAX_BYTES)
      return invalid(
        "Serialized state and questions exceed the 63 KiB decision limit."
      );
    return { ok: true, value: { method: "decide", ...JSON.parse(json) } };
  } catch (err) {
    return invalid(
      err instanceof Error ? err.message : "state and questions must be JSON."
    );
  }
}

/** Reject malformed upstream answers rather than returning a chat-shaped substitute. */
export function normalizeDecisionResponse(body, questions) {
  const invalid = () => {
    const error = new Error("Provider returned malformed decision answers.");
    error.name = "InferenceError";
    error.code = "provider_error";
    throw error;
  };
  if (
    !record(body) ||
    typeof body.model !== "string" ||
    !body.model.trim() ||
    !record(body.answers)
  )
    invalid();
  if (Object.keys(body.answers).length !== Object.keys(questions).length)
    invalid();
  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const answer = own(body.answers, id) ? body.answers[id] : null;
      if (!record(answer)) invalid();
      if (answer.type === "refusal") return [id, { type: "refusal" }];
      if (answer.type !== question.type) invalid();
      if (question.type === "noul") {
        if (!probability(answer.noul)) invalid();
        return [id, { type: "noul", noul: answer.noul }];
      }
      if (!probability(answer.confidence) || !record(answer.probabilities))
        invalid();
      const keys =
        question.type === "choice"
          ? Object.keys(question.criteria)
          : question.criteria.map((_, index) => String(index));
      if (
        Object.keys(answer.probabilities).length !== keys.length ||
        keys.some(
          (key) =>
            !own(answer.probabilities, key) ||
            !probability(answer.probabilities[key])
        )
      )
        invalid();
      const total = keys.reduce(
        (sum, key) => sum + answer.probabilities[key],
        0
      );
      if (Math.abs(total - 1) > 0.02) invalid();
      const shared = {
        type: question.type,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, answer.probabilities[key]])
        ),
      };
      if (question.type === "choice") {
        if (typeof answer.choice !== "string" || !keys.includes(answer.choice))
          invalid();
        return [id, { ...shared, choice: answer.choice }];
      }
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > keys.length - 1 ||
        !record(answer.legend) ||
        Object.keys(answer.legend).length !== keys.length ||
        keys.some(
          (key) =>
            !own(answer.legend, key) || typeof answer.legend[key] !== "string"
        )
      )
        invalid();
      return [
        id,
        {
          ...shared,
          score: answer.score,
          legend: Object.fromEntries(
            keys.map((key) => [key, answer.legend[key]])
          ),
        },
      ];
    })
  );
  const usage = {};
  for (const [wire, bridge] of [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
  ]) {
    if (body.usage?.[wire] !== undefined) {
      if (!Number.isSafeInteger(body.usage[wire]) || body.usage[wire] < 0)
        invalid();
      usage[bridge] = body.usage[wire];
    }
  }
  return {
    model: body.model,
    answers,
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

export function decisionApprovalPreview(request) {
  const text =
    typeof request.state === "string"
      ? request.state
      : JSON.stringify(request.state);
  return {
    stateSummary: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
    questionSummaries: Object.entries(request.questions).map(
      ([id, question]) => ({ id, type: question.type })
    ),
  };
}
