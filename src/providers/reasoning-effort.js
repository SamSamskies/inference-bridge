/**
 * Map IPA `options.reasoningEffort` onto provider request fields.
 * Best-effort: omit when auto/absent; adapters must not fail solely because a
 * model cannot honor the preference. OpenAI-compatible APIs are model-dependent
 * (`none` vs `minimal`); known OpenAI model ids are mapped on the first
 * request. A 400 listing supported values is retried once with the next
 * lowest effort, or with the field omitted if the list cannot be parsed.
 */

/** @typedef {"auto" | "none" | "low" | "medium" | "high"} ReasoningEffort */

/** Lowest-first order for OpenAI-compatible `reasoning_effort` / `reasoning.effort`. */
const OPENAI_COMPAT_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Lowest OpenAI-compatible effort for IPA `"none"` on a known model id.
 * OpenAI: models before gpt-5.1 do not support `"none"` (use `"minimal"`);
 * gpt-5.1+ does. gpt-4.x is not a reasoning family — omit the field.
 * Unknown slugs return undefined so the caller can pass `"none"` through.
 *
 * @param {string | undefined} model
 * @returns {"none" | "minimal" | undefined}
 */
export function mapOpenAINoneReasoningEffort(model) {
  if (typeof model !== "string" || !model) return undefined;
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (/^gpt-4/i.test(id)) return undefined;
  const match = /^gpt-5(?:\.(\d+))?/i.exec(id);
  if (!match) return undefined;
  const minor = match[1] == null ? 0 : Number(match[1]);
  return minor >= 1 ? "none" : "minimal";
}

/**
 * OpenAI Chat Completions / OpenRouter / OpenAI-compat / Responses: `reasoning_effort`
 * (Responses uses `reasoning.effort`). IPA `"none"` is mapped from the model
 * id when known; otherwise passed through. See
 * `nextOpenAICompatReasoningEffortAfterError` for a 400 retry.
 * @param {ReasoningEffort | undefined} effort
 * @param {string | undefined} [model]
 * @returns {"none" | "minimal" | "low" | "medium" | "high" | undefined}
 */
export function mapReasoningEffortForOpenAICompat(effort, model) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") {
    const mapped = mapOpenAINoneReasoningEffort(model);
    if (mapped !== undefined) return mapped;
    if (typeof model === "string" && /^gpt-4/i.test(model.replace(/^.*\//, ""))) {
      return undefined;
    }
    return "none";
  }
  return effort;
}

/** Request fields whose 400s use the same "Unsupported value … not supported" phrasing. */
const UNRELATED_UNSUPPORTED_VALUE_FIELDS =
  /\b(tool_choice|tools|temperature|max_tokens|max_completion_tokens|response_format)\b/i;

/**
 * True when the provider rejected a reasoning-effort value (not auth/rate-limit).
 * OpenAI's effort 400s often omit the field name and only quote the value, so
 * `"unsupported value"` is a signal — but only when the quoted tokens look like
 * efforts and the message is not about another request field.
 * @param {number} status
 * @param {string} message
 * @returns {boolean}
 */
export function isUnsupportedReasoningEffortError(status, message) {
  if (status !== 400 && status !== 422) return false;
  if (typeof message !== "string" || !message) return false;
  const lower = message.toLowerCase();
  const rejected =
    lower.includes("not supported") || lower.includes("supported values");
  if (!rejected) return false;
  if (lower.includes("reasoning") || lower.includes("effort")) return true;
  if (!lower.includes("unsupported value")) return false;
  if (UNRELATED_UNSUPPORTED_VALUE_FIELDS.test(lower)) return false;
  return parseSupportedReasoningEfforts(message).length > 0;
}

/**
 * Quoted effort tokens in an OpenAI-style error (rejected value + supported list).
 * @param {string} message
 * @returns {string[]}
 */
export function parseSupportedReasoningEfforts(message) {
  if (typeof message !== "string") return [];
  /** @type {string[]} */
  const found = [];
  for (const value of OPENAI_COMPAT_REASONING_EFFORTS) {
    if (message.includes(`'${value}'`) || message.includes(`"${value}"`)) {
      found.push(value);
    }
  }
  return found;
}

