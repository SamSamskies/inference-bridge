import { UNKNOWN_MODEL_CAPABILITIES } from "../src/providers/model-capabilities.js";

/** Clear stale capabilities immediately and ignore replies for older routes. */
export function createModelCapabilityCheck(sendMessage, onChange) {
  let checkId = 0;
  return async ({ providerId, model, enabled }) => {
    const id = ++checkId;
    onChange({ ...UNKNOWN_MODEL_CAPABILITIES });
    if (!enabled || !model) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await sendMessage({ type: "model-capabilities", providerId, model });
      } catch { /* A missing worker reply gets one retry. */ }
      if (id !== checkId) return;
      if (response?.ok === true) {
        onChange(response.capabilities || { ...UNKNOWN_MODEL_CAPABILITIES });
        return;
      }
    }
  };
}
