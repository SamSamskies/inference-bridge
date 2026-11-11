/** PPQ's non-streaming System One API and independent public model catalog. */
import { DECISION_LIMITS, assertDecisionQuestionLimit } from "./decision-limits.js";
import { validateDecideRequest } from "../decisions.js";
import { normalizeProviderError } from "./provider-error.js";
import { requestSystemOne } from "./system-one.js";

export const PPQ_DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";
export const PPQ_DECISIONS_URL = "https://api.ppq.ai/v1/decisions";
const CATALOG_MAX_AGE_MS = 60_000;
let decisionCatalog = null;
let listedAt = 0;
const knownDecisionModels = new Set([PPQ_DEFAULT_DECISION_MODEL, "~typesafe/jev-latest"]);

function fail(code, message) {
  throw Object.assign(new Error(message), { name: "InferenceError", code });
}
function checkAbort(signal) {
  if (signal?.aborted) fail("aborted", "Request aborted");
}

/** Models discovered here must never be treated as chat models. */
export function isPPQDecisionModel(model) {
  return knownDecisionModels.has(model) || /^~?typesafe\/jev(?:-|$)/i.test(model || "");
}

/** Discovery is public. Never read or send the provider's stored credential. */
export async function listPPQDecisionModels({ signal } = {}) {
  checkAbort(signal);
  decisionCatalog = null;
  listedAt = 0;
  let response;
  try {
    response = await fetch(`${PPQ_DECISIONS_URL}/models`, { signal });
  } catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("unavailable", "Could not load PayPerQ decision models. Retry discovery in Options.");
  }
  checkAbort(signal);
  if (!response.ok) {
    fail(response.status >= 500 ? "unavailable" : "provider_error",
      `PayPerQ HTTP ${response.status} listing decision models. Retry discovery in Options.`);
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("provider_error", "PayPerQ returned invalid JSON listing decision models.");
  }
  checkAbort(signal);
  if (!Array.isArray(body?.data)) fail("provider_error", "PayPerQ returned an invalid decision model catalog.");
  const models = new Map();
  for (const entry of body.data) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || (entry.type && entry.type !== "decision") || id.endsWith(":batch")) continue;
    knownDecisionModels.add(id);
    models.set(id, {
      id,
      ...(typeof entry.name === "string" && entry.name ? { label: entry.name } : {}),
      outputModalities: ["decisions"],
    });
  }
  decisionCatalog = [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  listedAt = Date.now();
  return decisionCatalog.map((entry) => ({ ...entry, outputModalities: [...entry.outputModalities] }));
}

function mapDecisionStatus(status, detail) {
  const hint = status === 401 || status === 403
    ? "Check your PayPerQ API key in Options."
    : status === 402
      ? "Check your PayPerQ balance and API-key spending limit."
      : status === 404
        ? "Refresh the PayPerQ Decisions catalog and choose an available model."
        : status === 429
          ? "PayPerQ rate limit reached. Retry later."
          : status >= 500
            ? "PayPerQ decisions are temporarily unavailable. Retry later."
            : "Check the decision state and question definitions, or try another PayPerQ decision model.";
  return {
    code: status === 404 || status >= 500 ? "unavailable"
      : [400, 413, 422].includes(status) ? "invalid_request" : "provider_error",
    message: `${detail.slice(0, 800)} ${hint}`,
  };
}

/** Uses the same PPQ key as chat, with explicit call-local configuration. */
export async function decidePPQ(args) {
  try {
    checkAbort(args.signal);
    if (!args.apiKey?.trim()) fail("unavailable", "PayPerQ API key not configured. Add it in Options.");
    const validated = validateDecideRequest({ method: "decide", state: args.state, questions: args.questions });
    if (!validated.ok) fail("invalid_request", validated.message);
    assertDecisionQuestionLimit("PayPerQ", DECISION_LIMITS.ppq.maxQuestions, validated.value.questions);
    if (!decisionCatalog || Date.now() - listedAt >= CATALOG_MAX_AGE_MS) {
      await listPPQDecisionModels({ signal: args.signal });
    }
    checkAbort(args.signal);
    if (!decisionCatalog?.some((entry) => entry.id === args.model)) {
      fail("unavailable", "Choose a model from the current PayPerQ Decisions catalog in Options or the approval dialog.");
    }
    const result = await requestSystemOne({
      ...args,
      providerId: "ppq",
      state: validated.value.state,
      questions: validated.value.questions,
      url: PPQ_DECISIONS_URL,
      label: "PayPerQ",
      mapStatus: mapDecisionStatus,
    });
    checkAbort(args.signal);
    return result;
  } catch (cause) {
    throw normalizeProviderError(cause, args);
  }
}
