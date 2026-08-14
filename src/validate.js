const ROLES = new Set(["system", "user", "assistant"]);
const EXPERIMENTAL_ROLES = new Set(["system", "user", "assistant", "tool"]);
const TOOL_CHOICE_STRINGS = new Set(["auto", "none", "required"]);

/**
 * @typedef {{
 *   id: string,
 *   type: "function",
 *   function: { name: string, arguments: string },
 * }} ToolCall
 *
 * @typedef {{
 *   type: "function",
 *   function: {
 *     name: string,
 *     description?: string,
 *     parameters?: object,
 *   },
 * } | { type: "web_search" }} Tool
 *
 * @typedef {{
 *   role: string,
 *   content: string | null,
 *   reasoning?: string,
 *   toolCalls?: ToolCall[],
 *   toolCallId?: string,
 * }} ExperimentalMessage
 */

/**
 * Reject OpenAI-style snake_case aliases so they fail loudly instead of being
 * stripped during normalization (which would drop tool history silently).
 * @param {Record<string, unknown>} m
 * @param {number} i
 * @returns {{ ok: false, message: string } | null}
 */
function rejectLegacySnakeCaseToolFields(m, i) {
  if (m.tool_calls !== undefined) {
    return {
      ok: false,
      message: `messages[${i}].tool_calls is not supported; use toolCalls.`,
    };
  }
  if (m.tool_call_id !== undefined) {
    return {
      ok: false,
      message: `messages[${i}].tool_call_id is not supported; use toolCallId.`,
    };
  }
  return null;
}

/**
 * Stable IPA path rejects experimental tool fields instead of stripping them.
 * @param {Record<string, unknown>} req
 * @param {Array<Record<string, unknown>>} messages
 * @returns {{ ok: false, message: string } | null}
 */
function rejectStableToolFields(req, messages) {
  // Treat undefined as absent so spreads like `{ ...opts, tools: undefined }`
  // do not trip the stable path.
  if (req.tools !== undefined) {
    return {
      ok: false,
      message:
        'tools is only available via window.inference.experimental.request.',
    };
  }
  if (req.toolChoice !== undefined) {
    return {
      ok: false,
      message:
        'toolChoice is only available via window.inference.experimental.request.',
    };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const legacy = rejectLegacySnakeCaseToolFields(m, i);
    if (legacy) return legacy;
    if (m.toolCalls !== undefined) {
      return {
        ok: false,
        message:
          'messages[].toolCalls is only available via window.inference.experimental.request.',
      };
    }
    if (m.toolCallId !== undefined) {
      return {
        ok: false,
        message:
          'messages[].toolCallId is only available via window.inference.experimental.request.',
      };
    }
  }
  return null;
}

/**
 * Validate an InferenceRequest from a page script.
 * @param {unknown} request
 * @returns {{ ok: true, value: { method: "chat", messages: Array<{role: string, content: string, reasoning?: string}> } } | { ok: false, message: string }}
 */
export function validateInferenceRequest(request) {
  if (request == null || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, message: "Request must be an object." };
  }

  const req = /** @type {Record<string, unknown>} */ (request);

  if (req.method !== "chat") {
    return { ok: false, message: 'Only method "chat" is supported in this draft.' };
  }

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array." };
  }

  const toolReject = rejectStableToolFields(
    req,
    /** @type {Array<Record<string, unknown>>} */ (req.messages)
  );
  if (toolReject) return toolReject;

  const messages = [];
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
      return { ok: false, message: `messages[${i}] must be an object.` };
    }
    const m = /** @type {Record<string, unknown>} */ (msg);
    if (typeof m.role !== "string" || !ROLES.has(m.role)) {
      return {
        ok: false,
        message: `messages[${i}].role must be "system", "user", or "assistant".`,
      };
    }
    if (typeof m.content !== "string") {
      return { ok: false, message: `messages[${i}].content must be a string.` };
    }
    /** @type {{ role: string, content: string, reasoning?: string }} */
    const normalized = { role: m.role, content: m.content };
    if ("reasoning" in m) {
      if (typeof m.reasoning !== "string") {
        return {
          ok: false,
          message: `messages[${i}].reasoning must be a string when present.`,
        };
      }
      if (m.reasoning) {
        normalized.reasoning = m.reasoning;
      }
    }
    messages.push(normalized);
  }

  if ("signal" in req && req.signal != null) {
    // AbortSignal cannot cross realms; page bridge handles abort via messages.
    // Ignore any serialized signal field if present.
  }

  return {
    ok: true,
    value: {
      method: "chat",
      messages,
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ ok: true, value: ToolCall[] } | { ok: false, message: string }}
 */
