import { describe, expect, it } from "vitest";
import { createGeminiCallState } from "../src/providers/gemini-call-state.js";

const scope = {
  origin: "https://charts.example",
  model: "gemini-3.8-flash",
  apiKey: "local-test-key",
};
const call = {
  type: "function_call",
  id: "call-1",
  name: "add",
  arguments: { a: 2, b: 3 },
  signature: "private-signature",
};

describe("private Gemini function state", () => {
  it("isolates credentials, origins and models and returns an independent copy", async () => {
    const cache = createGeminiCallState();
    await cache.remember(scope, call);
    const replay = await cache.replay(scope, call);
    expect(replay).toEqual(call);
    replay.signature = "changed";
    expect(await cache.replay(scope, call)).toEqual(call);
    for (const other of [
      { ...scope, origin: "https://other.example" },
      { ...scope, model: "gemini-4-argon" },
      { ...scope, apiKey: "other-key" },
    ])
      await expect(cache.replay(other, call)).rejects.toMatchObject({
        code: "unavailable",
      });
    await expect(
      cache.replay(scope, { ...call, name: "different" })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("expires old state and bounds both entries and bytes", async () => {
    let clock = 0;
    const cache = createGeminiCallState({
      maxEntries: 1,
      ttlMs: 100,
      now: () => clock,
    });
    await cache.remember(scope, call);
    clock = 100;
    await expect(cache.replay(scope, call)).rejects.toMatchObject({
      code: "unavailable",
    });
    await cache.remember(scope, call);
    const second = { ...call, id: "call-2" };
    await cache.remember(scope, second);
    await expect(cache.replay(scope, call)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await cache.replay(scope, second)).toEqual(second);
    const byteCache = createGeminiCallState({
      maxBytes: new TextEncoder().encode(JSON.stringify(call)).byteLength,
    });
    await byteCache.remember(scope, call);
    await byteCache.remember(scope, second);
    await expect(byteCache.replay(scope, call)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      byteCache.remember(scope, { ...call, signature: "x".repeat(1000) })
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});
