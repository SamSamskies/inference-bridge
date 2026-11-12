/** Service-worker RPC client for the native DecisionModel document host. */
import { sendPromptApiOffscreenMessage } from "./prompt-api-offscreen.js";
import { ON_DEVICE_MODEL_ID, throwInference } from "./prompt-api-core.js";
import { assertDecisionModelAvailable, decisionApiSchema } from "./decision-api-core.js";

export async function getOnDeviceDecisionAvailability({ questions } = {}) {
  if (questions) decisionApiSchema(questions);
  try {
    const response = await sendPromptApiOffscreenMessage({ type: "decision-api-availability", questions });
    if (response?.code) throwInference(response.code, response.error);
    return response?.ok ? response.availability : "unavailable";
  } catch (cause) {
    if (cause?.name === "InferenceError") throw cause;
    return "unavailable";
  }
}

export async function listOnDeviceDecisionModels({ signal } = {}) {
  const status = await getOnDeviceDecisionAvailability();
  if (signal?.aborted) throwInference("aborted", "Request aborted");
  return ["available", "downloadable", "downloading"].includes(status)
    ? [{ id: ON_DEVICE_MODEL_ID, label: "Browser-chosen on-device decision model", outputModalities: ["decisions"] }]
    : [];
}

export async function preflightOnDeviceDecide({ model, questions, attachments, signal }) {
  if (attachments?.length) throwInference("unavailable", "On-device decisions do not support native image attachments.");
  if (signal?.aborted) throwInference("aborted", "Request aborted");
  if (model !== ON_DEVICE_MODEL_ID) throwInference("unavailable", "Choose the browser-chosen on-device decision model.");
  const status = await getOnDeviceDecisionAvailability({ questions });
  if (signal?.aborted) throwInference("aborted", "Request aborted");
  assertDecisionModelAvailable(status);
}

export async function decideOnDevice({ model, state, questions, attachments, signal }) {
  await preflightOnDeviceDecide({ model, questions, attachments, signal });
  const requestId = `decision_${crypto.randomUUID()}`;
  const abort = () => {
    void sendPromptApiOffscreenMessage({ type: "prompt-api-abort-stream", requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throwInference("aborted", "Request aborted");
    const response = await sendPromptApiOffscreenMessage({ type: "decision-api-decide", requestId, state, questions });
    if (signal?.aborted) throwInference("aborted", "Request aborted");
    if (!response?.ok) throwInference(response?.code || "provider_error", response?.error || "On-device decisions failed.");
    // The offscreen host already normalized this via normalizeNativeDecisions.
    return response.result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
