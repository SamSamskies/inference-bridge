/**
 * Tool-approval helpers: fingerprints, episode continuation, preview, warnings.
 * Used by permissions + the approval popup (no Chrome APIs).
 */

/** @typedef {import("./providers/types.js").Tool} Tool */
/** @typedef {import("./providers/types.js").ChatMessage} ChatMessage */

/**
 * Stable identity for one tool (name / hosted type only — not parameters).
 * @param {Tool} tool
 * @returns {string | null}
 */
export function toolIdentity(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.type === "web_search") return "hosted:web_search";
  if (
    tool.type === "function" &&
    tool.function &&
    typeof tool.function.name === "string" &&
    tool.function.name
  ) {
    return `fn:${tool.function.name}`;
  }
  return null;
}

/**
 * Sorted, pipe-joined tool identities. Empty / invalid tools → "".
 * @param {Tool[] | undefined | null} tools
 * @returns {string}
 */
export function fingerprintTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  /** @type {Set<string>} */
  const ids = new Set();
  for (const tool of tools) {
    const id = toolIdentity(tool);
    if (id) ids.add(id);
  }
  return [...ids].sort().join("|");
}

/**
 * True when every identity in requestFp is present in grantedFp.
 * Empty request is covered; empty grant covers nothing non-empty.
 * @param {string} requestFp
 * @param {string} grantedFp
 * @returns {boolean}
 */
export function isToolFingerprintCovered(requestFp, grantedFp) {
  if (!requestFp) return true;
  if (!grantedFp) return false;
  const granted = new Set(grantedFp.split("|").filter(Boolean));
  for (const id of requestFp.split("|").filter(Boolean)) {
    if (!granted.has(id)) return false;
  }
  return true;
}

/**
 * Index of the assistant message that owns trailing tool results, or -1.
 * @param {Array<{ role?: string, tool_calls?: unknown }> | undefined | null} messages
 * @returns {number}
 */
function trailingToolCallsAssistantIndex(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;

  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "tool") {
      break;
    }
    i -= 1;
  }
  // Need at least one trailing tool result.
  if (i === messages.length - 1) return -1;

  const assistant = messages[i];
  if (
    !assistant ||
    typeof assistant !== "object" ||
    assistant.role !== "assistant" ||
    !Array.isArray(assistant.tool_calls) ||
    assistant.tool_calls.length === 0
  ) {
    return -1;
  }
  return i;
}

/**
 * Fingerprint of function names on the trailing assistant tool_calls turn.
 * Used when a follow-up omits `tools` so episode matching still binds to the
 * tools actually being continued — not any episode on the origin.
 * @param {Array<{ role?: string, tool_calls?: unknown }> | undefined | null} messages
 * @returns {string}
 */
export function fingerprintTrailingToolCalls(messages) {
  const i = trailingToolCallsAssistantIndex(messages);
  if (i < 0 || !messages) return "";

  const assistant = messages[i];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const call of assistant.tool_calls || []) {
    if (!call || typeof call !== "object") continue;
    const fn = /** @type {{ function?: { name?: unknown } }} */ (call).function;
    const name =
      fn && typeof fn === "object" && typeof fn.name === "string" && fn.name
        ? fn.name
        : "";
    if (name) ids.add(`fn:${name}`);
  }
  return [...ids].sort().join("|");
}

/**
 * Multi-turn function-tool follow-up: messages must *end* with tool results
 * that belong to the immediately preceding assistant tool_calls turn.
 * Prior tool history alone (or a new user turn after tools) is not enough —
 * otherwise Allow once could be reused for unrelated requests.
 * @param {Array<{ role?: string, tool_calls?: unknown, tool_call_id?: string }> | undefined | null} messages
 * @returns {boolean}
 */
export function isToolEpisodeContinuation(messages) {
  const i = trailingToolCallsAssistantIndex(messages);
  if (i < 0 || !messages) return false;

  const assistant = messages[i];
  /** @type {Set<string>} */
  const callIds = new Set();
  for (const call of assistant.tool_calls || []) {
    if (!call || typeof call !== "object") continue;
    const id = /** @type {{ id?: unknown }} */ (call).id;
    if (typeof id === "string" && id) callIds.add(id);
  }
  if (callIds.size === 0) return false;

  for (let j = i + 1; j < messages.length; j += 1) {
    const toolMessage = messages[j];
    const toolCallId =
      toolMessage &&
      typeof toolMessage === "object" &&
      typeof toolMessage.tool_call_id === "string"
        ? toolMessage.tool_call_id
        : "";
    if (!toolCallId || !callIds.has(toolCallId)) return false;
  }

  return true;
}

/**
 * @param {Tool[] | undefined | null} tools
 * @returns {{
 *   functions: Array<{ name: string, description?: string }>,
 *   hosted: string[],
 * }}
 */
export function summarizeToolsForPreview(tools) {
  /** @type {Array<{ name: string, description?: string }>} */
  const functions = [];
  /** @type {string[]} */
  const hosted = [];
  /** @type {Set<string>} */
  const seenFn = new Set();
  /** @type {Set<string>} */
  const seenHosted = new Set();

  if (!Array.isArray(tools)) {
    return { functions, hosted };
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "web_search") {
      if (!seenHosted.has("web_search")) {
        seenHosted.add("web_search");
        hosted.push("web_search");
      }
      continue;
    }
    if (
      tool.type === "function" &&
      tool.function &&
      typeof tool.function.name === "string" &&
      tool.function.name
    ) {
      const name = tool.function.name;
      if (seenFn.has(name)) continue;
      seenFn.add(name);
      /** @type {{ name: string, description?: string }} */
      const entry = { name };
      if (
        typeof tool.function.description === "string" &&
        tool.function.description
      ) {
        entry.description = tool.function.description;
      }
      functions.push(entry);
    }
  }

  return { functions, hosted };
}

/**
 * Human label for a hosted tool id in the approval UI.
 * @param {string} hostedId
 * @returns {string}
 */
export function hostedToolLabel(hostedId) {
  if (hostedId === "web_search") return "Web search (provider-hosted)";
  return hostedId;
}

/**
 * Capability warnings for the selected provider vs requested tools.
 * Warn only — callers must not hard-block Allow.
 *
 * @param {{
 *   supportsFunctionTools?: boolean,
 *   hostedTools?: readonly string[],
 *   label?: string,
 * } | null | undefined} provider
 * @param {Tool[] | undefined | null} tools
 * @returns {string[]}
 */
export function capabilityWarnings(provider, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const summary = summarizeToolsForPreview(tools);
  /** @type {string[]} */
  const warnings = [];
  const label =
    provider && typeof provider.label === "string" && provider.label
      ? provider.label
      : "This provider";

  if (summary.functions.length > 0 && !provider?.supportsFunctionTools) {
    warnings.push(
      `${label} may not support function tools. The request can still proceed, but tool calls may fail.`
    );
  }

  const hostedSupported = new Set(
    Array.isArray(provider?.hostedTools) ? provider.hostedTools : []
  );
  for (const hosted of summary.hosted) {
    if (!hostedSupported.has(hosted)) {
      if (hosted === "web_search") {
        warnings.push(
          `Web search is not available for ${label} yet. Allow will still work; search will not run until a provider mapping exists.`
        );
      } else {
        warnings.push(
          `Hosted tool "${hosted}" is not supported by ${label}. Allow is still available.`
        );
      }
    }
  }

  return warnings;
}
