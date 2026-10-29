/** Model-specific Ollama thinking controls. Shared by requests and approval UI. */

/** @typedef {{ values: (boolean | string)[], default?: boolean | string }} OllamaThinking */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** A capability flag alone does not establish which controls are supported. */
export function parseOllamaThinking(payload) {
  const thinking = payload?.thinking;
  const values = thinking?.values;
  if (!Array.isArray(values) || values.length === 0 || values.length > 64 ||
      values.some((value) => typeof value !== "boolean" &&
        (typeof value !== "string" || !value.trim() || value.length > 64))) {
    return undefined;
  }
  if (thinking.default !== undefined && !values.includes(thinking.default)) return undefined;
  return {
    values: [...new Set(values)],
    ...(thinking.default !== undefined ? { default: thinking.default } : {}),
  };
}

function lowestLevel(values) {
  const names = values.filter((value) => typeof value === "string");
  // Model-defined names are not necessarily ordered. Never guess their rank.
  if (!names.length || names.some((value) => !LEVELS.includes(value))) return undefined;
  return LEVELS.find((value) => names.includes(value));
}

/**
 * @param {import("./reasoning-effort.js").ReasoningEffort | undefined} effort
 * @param {OllamaThinking | undefined} thinking
 * @returns {boolean | string | undefined}
 */
export function mapReasoningEffortForOllama(effort, thinking) {
  if (effort == null || effort === "auto" || !thinking) return undefined;
  const { values } = thinking;
  if (effort === "none") {
    return values.includes(false) ? false : lowestLevel(values);
  }
  if (values.includes(effort)) return effort;
  // Boolean-only controls can enable thinking but cannot select its effort.
  if (values.every((value) => typeof value === "boolean")) {
    return values.includes(true) ? true : undefined;
  }
  return undefined;
}

function label(value) {
  if (value === false) return "Off";
  if (value === true) return "On";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Guidance describes the mapping even when the effort is inherited from a page. */
export function ollamaThinkingGuidance(thinking) {
  if (!thinking) {
    return "Thinking controls could not be verified for this model. Bridge uses the model default; None may still produce thinking.";
  }
  const { values } = thinking;
  let note;
  if (values.length === 1 && values[0] === false) {
    note = "This model reports no thinking support.";
  } else if (values.includes(false)) {
    note = "None requests thinking off for this model.";
  } else {
    const lowest = lowestLevel(values);
    note = lowest
      ? `This model cannot disable thinking. None uses ${label(lowest)}, its lowest supported effort.`
      : "This model does not advertise an off control. Its lowest effort could not be determined; None uses the model default.";
  }
  return `${note} Auto uses the model default${thinking.default !== undefined ? ` (${label(thinking.default)})` : ""}.`;
}
