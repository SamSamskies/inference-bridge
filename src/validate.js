const ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Validate an InferenceRequest from a page script.
 * @param {unknown} request
 * @returns {{ ok: true, value: { method: "chat", messages: Array<{role: string, content: string, reasoning?: string, tool_call_id?: string, tool_calls?: Array<{id?: string, name: string, arguments?: Record<string, unknown>}>}>, tools?: Array<{name: string, description?: string, inputSchema?: object}> } } | { ok: false, message: string }}
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
        message: `messages[${i}].role must be "system", "user", "assistant", or "tool".`,
      };
    }
    if (typeof m.content !== "string") {
      // Assistant turns that only carried tool_calls may omit content; the
      // provider round-trip needs an empty string, not an omission.
      if (!(m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) {
        return { ok: false, message: `messages[${i}].content must be a string.` };
      }
    }
    /** @type {{ role: string, content: string, reasoning?: string, tool_call_id?: string, tool_calls?: Array<{id?: string, name: string, arguments?: Record<string, unknown>}> }} */
    const normalized = { role: m.role, content: typeof m.content === "string" ? m.content : "" };
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
    if (m.role === "tool") {
      if ("tool_call_id" in m) {
        if (typeof m.tool_call_id !== "string") {
          return {
            ok: false,
            message: `messages[${i}].tool_call_id must be a string when present.`,
          };
        }
        if (m.tool_call_id) {
          normalized.tool_call_id = m.tool_call_id;
        }
      }
    }
    if ("tool_calls" in m) {
      if (m.role !== "assistant") {
        return {
          ok: false,
          message: `messages[${i}].tool_calls is only allowed on assistant messages.`,
        };
      }
      if (!Array.isArray(m.tool_calls)) {
        return {
          ok: false,
          message: `messages[${i}].tool_calls must be an array.`,
        };
      }
      const calls = [];
      for (let j = 0; j < m.tool_calls.length; j++) {
        const call = m.tool_calls[j];
        if (call == null || typeof call !== "object" || Array.isArray(call)) {
          return {
            ok: false,
            message: `messages[${i}].tool_calls[${j}] must be an object.`,
          };
        }
        const c = /** @type {Record<string, unknown>} */ (call);
        if (typeof c.name !== "string" || !c.name) {
          return {
            ok: false,
            message: `messages[${i}].tool_calls[${j}].name must be a non-empty string.`,
          };
        }
        /** @type {{ id?: string, name: string, arguments?: Record<string, unknown> }} */
        const normalizedCall = { name: c.name };
        if (typeof c.id === "string" && c.id) {
          normalizedCall.id = c.id;
        }
        if ("arguments" in c) {
          if (typeof c.arguments === "string") {
            try {
              normalizedCall.arguments = JSON.parse(c.arguments);
            } catch {
              return {
                ok: false,
                message: `messages[${i}].tool_calls[${j}].arguments must be valid JSON.`,
              };
            }
          } else if (
            c.arguments != null &&
            typeof c.arguments === "object" &&
            !Array.isArray(c.arguments)
          ) {
            normalizedCall.arguments = /** @type {Record<string, unknown>} */ (c.arguments);
          } else {
            return {
              ok: false,
              message: `messages[${i}].tool_calls[${j}].arguments must be an object or JSON string.`,
            };
          }
        }
        calls.push(normalizedCall);
      }
      normalized.tool_calls = calls;
    }
    messages.push(normalized);
  }

  let tools;
  if ("tools" in req) {
    if (!Array.isArray(req.tools)) {
      return { ok: false, message: "tools must be an array." };
    }
    tools = [];
    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i];
      if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
        return { ok: false, message: `tools[${i}] must be an object.` };
      }
      const t = /** @type {Record<string, unknown>} */ (tool);
      if (typeof t.name !== "string" || !t.name.trim()) {
        return {
          ok: false,
          message: `tools[${i}].name must be a non-empty string.`,
        };
      }
      /** @type {{ name: string, description?: string, inputSchema?: object }} */
      const def = { name: t.name };
      if (typeof t.description === "string" && t.description) {
        def.description = t.description;
      }
      if ("inputSchema" in t) {
        if (t.inputSchema == null || typeof t.inputSchema !== "object" || Array.isArray(t.inputSchema)) {
          return {
            ok: false,
            message: `tools[${i}].inputSchema must be an object when present.`,
          };
        }
        def.inputSchema = /** @type {object} */ (t.inputSchema);
      }
      tools.push(def);
    }
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
      ...(tools ? { tools } : {}),
    },
  };
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
