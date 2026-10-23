/**
 * Verified optional Interactions capabilities, separate from live discovery.
 * Unknown models can chat, but never inherit tool/media/thinking privileges
 * from a name prefix. Update exact IDs against Google's model cards.
 * https://ai.google.dev/gemini-api/docs/google-search#supported_models
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 */
const PROFILES = new Map([
  [
    "gemini-4-argon",
    {
      image: true,
      functions: true,
      search: true,
      mixed: true,
      thinking: ["low", "medium", "high"],
    },
  ],
  [
    "gemini-3.8-flash",
    {
      image: true,
      functions: true,
      search: true,
      mixed: true,
      thinking: ["low", "medium", "high"],
    },
  ],
  [
    "gemini-3.6-flash",
    {
      image: true,
      functions: true,
      search: true,
      mixed: true,
      thinking: ["minimal", "low", "medium", "high"],
    },
  ],
  [
    "gemini-3.5-flash-lite",
    {
      image: true,
      functions: true,
      search: true,
      mixed: true,
      thinking: ["minimal", "low", "medium", "high"],
    },
  ],
  [
    "gemini-3.1-pro-preview",
    { image: true, functions: true, search: true, mixed: true },
  ],
  [
    "gemini-3-flash-preview",
    { image: true, functions: true, search: true, mixed: true },
  ],
]);

export function geminiCapabilities(model) {
  return PROFILES.get(model) || {};
}

/** IPA preferences are best effort; `none` minimizes mandatory thinking. */
export function mapGeminiReasoningEffort(model, effort) {
  if (!effort || effort === "auto") return undefined;
  const levels = geminiCapabilities(model).thinking;
  if (effort === "none") return levels?.[0];
  return levels?.includes(effort) ? effort : undefined;
}

/** Empty string means this request is supported by the verified profile. */
export function geminiRequestWarning(model, request = {}) {
  const caps = geminiCapabilities(model);
  const activeTools = request.toolChoice === "none" ? [] : request.tools || [];
  const search = activeTools.some((tool) => tool.type === "web_search");
  const functions = activeTools.some((tool) => tool.type === "function");
  const choose = "Choose a model with verified support in Inference Bridge.";
  if (request.imageOutput)
    return "Google Gemini image generation is not supported by this adapter.";
  if (request.imageInput && !caps.image)
    return `Image input is not verified for ${model}. ${choose}`;
  if (search && !caps.search)
    return `Google Search grounding is not verified for ${model}. ${choose}`;
  if (functions && !caps.functions)
    return `Function tools are not verified for ${model}. ${choose}`;
  if (search && functions && !caps.mixed)
    return `${model} cannot combine Google Search and function tools. Use separate requests or a supported Gemini 3 model.`;
  return "";
}
