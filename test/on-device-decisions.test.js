import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import request from "./fixtures/system-one-request.json";
import fixture from "./fixtures/system-one-response.json";
import {
  decisionApiSchema, decideWithDecisionModel, installDecisionModel,
  normalizeNativeDecisions, probeDecisionModelAvailability,
} from "../src/decision-api-core.js";

const nativeResult = () => ({
  is_bug: { id: "is_bug", label: "true", probabilities: { true: 0.96, false: 0.04 }, confidence: 0.96 },
  team: { id: "team", label: "payments", probabilities: fixture.answers.team.probabilities, confidence: 0.75 },
  urgency: { id: "urgency", label: "2", probabilities: fixture.answers.urgency.probabilities, confidence: 0.99, expectedScore: 1.99 },
});
const signal = () => new AbortController().signal;
const args = () => ({ ...structuredClone(request), model: "on-device", signal: signal() });
function nativeModel() {
  const session = { decide: vi.fn(async () => nativeResult()), destroy: vi.fn() };
  return { availability: vi.fn(async () => "available"), create: vi.fn(async () => session), session };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Chrome DecisionModel translation", () => {
  it("preserves criteria, null descriptions, and zero-based score labels", () => {
    const questions = structuredClone(request.questions);
    questions.is_bug.criteria = { true: "Has a defect", false: "Feature request" };
    const schema = decisionApiSchema(questions);
    expect(schema.questions).toEqual([
      { id: "is_bug", type: "boolean", prompt: expect.stringContaining(JSON.stringify(questions.is_bug.criteria)) },
      { id: "team", type: "choice", prompt: "Which team?", options: [
        { label: "account" }, { label: "frontend", description: "Rendering" }, { label: "payments", description: "Billing" },
      ] },
      { id: "urgency", type: "score", prompt: "How urgent?", options: request.questions.urgency.criteria.map((description, i) => ({ label: String(i), description })) },
    ]);
    expect(schema.questions[0]).not.toHaveProperty("options");
    expect(normalizeNativeDecisions(nativeResult(), questions)).toEqual({ model: "on-device", answers: fixture.answers });
  });

  it("passes JSON state and AbortSignals to the native session, then destroys it", async () => {
    const DM = nativeModel();
    const input = args();
    expect(await decideWithDecisionModel({ ...input, DecisionModel: DM })).toEqual({ model: "on-device", answers: fixture.answers });
    expect(DM.create).toHaveBeenCalledWith({ ...decisionApiSchema(request.questions), signal: input.signal });
    expect(DM.session.decide).toHaveBeenCalledWith(JSON.stringify(request.state), { signal: input.signal });
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });

  it("keeps string state verbatim", async () => {
    const DM = nativeModel();
    await decideWithDecisionModel({ ...args(), state: "text input", DecisionModel: DM });
    expect(DM.session.decide.mock.calls[0][0]).toBe("text input");
  });

  it.each(["missing", "unavailable", "downloadable", "downloading"])("fails closed for %s without creating or downloading", async (status) => {
    const DM = nativeModel();
    DM.availability.mockResolvedValue(status);
    const input = { ...args(), DecisionModel: status === "missing" ? undefined : DM };
    await expect(decideWithDecisionModel(input)).rejects.toMatchObject({ code: "unavailable" });
    expect(DM.create).not.toHaveBeenCalled();
  });

  it("does not depend on LanguageModel and treats failed probes as unavailable", async () => {
    expect(await probeDecisionModelAvailability({})).toBe("missing");
    expect(await probeDecisionModelAvailability({ DecisionModel: { availability: async () => { throw Error("failure"); } } })).toBe("unavailable");
    expect(await probeDecisionModelAvailability({ DecisionModel: nativeModel() })).toBe("available");
  });

  it("rejects invalid requests and the native 16-question limit before model access", async () => {
    const DM = nativeModel();
    for (const input of [
      { ...args(), state: "" },
      { ...args(), questions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, request.questions.is_bug])) },
    ]) await expect(decideWithDecisionModel({ ...input, DecisionModel: DM })).rejects.toMatchObject({ code: "invalid_request" });
    expect(DM.availability).not.toHaveBeenCalled();
    expect(DM.create).not.toHaveBeenCalled();
  });

  it.each([
    (r) => { delete r.team; },
    (r) => { r.extra = r.team; },
    (r) => { r.team.id = "wrong"; },
    (r) => { r.team.label = "account"; },
    (r) => { r.team.probabilities = { account: 0, frontend: 0.16, impostor: 0.84 }; },
    (r) => { r.is_bug.probabilities.false = 0.8; },
    (r) => { r.is_bug.probabilities.true = NaN; },
    (r) => { r.is_bug.confidence = Infinity; },
    (r) => { r.urgency.expectedScore = 0.1; },
  ])("rejects malformed native results and still destroys the session (%#)", async (mutate) => {
    const DM = nativeModel();
    const result = nativeResult();
    mutate(result);
    DM.session.decide.mockResolvedValue(result);
    await expect(decideWithDecisionModel({ ...args(), DecisionModel: DM })).rejects.toMatchObject({ code: "provider_error" });
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });

  it.each([["QuotaExceededError", "invalid_request"], ["TypeError", "invalid_request"], ["NotSupportedError", "unavailable"], ["AbortError", "aborted"]])("maps native %s", async (name, code) => {
    const DM = nativeModel();
    DM.session.decide.mockRejectedValue(Object.assign(Error("Native limit"), { name }));
    await expect(decideWithDecisionModel({ ...args(), DecisionModel: DM })).rejects.toMatchObject({ code });
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a pre-aborted call and a late successful result after cancellation", async () => {
    const DM = nativeModel();
    const controller = new AbortController();
    controller.abort();
    await expect(decideWithDecisionModel({ ...args(), DecisionModel: DM, signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(DM.create).not.toHaveBeenCalled();
    const active = new AbortController();
    DM.session.decide.mockImplementation(async () => { active.abort(); return nativeResult(); });
    await expect(decideWithDecisionModel({ ...args(), DecisionModel: DM, signal: active.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });

  it("starts installation synchronously, reports progress and cleans up", async () => {
    const DM = nativeModel();
    const onProgress = vi.fn();
    DM.create.mockImplementation(async ({ monitor }) => {
      monitor({ addEventListener: (type, fn) => { expect(type).toBe("downloadprogress"); fn({ loaded: 0.5 }); } });
      return DM.session;
    });
    const pending = installDecisionModel({ DecisionModel: DM, onProgress });
    expect(DM.create).toHaveBeenCalledOnce();
    expect(DM.availability).not.toHaveBeenCalled();
    await pending;
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });
});

describe("DecisionModel offscreen relay", () => {
  let provider, DM, listeners;
  beforeEach(async () => {
    vi.resetModules();
    installChromeMock();
    listeners = new Set();
    chrome.runtime.onMessage = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
    chrome.runtime.getContexts = async () => [{}];
    chrome.runtime.sendMessage = vi.fn((message) => new Promise((resolve) => {
      const wire = JSON.parse(JSON.stringify(message));
      let pending = false;
      for (const listener of listeners) {
        if (listener(wire, {}, (value) => resolve(JSON.parse(JSON.stringify(value)))) === true) pending = true;
      }
      if (!pending) resolve(undefined);
    }));
    DM = nativeModel();
    vi.stubGlobal("DecisionModel", DM);
    vi.stubGlobal("LanguageModel", undefined);
    await import("../offscreen/prompt-api.js");
    provider = (await import("../src/providers/on-device.js")).onDeviceProvider;
  });

  it("discovers and runs decisions independently from the chat model through Chrome JSON messaging", async () => {
    expect(await provider.decisions.listModels()).toMatchObject([{ id: "on-device", outputModalities: ["decisions"] }]);
    await provider.preflightDecide(args());
    expect(await provider.decide(args())).toEqual({ model: "on-device", answers: fixture.answers });
    expect(DM.session.destroy).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);
  });

  it("offers installation for downloadable models but blocks execution and stale models", async () => {
    DM.availability.mockResolvedValue("downloadable");
    expect(await provider.decisions.listModels()).toHaveLength(1);
    await expect(provider.preflightDecide(args())).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Options → Decisions") });
    await expect(provider.decide({ ...args(), model: "chat-model" })).rejects.toMatchObject({ code: "unavailable" });
    expect(DM.create).not.toHaveBeenCalled();
  });

  it("forwards abort to the native session and suppresses done", async () => {
    DM.session.decide.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const pending = provider.decide({ ...args(), signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(DM.session.decide).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(DM.session.decide.mock.calls[0][1].signal.aborted).toBe(true);
    expect(DM.session.destroy).toHaveBeenCalledOnce();
  });

  it("honors an abort received before the native request is registered", async () => {
    const target = "prompt-api-offscreen";
    await chrome.runtime.sendMessage({ target, type: "prompt-api-abort-stream", requestId: "early" });
    expect(await chrome.runtime.sendMessage({ target, type: "decision-api-decide", requestId: "early", ...request }))
      .toMatchObject({ ok: false, code: "aborted" });
    expect(DM.create).not.toHaveBeenCalled();
  });
});
