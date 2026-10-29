import { afterEach, describe, expect, it, vi } from "vitest";
import { getOllamaThinking } from "../src/providers/ollama.js";
import {
  mapReasoningEffortForOllama, ollamaThinkingGuidance, parseOllamaThinking,
} from "../src/providers/ollama-thinking.js";
import { createThinkingGuidance } from "../ui/ollama-thinking-guidance.js";

const beam = { values: ["max", "high", "low", "xhigh", "medium"], default: "max" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("thinking metadata", () => {
  it.each([
    undefined, null, [], {}, { capabilities: ["thinking"] },
    { thinking: null }, { thinking: { values: [] } },
    { thinking: { values: "false" } }, { thinking: { values: [false, 0] } },
    { thinking: { values: [false, null] } }, { thinking: { values: [""] } },
    { thinking: { values: [" "] } }, { thinking: { values: ["low"], default: "max" } },
    { thinking: { values: ["x".repeat(65)] } },
  ])("treats malformed or missing metadata as unknown: %j", (payload) => {
    expect(parseOllamaThinking(payload)).toBeUndefined();
  });

  it("preserves exact supported names, booleans and the default", () => {
    expect(parseOllamaThinking({ thinking: { values: [true, false, true], default: false } }))
      .toEqual({ values: [true, false], default: false });
    expect(parseOllamaThinking({ thinking: beam })).toEqual(beam);
  });

  it("keeps Auto unset even when the advertised default is Max", () => {
    expect(mapReasoningEffortForOllama("auto", beam)).toBeUndefined();
    expect(mapReasoningEffortForOllama(undefined, beam)).toBeUndefined();
    expect(ollamaThinkingGuidance(beam)).toContain("Auto uses the model default (Max)");
  });

  it("uses the lowest supported recognized effort, independent of array order", () => {
    expect(mapReasoningEffortForOllama("none", beam)).toBe("low");
    expect(mapReasoningEffortForOllama("none", { values: ["max", "high"] })).toBe("high");
    expect(mapReasoningEffortForOllama("none", { values: ["high", "minimal"] })).toBe("minimal");
    expect(mapReasoningEffortForOllama("low", { values: ["medium", "high"] })).toBeUndefined();
    expect(mapReasoningEffortForOllama("none", { values: [false, "low"] })).toBe(false);
  });

  it("does not invent an ordering for model-defined names or an off mode", () => {
    expect(mapReasoningEffortForOllama("none", { values: ["custom", "low"] })).toBeUndefined();
    expect(mapReasoningEffortForOllama("none", { values: [true] })).toBeUndefined();
    expect(ollamaThinkingGuidance({ values: [true] })).toContain("does not advertise an off control");
    expect(ollamaThinkingGuidance(undefined)).toContain("could not be verified");
    expect(ollamaThinkingGuidance({ values: [false], default: false })).toContain("no thinking support");
  });
});

describe("fresh optional metadata probes", () => {
  it("never reuses another model's metadata, or stale metadata for the same model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ thinking: beam }))
      .mockResolvedValueOnce(Response.json({ thinking: { values: [false, true] } }))
      .mockResolvedValueOnce(Response.json({ thinking: { values: [false] } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getOllamaThinking("beam:cloud")).toEqual(beam);
    expect(await getOllamaThinking("qwen3")).toEqual({ values: [false, true] });
    expect(await getOllamaThinking("beam:cloud")).toEqual({ values: [false] });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).model))
      .toEqual(["beam:cloud", "qwen3", "beam:cloud"]);
  });

  it.each(["http", "json", "network"])("degrades gracefully on %s failures", async (failure) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("offline");
      return new Response("bad", { status: failure === "http" ? 404 : 200 });
    }));
    expect(await getOllamaThinking("old-model")).toBeUndefined();
  });

  it.each([false, true])("bounds the probe and preserves caller cancellation (cancel: %s)", async (cancel) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetching = vi.fn(async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetching);
    const result = getOllamaThinking("slow", { signal: controller.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) controller.abort();
    else await vi.advanceTimersByTimeAsync(3000);
    if (cancel) expect((await result).error).toMatchObject({ code: "aborted" });
    else expect(await result).toEqual({ value: undefined });
  });
});

describe("approval thinking guidance", () => {
  const route = { method: "chat", providerId: "ollama", model: "beam:cloud", ready: true };
  it("follows the selected model and clears stale replies after route changes", async () => {
    const hint = {};
    let reply;
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }))
      .mockResolvedValueOnce({ ok: true, thinking: { values: [false, true], default: true } });
    const refresh = createThinkingGuidance(hint, send);
    const first = refresh(route);
    await refresh({ ...route, model: "qwen3" });
    expect(hint.textContent).toContain("None requests thinking off");
    expect(send).toHaveBeenLastCalledWith({ type: "ollama-thinking", model: "qwen3" });
    reply({ ok: true, thinking: beam });
    await first;
    expect(hint.textContent).not.toContain("lowest supported effort");
    await refresh({ ...route, providerId: "openai" });
    expect(hint).toMatchObject({ hidden: true, textContent: "" });
  });

  it("invalidates in-flight replies while models load or another method is selected", async () => {
    const hint = {};
    let reply;
    const send = vi.fn(() => new Promise((resolve) => { reply = resolve; }));
    const refresh = createThinkingGuidance(hint, send);
    const first = refresh(route);
    await refresh({ ...route, ready: false });
    reply({ ok: true, thinking: beam });
    await first;
    expect(hint).toMatchObject({ hidden: true, textContent: "" });
    await refresh({ ...route, method: "decide" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([beam, undefined, { values: [false, 42] }])("shows accurate None/default guidance (%j)", async (thinking) => {
    const hint = {};
    await createThinkingGuidance(hint, async () => ({ ok: true, thinking }))(route);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(ollamaThinkingGuidance(parseOllamaThinking({ thinking })));
  });

  it("shows unknown controls if the worker is unavailable", async () => {
    const hint = {};
    await createThinkingGuidance(hint, async () => { throw new Error("disconnected"); })(route);
    expect(hint.textContent).toContain("could not be verified");
  });
});
