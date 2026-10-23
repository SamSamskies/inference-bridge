import { geminiError } from "./gemini-api.js";

/**
 * Native signatures cannot round-trip through IPA's portable ToolCall shape.
 * Keep native tool-turn response bundles in bounded worker memory, scoped to the
 * trusted caller origin, selected model, and credential. Never send this state
 * to a page or persist it. A worker restart requires a fresh conversation.
 */
export function createGeminiCallState({
  maxEntries = 128,
  maxBytes = 2_000_000,
  ttlMs = 30 * 60_000,
  now = Date.now,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    bytes -= entries.get(key).size;
    entries.delete(key);
  }
  function prune() {
    for (const [key, entry] of entries) if (entry.expires <= now()) remove(key);
  }
  async function keyFor({ origin = "", model, apiKey }, id) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([origin, model, apiKey, id]))
    );
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
  }
  function portableTurn(message) {
    return JSON.stringify({
      content: message.content ?? "",
      calls: (message.toolCalls || []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      })),
    });
  }
  return {
    clear() {
      entries.clear();
      bytes = 0;
    },
    async remember(scope, { message, steps }) {
      prune();
      const serialized = JSON.stringify(steps);
      const portable = portableTurn(message);
      const size = new TextEncoder().encode(serialized + portable).byteLength;
      if (size > maxBytes)
        throw geminiError(
          "provider_error",
          "Gemini function-call state exceeds the local limit"
        );
      const key = await keyFor(scope, message.toolCalls[0].id);
      if (entries.has(key)) remove(key);
      while (entries.size >= maxEntries || bytes + size > maxBytes)
        remove(entries.keys().next().value);
      entries.set(key, {
        steps: JSON.parse(serialized),
        portable,
        size,
        expires: now() + ttlMs,
      });
      bytes += size;
    },
    async replay(scope, message) {
      prune();
      const entry = entries.get(await keyFor(scope, message.toolCalls[0].id));
      if (!entry)
        throw geminiError(
          "unavailable",
          "Gemini function-call state expired or is unavailable. Start a new conversation and retry."
        );
      if (entry.portable !== portableTurn(message))
        throw geminiError(
          "invalid_request",
          "Gemini function calls must be replayed unchanged"
        );
      return structuredClone(entry.steps);
    },
  };
}

export const geminiCallState = createGeminiCallState();
