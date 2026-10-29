import { ollamaThinkingGuidance, parseOllamaThinking } from "../src/providers/ollama-thinking.js";

/** A route change immediately clears guidance and invalidates older replies. */
export function createThinkingGuidance(hint, sendMessage) {
  let checkId = 0;
  return async ({ method, providerId, model, ready }) => {
    const id = ++checkId;
    hint.textContent = "";
    hint.hidden = method !== "chat" || providerId !== "ollama" || !ready || !model;
    if (hint.hidden) return;
    hint.textContent = "Checking this model's thinking controls…";
    let thinking;
    try {
      const response = await sendMessage({ type: "ollama-thinking", model });
      if (response?.ok) thinking = parseOllamaThinking({ thinking: response.thinking });
    } catch {
      // Missing metadata is advisory and must never prevent permission approval.
    }
    if (id !== checkId) return;
    hint.textContent = ollamaThinkingGuidance(thinking);
  };
}