/**
 * Next OpenAI-compatible effort after `sent` was rejected.
 * Prefers the lowest remaining supported value; `undefined` means omit the field.
 * @param {string} sent
 * @param {string} message
 * @returns {string | undefined}
 */
export function fallbackOpenAICompatReasoningEffort(sent, message) {
  const remaining = parseSupportedReasoningEfforts(message).filter(
    (value) => value !== sent
  );
  for (const value of OPENAI_COMPAT_REASONING_EFFORTS) {
    if (remaining.includes(value)) return value;
  }
  return undefined;
}

/**
 * @param {number} status
 * @param {string} message
 * @param {string | undefined} sentEffort
 * @returns {{ retry: false } | { retry: true, effort: string | undefined }}
 */
export function nextOpenAICompatReasoningEffortAfterError(
  status,
  message,
  sentEffort
) {
  if (sentEffort === undefined) return { retry: false };
  if (!isUnsupportedReasoningEffortError(status, message)) {
    return { retry: false };
  }
  return {
    retry: true,
    effort: fallbackOpenAICompatReasoningEffort(sentEffort, message),
  };
}

/** @typedef {"adaptive" | "extended"} AnthropicThinkingMode */

/** budget_tokens for IPA low/medium/high on extended-thinking-only models. */
const ANTHROPIC_EXTENDED_BUDGET = Object.freeze({
  low: 1024,
  medium: 2048,
  high: 4096,
});

/**
 * @param {string | undefined} model
 * @returns {string}
 */
function anthropicModelLeaf(model) {
  if (typeof model !== "string" || !model) return "";
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

/**
 * @param {string | undefined} model
 * @returns {{ family: string, major: number, minor: number } | null}
 */
function parseAnthropicModel(model) {
  const id = anthropicModelLeaf(model);
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id);
  if (!match) return null;
  return {
    family: match[1].toLowerCase(),
    major: Number(match[2]),
    minor: match[3] == null ? 0 : Number(match[3]),
  };
}

/**
 * Claude 4.5 and earlier thinking models are extended-only (`adaptive` 400s).
 * Claude 4.6+ use adaptive thinking.
 *
 * @param {string | undefined} model
 * @returns {AnthropicThinkingMode}
 */
export function anthropicThinkingMode(model) {
  const parsed = parseAnthropicModel(model);
  if (!parsed) return "adaptive";
  if (parsed.major < 4) return "extended";
  if (parsed.major === 4 && parsed.minor <= 5) return "extended";
  return "adaptive";
}

/**
 * Fable 5 (and Mythos 5) reject `thinking.type: "disabled"`.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function anthropicRejectsDisabledThinking(model) {
  const parsed = parseAnthropicModel(model);
  return Boolean(parsed && parsed.family === "fable" && parsed.major >= 5);
}

/**
 * Anthropic Messages API: adaptive thinking + `output_config.effort` on
 * Claude 4.6+, or extended thinking (`enabled` + `budget_tokens`) on
 * Claude 4.5 and earlier. Fable 5 cannot disable thinking — IPA `"none"`
 * omits the field rather than 400.
 *
 * @param {ReasoningEffort | undefined} effort
 * @param {string | undefined} [model]
 * @returns {{
 *   thinking:
 *     | { type: "disabled" }
 *     | { type: "adaptive" }
 *     | { type: "enabled", budget_tokens: number },
 *   output_config?: { effort: "low" | "medium" | "high" },
 * } | undefined}
 */
export function mapReasoningEffortForAnthropic(effort, model) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") {
    if (anthropicRejectsDisabledThinking(model)) return undefined;
    return { thinking: { type: "disabled" } };
  }
  if (anthropicThinkingMode(model) === "extended") {
    return {
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_EXTENDED_BUDGET[effort],
      },
    };
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
  };
}

/**
 * Ollama `/api/chat`: top-level `think` (boolean or level string).
 * @param {ReasoningEffort | undefined} effort
 * @returns {false | "low" | "medium" | "high" | undefined}
 */
export function mapReasoningEffortForOllama(effort) {
  if (effort == null || effort === "auto") return undefined;
  if (effort === "none") return false;
  return effort;
}
