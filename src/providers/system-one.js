/** The documented System One JSON protocol shared by cloud and local adapters. */
import { validateDecisionImages, assertDecisionMediaSupported, DECISION_MEDIA_TRANSPORT_MAX_BYTES } from "../decision-media.js";
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

export function preflightSystemOne({ providerId, label, model, state, questions, attachments }) {
  const validated = validateDecideRequest({
    method: "decide", state, questions,
    ...(attachments !== undefined ? { attachments } : {}),
  });
  if (!validated.ok) fail("invalid_request", validated.message);
  const request = validated.value;
  const limits = DECISION_LIMITS[providerId];
  assertDecisionQuestionLimit(label, limits.maxQuestions, request.questions);
  assertDecisionMediaSupported({ label, decisions: limits }, request.attachments);
  // Aggregators may interpret native media-shaped state objects. Serialize JSON
  // state as text so only the explicit attachment path can activate image input.
  const textState = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
  const wire = { model, state: ["openrouter", "ppq"].includes(providerId) ? textState : request.state, questions: request.questions };
  assertDecisionBodyLimit(label, limits.maxBodyBytes, JSON.stringify(wire));
  if (request.attachments?.length) {
    if (providerId === "openrouter") {
      wire.state = [
        { type: "text", text: typeof request.state === "string" ? request.state : JSON.stringify(request.state) },
        ...request.attachments.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
      ];
    } else wire.images = request.attachments.map((image) => image.data);
  }
  const body = JSON.stringify(wire);
  assertDecisionBodyLimit(label, limits.maxMediaBodyBytes ?? DECISION_MEDIA_TRANSPORT_MAX_BYTES, body);
  return { request, body };
}

export async function requestSystemOne(args) {
  const { url, label, apiKey, signal, mapStatus } = args;
  const { request, body } = preflightSystemOne(args);
  await validateDecisionImages(request.attachments, { signal });
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
    return normalizeDecisionResponse(result, request.questions);
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
