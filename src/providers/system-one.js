/** The documented System One JSON protocol shared by OpenRouter and Ollama. */
import {
  DECISION_BODY_MAX_BYTES,
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
  apiKey,
  model,
  state,
  questions,
  signal,
}) {
  const validated = validateDecideRequest({
    method: "decide",
    state,
    questions,
  });
  if (!validated.ok) fail("invalid_request", validated.message);
  const body = JSON.stringify({
    model,
    state: validated.value.state,
    questions: validated.value.questions,
  });
  if (new TextEncoder().encode(body).byteLength > DECISION_BODY_MAX_BYTES)
    fail("invalid_request", "Decision request body exceeds 64 KiB.");
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
      const code = [400, 413, 422].includes(response.status)
        ? "invalid_request"
        : response.status === 404 || response.status >= 500
          ? "unavailable"
          : "provider_error";
      fail(
        code,
        label === "Ollama" && response.status === 404
          ? `Ollama System One is unavailable. Upgrade to Ollama 0.35+ and install a local GGUF decision model (Clef requires 0.35.1+). ${detail}`
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
