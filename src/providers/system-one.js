/** The documented System One JSON protocol shared by cloud and local adapters. */
import { DECISION_LIMITS, assertDecisionQuestionLimit, assertDecisionBodyLimit } from "./decision-limits.js";
import {
  normalizeDecisionResponse,
  validateDecideRequest,
} from "../decisions.js";
import { readProviderErrorDetail } from "./provider-error.js";

function fail(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  error.code = code;
  throw error;
}

export async function requestSystemOne({
  url,
  label,
  providerId,
  apiKey,
  model,
  state,
  questions,
  signal,
  mapStatus,
}) {
  const validated = validateDecideRequest({
    method: "decide",
    state,
    questions,
  });
  if (!validated.ok) fail("invalid_request", validated.message);
  const limits = DECISION_LIMITS[providerId];
  assertDecisionQuestionLimit(label, limits.maxQuestions, validated.value.questions);
  const body = JSON.stringify({
    model,
    state: validated.value.state,
    questions: validated.value.questions,
  });
  assertDecisionBodyLimit(label, limits.maxBodyBytes, body);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal,
    });
    if (signal?.aborted) fail("aborted", "Request aborted");
    if (!response.ok) {
      const detail = await readProviderErrorDetail(
        response,
        `${label} HTTP ${response.status}`
      );
      if (mapStatus) {
        const mapped = mapStatus(response.status, detail);
        fail(mapped.code, mapped.message);
      }
      const obsoleteOllamaFormat =
        label === "Ollama" && response.status === 400 &&
        detail.includes("was downloaded in a format that is no longer supported");
      const code =
        obsoleteOllamaFormat || response.status === 404 || response.status >= 500
          ? "unavailable"
          : [400, 413, 422].includes(response.status)
            ? "invalid_request"
            : "provider_error";
      fail(
        code,
        label === "Ollama" && response.status === 404
          ? `Ollama System One is unavailable. Upgrade to Ollama 0.35+ and install a local decision model (Clef requires 0.35.1+). ${detail}`
          : detail
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      fail("provider_error", `${label} returned invalid decision JSON.`);
    }
    if (signal?.aborted) fail("aborted", "Request aborted");
    return normalizeDecisionResponse(result, validated.value.questions);
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError")
      fail("aborted", "Request aborted");
    if (err?.name === "InferenceError") throw err;
    fail(
      "unavailable",
      `Unable to contact ${label} for decisions: ${err instanceof Error ? err.message : "network error"}`
    );
  }
}
