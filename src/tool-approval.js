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
 * @param {Array<{ role?: string, toolCalls?: unknown }> | undefined | null} messages
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
    !Array.isArray(assistant.toolCalls) ||
    assistant.toolCalls.length === 0
  ) {
    return -1;
  }
  return i;
}

/**
 * Fingerprint of function names on the trailing assistant toolCalls turn.
 * Used when a follow-up omits `tools` so episode matching still binds to the
 * tools actually being continued — not any episode on the origin.
 * @param {Array<{ role?: string, toolCalls?: unknown }> | undefined | null} messages
 * @returns {string}
 */
export function fingerprintTrailingToolCalls(messages) {
  const i = trailingToolCallsAssistantIndex(messages);
  if (i < 0 || !messages) return "";

  const assistant = messages[i];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const call of assistant.toolCalls || []) {
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
 * True when `messages` starts with `prefix` (equal length allowed). Used when
 * denying so a re-prompted opening matches the stored Allow-once prefix.
 * @param {unknown} messages
 * @param {unknown} prefix
 * @returns {boolean}
 */
export function startsWithMessageHistory(messages, prefix) {
  if (!Array.isArray(messages) || !Array.isArray(prefix) || prefix.length === 0) {
    return false;
  }
  if (messages.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (JSON.stringify(messages[i]) !== JSON.stringify(prefix[i])) {
      return false;
    }
  }
  return true;
}

/**
 * True when `messages` strictly extends `prefix` (same leading messages, then
 * at least one more). Used so Allow-once episodes cannot be reused by a
 * fabricated tool-continuation history on the same origin.
 * @param {unknown} messages
 * @param {unknown} prefix
 * @returns {boolean}
 */
export function isMessageHistoryExtension(messages, prefix) {
  return (
    Array.isArray(messages) &&
    Array.isArray(prefix) &&
    messages.length > prefix.length &&
    startsWithMessageHistory(messages, prefix)
  );
}

/**
 * Multi-turn function-tool follow-up: messages must *end* with tool results
 * that belong to the immediately preceding assistant toolCalls turn, and
 * every call id from that turn must have a matching result.
 * Prior tool history alone (or a new user turn after tools) is not enough —
 * otherwise Allow once could be reused for unrelated requests.
 * @param {Array<{ role?: string, toolCalls?: unknown, toolCallId?: string }> | undefined | null} messages
 * @returns {boolean}
 */
export function isToolEpisodeContinuation(messages) {
  const i = trailingToolCallsAssistantIndex(messages);
  if (i < 0 || !messages) return false;

  const assistant = messages[i];
  /** @type {Set<string>} */
  const callIds = new Set();
  for (const call of assistant.toolCalls || []) {
    if (!call || typeof call !== "object") continue;
    const id = /** @type {{ id?: unknown }} */ (call).id;
    if (typeof id === "string" && id) callIds.add(id);
  }
  if (callIds.size === 0) return false;

  /** @type {Set<string>} */
  const seen = new Set();
  for (let j = i + 1; j < messages.length; j += 1) {
    const toolMessage = messages[j];
    const toolCallId =
      toolMessage &&
      typeof toolMessage === "object" &&
      typeof toolMessage.toolCallId === "string"
        ? toolMessage.toolCallId
        : "";
    if (!toolCallId || !callIds.has(toolCallId)) return false;
    seen.add(toolCallId);
  }

  // Partial multi-tool turns (only some call ids answered) are not continuations.
  return seen.size === callIds.size;
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
 * @param {{ id?: string } | null | undefined} [provider]
 * @returns {string}
 */
export function hostedToolLabel(hostedId, provider) {
  if (hostedId === "web_search") {
    if (provider?.id === "ollama") return "Web search (Ollama cloud)";
    return "Web search (provider-hosted)";
  }
  return hostedId;
}

/**
 * Optional muted description under a hosted tool in the approval Tools list.
 * Used for context that is not an error (so it must not use the red warning).
 * @param {string} hostedId
 * @param {{ id?: string } | null | undefined} [provider]
 * @returns {string}
 */
export function hostedToolDescription(hostedId, provider) {
  if (hostedId === "web_search" && provider?.id === "ollama") {
    return "Runs in Inference Bridge against ollama.com. An Ollama account and usage may apply.";
  }
  return "";
}

/**
 * True when the request includes function tools the provider cannot relay.
 * Approval should disable Allow and ask the user to pick another provider.
 * Unsupported hosted tools stay soft-warn only (chat can still proceed),
 * except Ollama `{ type: "web_search" }` without an account API key.
 *
 * @param {{
 *   supportsFunctionTools?: boolean,
 * } | null | undefined} provider
 * @param {Tool[] | undefined | null} tools
 * @returns {boolean}
 */
export function blocksAllowForUnsupportedFunctionTools(provider, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  const summary = summarizeToolsForPreview(tools);
  return summary.functions.length > 0 && !provider?.supportsFunctionTools;
}

/**
 * True when Ollama is selected for hosted web_search but no ollama.com key is
 * saved. Allow cannot succeed (Bridge will not silently strip search).
 * `hasApiKey === undefined` (settings unread) does not block — the stream
 * still enforces the key. Callers must set `hasApiKey: false` for
 * whitespace-only keys (`hasStoredApiKey` / `hasOllamaWebSearchApiKey`).
 *
 * @param {{
 *   id?: string,
 *   hasApiKey?: boolean,
 * } | null | undefined} provider
 * @param {Tool[] | undefined | null} tools
 * @returns {boolean}
 */
export function blocksAllowForMissingOllamaWebSearchKey(provider, tools) {
  if (!provider || provider.id !== "ollama") return false;
  if (provider.hasApiKey !== false) return false;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return summarizeToolsForPreview(tools).hosted.includes("web_search");
}

/**
 * True when Allow must stay disabled because of the request's tools.
 * @param {{
 *   id?: string,
 *   supportsFunctionTools?: boolean,
 *   hasApiKey?: boolean,
 * } | null | undefined} provider
 * @param {Tool[] | undefined | null} tools
 * @returns {boolean}
 */
export function blocksAllowForRequestTools(provider, tools) {
  return (
    blocksAllowForUnsupportedFunctionTools(provider, tools) ||
    blocksAllowForMissingOllamaWebSearchKey(provider, tools)
  );
}

/**
 * Capability warnings for the selected provider vs requested tools.
 * Function tools on an unsupported provider also block Allow (see
 * `blocksAllowForRequestTools`). Unsupported hosted tools warn only.
 * Ollama web_search without a key blocks Allow and this warning tells the user
 * to save a key in Options. When a key is saved, Ollama search is explained
 * under the Tools list instead (not as a red warning).
 *
 * @param {{
 *   id?: string,
 *   supportsFunctionTools?: boolean,
 *   hostedTools?: readonly string[],
 *   label?: string,
 *   hasApiKey?: boolean,
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

  if (blocksAllowForUnsupportedFunctionTools(provider, tools)) {
    warnings.push(
      `${label} does not support function tools. Choose another provider to allow this request.`
    );
  }

  const hostedSupported = new Set(
    Array.isArray(provider?.hostedTools) ? provider.hostedTools : []
  );
  const isOpenAICompat =
    typeof provider?.id === "string" && provider.id.startsWith("compat:");
  for (const hosted of summary.hosted) {
    if (!hostedSupported.has(hosted)) {
      if (hosted === "web_search") {
        warnings.push(
          isOpenAICompat
            ? "Hosted web search is not mapped for OpenAI-compatible servers. Inference Bridge will not run a hosted search."
            : `Web search is not supported by ${label}. The provider will not run a hosted search.`
        );
      } else {
        warnings.push(
          `Hosted tool "${hosted}" is not supported by ${label}. Allow is still available.`
        );
      }
      continue;
    }
    if (
      hosted === "web_search" &&
      provider?.id === "ollama" &&
      provider.hasApiKey === false
    ) {
      warnings.push(
        "Web search runs in Inference Bridge against ollama.com (not local Ollama). Save an Ollama account API key in Options to enable Allow, or choose another provider."
      );
    }
  }

  return warnings;
}
