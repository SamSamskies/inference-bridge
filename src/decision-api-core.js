/** Chrome DecisionModel ↔ IPA typed decisions. Runs in a document context.
 * @see https://github.com/explainers-by-googlers/decisions-api
 */
import { DECISION_LIMITS } from "./providers/decision-limits.js";
import { normalizeDecisionResponse, validateDecideRequest } from "./decisions.js";
import { ON_DEVICE_MODEL_ID, throwInference } from "./prompt-api-core.js";
import { normalizeProviderError } from "./providers/provider-error.js";

// Independent from LanguageModel: do not require chat/vision language support.
export const DECISION_API_OPTIONS = Object.freeze({
  expectedInputs: Object.freeze([Object.freeze({ type: "text" })]),
});
export const DECISION_API_INSTALL_QUESTIONS = Object.freeze({
  ready: Object.freeze({ type: "noul", instructions: "Is the input ready?" }),
});

// Chromium currently accepts at most 16 questions per native schema.
export const ON_DEVICE_DECISION_MAX_QUESTIONS = DECISION_LIMITS["on-device"].maxQuestions;

export function decisionApiSchema(questions) {
  // Reject explicitly rather than dropping questions or changing batch semantics.
  if (Object.keys(questions).length > ON_DEVICE_DECISION_MAX_QUESTIONS) {
    throwInference("invalid_request", `On-device decisions support at most ${ON_DEVICE_DECISION_MAX_QUESTIONS} questions per request.`);
  }
  return {
    ...DECISION_API_OPTIONS,
    questions: Object.entries(questions).map(([id, question]) => {
      const { instructions, criteria } = question;
      if (question.type === "noul") {
        return { id, type: "boolean", prompt: criteria && Object.keys(criteria).length
          ? `${instructions}\n\nBoolean criteria (true/false descriptions):\n${JSON.stringify(criteria)}`
          : instructions };
      }
      return { id, type: question.type, prompt: instructions,
        options: question.type === "choice"
          ? Object.entries(criteria).map(([label, description]) => ({ label,
            ...(description !== null ? { description } : {}) }))
          : criteria.map((description, index) => ({ label: String(index), description })),
      };
    }),
  };
}

export async function probeDecisionModelAvailability(scope = globalThis, questions) {
  if (typeof scope.DecisionModel?.availability !== "function") return "missing";
  const options = questions ? decisionApiSchema(questions) : DECISION_API_OPTIONS;
  try {
    const status = await scope.DecisionModel.availability(options);
    return ["available", "downloadable", "downloading", "unavailable"].includes(status)
      ? status : "unavailable";
  } catch (cause) {
    // Schema/context limits are request errors, not evidence that the API is missing.
    if (questions && ["TypeError", "QuotaExceededError"].includes(cause?.name)) {
      throwInference("invalid_request", cause.message);
    }
    return "unavailable";
  }
}

export function assertDecisionModelAvailable(status) {
  if (status === "available") return;
  throwInference("unavailable", ["downloadable", "downloading"].includes(status)
    ? "Install the on-device decision model in Options → Decisions before using this provider."
    : "Chrome Decisions API (DecisionModel) is unavailable. Enable the Decisions API in Chrome and relaunch, then check Options → Decisions.");
}

/** Validate all native fields before converting to the IPA envelope. */
export function normalizeNativeDecisions(result, questions) {
  const invalid = () => throwInference("provider_error", "Chrome returned malformed decision answers.");
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).length !== Object.keys(questions).length) invalid();
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = Object.hasOwn(result, id) ? result[id] : null;
    const keys = question.type === "noul" ? ["true", "false"]
      : question.type === "choice" ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    const probabilities = answer?.probabilities;
    if (!answer || answer.id !== id || !keys.includes(answer.label) ||
        typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 || answer.confidence > 1 ||
        !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) ||
        Object.keys(probabilities).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(probabilities, key) ||
          typeof probabilities[key] !== "number" || !Number.isFinite(probabilities[key]) ||
          probabilities[key] < 0 || probabilities[key] > 1)) invalid();
    const total = keys.reduce((sum, key) => sum + probabilities[key], 0);
    if (Math.abs(total - 1) > 0.02 + 1e-12 ||
        probabilities[answer.label] !== Math.max(...keys.map((key) => probabilities[key]))) invalid();
    if (question.type === "noul") return [id, { type: "noul", noul: probabilities.true }];
    const shared = { type: question.type, confidence: answer.confidence, probabilities };
    return [id, question.type === "choice" ? { ...shared, choice: answer.label }
      : { ...shared, score: answer.expectedScore,
        legend: Object.fromEntries(question.criteria.map((description, i) => [String(i), description])) }];
  }));
  return normalizeDecisionResponse({ model: ON_DEVICE_MODEL_ID, answers }, questions);
}

function checkAbort(signal) {
  if (signal?.aborted) throwInference("aborted", "Request aborted");
}

function nativeError(cause, signal) {
  if (cause?.name === "AbortError" || signal?.aborted) throwInference("aborted", "Request aborted");
  if (["TypeError", "QuotaExceededError"].includes(cause?.name)) throwInference("invalid_request", cause.message);
  if (["NotSupportedError", "NotAllowedError", "InvalidStateError"].includes(cause?.name)) {
    throwInference("unavailable", `On-device decisions: ${cause.message}`);
  }
  throw normalizeProviderError(cause, { signal });
}

export async function decideWithDecisionModel({ DecisionModel, state, questions, signal }) {
  let session;
  try {
    checkAbort(signal);
    const validated = validateDecideRequest({ method: "decide", state, questions });
    if (!validated.ok) throwInference("invalid_request", validated.message);
    ({ state, questions } = validated.value);
    const schema = decisionApiSchema(questions);
    assertDecisionModelAvailable(await probeDecisionModelAvailability({ DecisionModel }, questions));
    checkAbort(signal);
    session = await DecisionModel.create({ ...schema, signal });
    checkAbort(signal);
    const result = await session.decide(typeof state === "string" ? state : JSON.stringify(state), { signal });
    checkAbort(signal);
    return normalizeNativeDecisions(result, questions);
  } catch (cause) {
    nativeError(cause, signal);
  } finally {
    try { session?.destroy(); } catch { /* Preserve the inference result/error if cleanup fails. */ }
  }
}

/** Call directly from an Options click so Chrome receives user activation. */
export async function installDecisionModel({ DecisionModel, signal, onProgress } = {}) {
  let session;
  try {
    checkAbort(signal);
    if (typeof DecisionModel?.create !== "function") assertDecisionModelAvailable("missing");
    session = await DecisionModel.create({ ...decisionApiSchema(DECISION_API_INSTALL_QUESTIONS), signal,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded));
      } });
    checkAbort(signal);
  } catch (cause) {
    nativeError(cause, signal);
  } finally {
    try { session?.destroy(); } catch { /* The browser may already have destroyed an aborted session. */ }
  }
}