function validateToolCalls(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: `${label} must be a non-empty array when present.` };
  }

  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (let i = 0; i < value.length; i++) {
    const call = value[i];
    if (call == null || typeof call !== "object" || Array.isArray(call)) {
      return { ok: false, message: `${label}[${i}] must be an object.` };
    }
    const c = /** @type {Record<string, unknown>} */ (call);
    if (typeof c.id !== "string" || !c.id) {
      return { ok: false, message: `${label}[${i}].id must be a non-empty string.` };
    }
    if (c.type !== "function") {
      return { ok: false, message: `${label}[${i}].type must be "function".` };
    }
    if (
      c.function == null ||
      typeof c.function !== "object" ||
      Array.isArray(c.function)
    ) {
      return { ok: false, message: `${label}[${i}].function must be an object.` };
    }
    const fn = /** @type {Record<string, unknown>} */ (c.function);
    if (typeof fn.name !== "string" || !fn.name) {
      return {
        ok: false,
        message: `${label}[${i}].function.name must be a non-empty string.`,
      };
    }
    if (typeof fn.arguments !== "string") {
      return {
        ok: false,
        message: `${label}[${i}].function.arguments must be a string.`,
      };
    }
    toolCalls.push({
      id: c.id,
      type: "function",
      function: { name: fn.name, arguments: fn.arguments },
    });
  }
  return { ok: true, value: toolCalls };
}

/**
 * @param {unknown} tools
 * @returns {{ ok: true, value: Tool[] } | { ok: false, message: string }}
 */
function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { ok: false, message: "tools must be a non-empty array when present." };
  }

  /** @type {Tool[]} */
  const normalized = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
      return { ok: false, message: `tools[${i}] must be an object.` };
    }
    const t = /** @type {Record<string, unknown>} */ (tool);
    if (t.type === "web_search") {
      normalized.push({ type: "web_search" });
      continue;
    }
    if (t.type !== "function") {
      return {
        ok: false,
        message: `tools[${i}].type must be "function" or "web_search".`,
      };
    }
    if (
      t.function == null ||
      typeof t.function !== "object" ||
      Array.isArray(t.function)
    ) {
      return { ok: false, message: `tools[${i}].function must be an object.` };
    }
    const fn = /** @type {Record<string, unknown>} */ (t.function);
    if (typeof fn.name !== "string" || !fn.name) {
      return {
        ok: false,
        message: `tools[${i}].function.name must be a non-empty string.`,
      };
    }
    /** @type {{ type: "function", function: { name: string, description?: string, parameters?: object } }} */
    const entry = {
      type: "function",
      function: { name: fn.name },
    };
    if ("description" in fn) {
      if (typeof fn.description !== "string") {
        return {
          ok: false,
          message: `tools[${i}].function.description must be a string when present.`,
        };
      }
      entry.function.description = fn.description;
    }
    if ("parameters" in fn) {
      if (
        fn.parameters == null ||
        typeof fn.parameters !== "object" ||
        Array.isArray(fn.parameters)
      ) {
        return {
          ok: false,
          message: `tools[${i}].function.parameters must be an object when present.`,
        };
      }
      entry.function.parameters = fn.parameters;
    }
    normalized.push(entry);
  }
  return { ok: true, value: normalized };
}

/**
 * @param {unknown} toolChoice
 * @returns {{ ok: true, value: "auto" | "none" | "required" | { type: "function", function: { name: string } } } | { ok: false, message: string }}
 */
function validateToolChoice(toolChoice) {
  if (typeof toolChoice === "string") {
    if (!TOOL_CHOICE_STRINGS.has(toolChoice)) {
      return {
        ok: false,
        message: 'toolChoice must be "auto", "none", "required", or a function object.',
      };
    }
    return {
      ok: true,
      value: /** @type {"auto" | "none" | "required"} */ (toolChoice),
    };
  }
  if (toolChoice == null || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return {
      ok: false,
      message: 'toolChoice must be "auto", "none", "required", or a function object.',
    };
  }
  const choice = /** @type {Record<string, unknown>} */ (toolChoice);
  if (choice.type !== "function") {
    return { ok: false, message: 'toolChoice.type must be "function".' };
  }
  if (
    choice.function == null ||
    typeof choice.function !== "object" ||
    Array.isArray(choice.function)
  ) {
    return { ok: false, message: "toolChoice.function must be an object." };
  }
  const fn = /** @type {Record<string, unknown>} */ (choice.function);
  if (typeof fn.name !== "string" || !fn.name) {
    return {
      ok: false,
      message: "toolChoice.function.name must be a non-empty string.",
    };
  }
  return {
    ok: true,
    value: { type: "function", function: { name: fn.name } },
  };
}

/**
 * Validate a Bridge-experimental InferenceRequest (tools / tool messages).
 * Not part of the IPA draft contract — only used for `window.inference.experimental.request`.
 * @param {unknown} request
 * @returns {{
 *   ok: true,
 *   value: {
 *     method: "chat",
 *     messages: ExperimentalMessage[],
 *     tools?: Tool[],
 *     toolChoice?: "auto" | "none" | "required" | { type: "function", function: { name: string } },
 *   },
 * } | { ok: false, message: string }}
 */
