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
function turn(id = call.id) {
  return {
    steps: [{ ...call, id }],
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        },
      ],
    },
  };
}

describe("private Gemini function state", () => {
  it("isolates credentials, origins and models and returns an independent copy", async () => {
    const cache = createGeminiCallState();
    const bundle = turn();
    await cache.remember(scope, bundle);
    const replay = await cache.replay(scope, bundle.message);
    expect(replay).toEqual(bundle.steps);
    replay[0].signature = "changed";
    expect(await cache.replay(scope, bundle.message)).toEqual(bundle.steps);
    for (const other of [
      { ...scope, origin: "https://other.example" },
      { ...scope, model: "gemini-4-argon" },
      { ...scope, apiKey: "other-key" },
    ])
      await expect(cache.replay(other, bundle.message)).rejects.toMatchObject({
        code: "unavailable",
      });
    const changed = turn();
    changed.message.toolCalls[0].function.name = "different";
    await expect(cache.replay(scope, changed.message)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
  it("expires old state and bounds both entries and bytes", async () => {
    let clock = 0;
    const cache = createGeminiCallState({
      maxEntries: 1,
      ttlMs: 100,
      now: () => clock,
    });
    const bundle = turn();
    await cache.remember(scope, bundle);
    clock = 100;
    await expect(cache.replay(scope, bundle.message)).rejects.toMatchObject({
      code: "unavailable",
    });
    await cache.remember(scope, bundle);
    const second = turn("call-2");
    await cache.remember(scope, second);
    await expect(cache.replay(scope, bundle.message)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await cache.replay(scope, second.message)).toEqual(second.steps);
    const byteCache = createGeminiCallState({
      maxBytes: 300,
    });
    await byteCache.remember(scope, bundle);
    await byteCache.remember(scope, second);
    await expect(byteCache.replay(scope, bundle.message)).rejects.toMatchObject(
      {
        code: "unavailable",
      }
    );
    await expect(
      byteCache.remember(scope, {
        ...bundle,
        steps: [{ ...call, signature: "x".repeat(1000) }],
      })
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});
