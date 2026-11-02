import { beforeEach, describe, expect, it, vi } from "vitest";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Run the same observable contract against each real adapter + native fixture. */
export function chatAdapterContract(name, setup) {
  describe(`${name} shared chat adapter contract`, () => {
    let h;
    beforeEach(async () => { h = await setup(); });
    const keyA = "private-contract-key-A";
    const keyB = "private-contract-key-B";
    function args(extra = {}) {
      return {
        apiKey: keyA, model: h.model,
        messages: [{ role: "user", content: "Hi" }],
        signal: new AbortController().signal,
        onDelta: vi.fn(), onReasoningDelta: vi.fn(),
        ...h.extra, ...extra,
      };
    }

    it("streams before settling and returns an assistant result consistent with deltas", async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      h.setCompletionGate(gate);
      const input = args();
      let settled = false;
      const result = h.provider.streamChat(input).finally(() => { settled = true; });
      try {
        await vi.waitFor(() => expect(input.onDelta).toHaveBeenCalled());
        expect(settled).toBe(false);
      } finally { release(); }
      const output = await result;
      expect(output).toMatchObject({ model: h.model, message: { role: "assistant", content: "Hello Hi" } });
      expect(input.onDelta.mock.calls.flat().every((delta) => typeof delta === "string" && delta)).toBe(true);
      expect(input.onDelta.mock.calls.flat().join("")).toBe(output.message.content);
      if (output.usage) {
        for (const count of Object.values(output.usage)) if (count !== undefined) expect(count).toBeGreaterThanOrEqual(0);
      }
      const count = input.onDelta.mock.calls.length;
      await Promise.resolve();
      expect(input.onDelta).toHaveBeenCalledTimes(count);
    });

    it("does not mutate nested request data, including tools and preferences", async () => {
      const data = {
        messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "Hi" }] }],
        options: { temperature: 0.5 }, output: { images: false },
        ...(h.provider.supportsFunctionTools ? {
          tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
          toolChoice: "auto",
        } : {}),
      };
      const before = structuredClone(data);
      await h.provider.streamChat(args(deepFreeze(data)));
      expect(data).toEqual(before);
    });

    it("isolates concurrent explicit credentials, models, callbacks and signals from saved defaults", async () => {
      let releaseA, releaseB;
      const gateA = new Promise((resolve) => { releaseA = resolve; });
      const gateB = new Promise((resolve) => { releaseB = resolve; });
      h.setRequestGate((call) => call.text === "A" ? gateA : gateB);
      const a = args({ messages: [{ role: "user", content: "A" }] });
      const b = args({ apiKey: keyB, model: h.otherModel, messages: [{ role: "user", content: "B" }], signal: new AbortController().signal });
      const pendingA = h.provider.streamChat(a);
      const pendingB = h.provider.streamChat(b);
      try {
        await vi.waitFor(() => expect(h.calls).toHaveLength(2));
        releaseB();
        const resultB = await pendingB;
        expect(resultB).toMatchObject({ model: h.otherModel, message: { content: "Hello B" } });
        expect(a.onDelta).not.toHaveBeenCalled();
        releaseA();
        const resultA = await pendingA;
        expect(resultA).toMatchObject({ model: h.model, message: { content: "Hello A" } });
        expect(a.onDelta.mock.calls.flat().join("")).toBe("Hello A");
        expect(b.onDelta.mock.calls.flat().join("")).toBe("Hello B");
        for (const input of [a, b]) {
          const call = h.calls.find((entry) => entry.text === input.messages[0].content);
          expect(call.model).toBe(input.model);
          if (!h.local) {
            expect(call.apiKey).toBe(input.apiKey);
            expect(call.signal).toBe(input.signal);
          }
        }
      } finally { releaseA(); releaseB(); await Promise.allSettled([pendingA, pendingB]); }
    });

    it.each(["http", "stream", "network"])("sanitizes %s failures without leaking credentials or arbitrary metadata", async (failure) => {
      h.setFailure(failure);
      const input = args();
      const error = await h.provider.streamChat(input).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "InferenceError", code: expect.stringMatching(/^(provider_error|unavailable)$/) });
      expect(error.message).not.toContain(keyA);
      expect(error.message).not.toContain("private-debug-field");
      expect(error.message.length).toBeLessThanOrEqual(1200);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("request");
    });

    it("honors an already aborted signal before any provider work", async () => {
      const controller = new AbortController(); controller.abort();
      const input = args({ signal: controller.signal });
      await expect(h.provider.streamChat(input)).rejects.toMatchObject({ name: "InferenceError", code: "aborted" });
      expect(h.calls).toEqual([]);
      expect(input.onDelta).not.toHaveBeenCalled();
    });

    it("cancels one concurrent request without affecting the other", async () => {
      let release;
      h.setCompletionGate(new Promise((resolve) => { release = resolve; }));
      const controller = new AbortController();
      const a = args({ signal: controller.signal, messages: [{ role: "user", content: "A" }] });
      const b = args({ apiKey: keyB, model: h.otherModel, messages: [{ role: "user", content: "B" }] });
      const pendingA = h.provider.streamChat(a);
      const rejection = expect(pendingA).rejects.toMatchObject({ code: "aborted" });
      const pendingB = h.provider.streamChat(b);
      try {
        await vi.waitFor(() => {
          expect(a.onDelta).toHaveBeenCalled();
          expect(b.onDelta).toHaveBeenCalled();
        });
        controller.abort();
        await rejection;
        release();
        expect(await pendingB).toMatchObject({ model: h.otherModel, message: { content: "Hello B" } });
        expect(a.onDelta.mock.calls.flat().join("")).toBe("Hel");
        expect(b.signal.aborted).toBe(false);
      } finally { controller.abort(); release(); await Promise.allSettled([pendingA, pendingB]); }
    });

    it("cancels an unfinished stream and rejects instead of returning a successful result", async () => {
      h.setCompletionGate(new Promise(() => {}));
      const controller = new AbortController();
      const input = args({ signal: controller.signal });
      const result = h.provider.streamChat(input);
      const rejection = expect(result).rejects.toMatchObject({ code: "aborted" });
      await vi.waitFor(() => expect(input.onDelta).toHaveBeenCalled());
      controller.abort();
      await rejection;
      const count = input.onDelta.mock.calls.length;
      await Promise.resolve();
      expect(input.onDelta).toHaveBeenCalledTimes(count);
      expect(h.cancelled()).toBe(true);
    });
  });
}