export function validateExperimentalInferenceRequest(request) {
  if (request == null || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, message: "Request must be an object." };
  }

  const req = /** @type {Record<string, unknown>} */ (request);

  if (req.method !== "chat") {
    return { ok: false, message: 'Only method "chat" is supported in this draft.' };
  }

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array." };
  }

  /** @type {ExperimentalMessage[]} */
  const messages = [];
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
      return { ok: false, message: `messages[${i}] must be an object.` };
    }
    const m = /** @type {Record<string, unknown>} */ (msg);
    if (typeof m.role !== "string" || !EXPERIMENTAL_ROLES.has(m.role)) {
      return {
        ok: false,
        message: `messages[${i}].role must be "system", "user", "assistant", or "tool".`,
      };
    }

    const legacy = rejectLegacySnakeCaseToolFields(m, i);
    if (legacy) return legacy;

    if (m.role === "tool") {
      if (typeof m.toolCallId !== "string" || !m.toolCallId) {
        return {
          ok: false,
          message: `messages[${i}].toolCallId must be a non-empty string.`,
        };
      }
      if (typeof m.content !== "string") {
        return { ok: false, message: `messages[${i}].content must be a string.` };
      }
      if ("toolCalls" in m) {
        return {
          ok: false,
          message: `messages[${i}] with role "tool" must not include toolCalls.`,
        };
      }
      if ("reasoning" in m) {
        return {
          ok: false,
          message: `messages[${i}] with role "tool" must not include reasoning.`,
        };
      }
      messages.push({
        role: "tool",
        toolCallId: m.toolCallId,
        content: m.content,
      });
      continue;
    }

    if (m.role === "assistant") {
      // Chat Completions often omits content when only toolCalls are present.
      /** @type {string | null} */
      let content;
      if (!("content" in m)) {
        if (!("toolCalls" in m)) {
          return {
            ok: false,
            message: `messages[${i}].content must be a string or null.`,
          };
        }
        content = null;
      } else if (!(typeof m.content === "string" || m.content === null)) {
        return {
          ok: false,
          message: `messages[${i}].content must be a string or null.`,
        };
      } else {
        content = m.content;
      }
      /** @type {ExperimentalMessage} */
      const normalized = { role: "assistant", content };
      if ("toolCalls" in m) {
        const toolCalls = validateToolCalls(m.toolCalls, `messages[${i}].toolCalls`);
        if (!toolCalls.ok) return toolCalls;
        normalized.toolCalls = toolCalls.value;
      }
      if ("reasoning" in m) {
        if (typeof m.reasoning !== "string") {
          return {
            ok: false,
            message: `messages[${i}].reasoning must be a string when present.`,
          };
        }
        if (m.reasoning) {
          normalized.reasoning = m.reasoning;
        }
      }
      messages.push(normalized);
      continue;
    }

    // system | user
    if (typeof m.content !== "string") {
      return { ok: false, message: `messages[${i}].content must be a string.` };
    }
    if ("toolCalls" in m) {
      return {
        ok: false,
        message: `messages[${i}] with role "${m.role}" must not include toolCalls.`,
      };
    }
    /** @type {ExperimentalMessage} */
    const normalized = { role: m.role, content: m.content };
    if ("reasoning" in m) {
      if (typeof m.reasoning !== "string") {
        return {
          ok: false,
          message: `messages[${i}].reasoning must be a string when present.`,
        };
      }
      if (m.reasoning) {
        normalized.reasoning = m.reasoning;
      }
    }
    messages.push(normalized);
  }

  /** @type {{
   *   method: "chat",
   *   messages: ExperimentalMessage[],
   *   tools?: Tool[],
   *   toolChoice?: "auto" | "none" | "required" | { type: "function", function: { name: string } },
   * }} */
  const value = { method: "chat", messages };

  // Treat undefined as absent (option spreads); empty array still fails validateTools.
  if (req.tools !== undefined) {
    const tools = validateTools(req.tools);
    if (!tools.ok) return tools;
    value.tools = tools.value;
  }

  if (req.toolChoice !== undefined) {
    const toolChoice = validateToolChoice(req.toolChoice);
    if (!toolChoice.ok) return toolChoice;
    value.toolChoice = toolChoice.value;
  } else if (value.tools) {
    // Match common provider defaults when tools are present.
    value.toolChoice = "auto";
  }

  if ("signal" in req && req.signal != null) {
    // AbortSignal cannot cross realms; page bridge handles abort via messages.
  }

  return { ok: true, value };
}

/**
 * True for a serialized tuple origin from `location.origin`.
 * Rejects the opaque-origin sentinel `"null"` and `file:` origins — those are
 * not stable site identities for permission grants or blocks.
 * @param {string} origin
 * @returns {boolean}
 */
export function isValidOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  if (origin === "null") return false;
  try {
    const url = new URL(origin);
    if (url.protocol === "file:") return false;
    return url.origin === origin;
  } catch {
    return false;
  }
}
