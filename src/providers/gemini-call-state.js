import { geminiError } from "./gemini-api.js";

/**
 * Native signatures cannot round-trip through IPA's portable ToolCall shape.
 * Keep only signed function steps in bounded worker memory, scoped to the
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
  return {
    clear() {
      entries.clear();
      bytes = 0;
    },
    async remember(scope, call) {
      prune();
      const serialized = JSON.stringify(call);
      const size = new TextEncoder().encode(serialized).byteLength;
      if (size > maxBytes)
        throw geminiError(
          "provider_error",
          "Gemini function-call state exceeds the local limit"
        );
      const key = await keyFor(scope, call.id);
      if (entries.has(key)) remove(key);
      while (entries.size >= maxEntries || bytes + size > maxBytes)
        remove(entries.keys().next().value);
      entries.set(key, {
        call: JSON.parse(serialized),
        size,
        expires: now() + ttlMs,
      });
      bytes += size;
    },
    async replay(scope, call) {
      prune();
      const entry = entries.get(await keyFor(scope, call.id));
      if (!entry)
        throw geminiError(
          "unavailable",
          "Gemini function-call state expired or is unavailable. Start a new conversation and retry."
        );
      if (
        entry.call.name !== call.name ||
        JSON.stringify(entry.call.arguments) !== JSON.stringify(call.arguments)
      )
        throw geminiError(
          "invalid_request",
          "Gemini function calls must be replayed unchanged"
        );
      return structuredClone(entry.call);
    },
  };
}

export const geminiCallState = createGeminiCallState();
