/** @param {unknown} model */
export function isOpenAIGpt62Model(model) {
  return typeof model === "string" && /^gpt-6\.2-(?:astra|sol)(?:$|-)/i.test(model.trim());
}

/** Existing Responses image-generation model policy, owned by the adapter. */
export function openaiModelSupportsImageOutput(model) {
  if (typeof model !== "string") return false;
  const id = model.trim().toLowerCase();
  if (!id) return false;
  return (
    id.startsWith("gpt-4o") ||
    id.startsWith("gpt-4.1") ||
    id.startsWith("gpt-5") ||
    id.startsWith("gpt-6") ||
    id.startsWith("o3")
  );
}
