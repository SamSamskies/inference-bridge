/** Model-scoped capabilities. null means unverified, never provider-level proof. */
export const UNKNOWN_MODEL_CAPABILITIES = Object.freeze({
  imageInput: null,
  imageOutput: null,
});

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Request aborted");
  error.name = "InferenceError";
  error.code = "aborted";
  throw error;
}

/**
 * Discovery failure is unknown and must not grant catalog-gated capabilities.
 * Credentials (including explicit undefined), model and signal belong to this
 * call; the registry never substitutes saved settings or another operation.
 * @param {import("./types.js").Provider | null | undefined} provider
 * @param {{ model: string, apiKey?: string, signal?: AbortSignal }} args
 * @returns {Promise<import("./types.js").ModelCapabilities>}
 */
export async function resolveModelCapabilities(provider, args) {
  checkAbort(args.signal);
  if (!args.model || typeof provider?.getModelCapabilities !== "function") {
    return { ...UNKNOWN_MODEL_CAPABILITIES };
  }
  try {
    const result = await provider.getModelCapabilities(args);
    checkAbort(args.signal);
    const capability = (value) => typeof value === "boolean" ? value : null;
    return {
      imageInput: capability(result?.imageInput),
      imageOutput: capability(result?.imageOutput),
      ...(result?.imageInput === null && result.imageInputPassthrough === true
        ? { imageInputPassthrough: true } : {}),
      ...(typeof result?.imageInputNote === "string"
        ? { imageInputNote: result.imageInputNote } : {}),
    };
  } catch {
    checkAbort(args.signal);
    return { ...UNKNOWN_MODEL_CAPABILITIES };
  }
}
