import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiProvider } from "../src/providers/gemini.js";
import { resolveProviderModels } from "../src/providers/registry.js";
import { DECISION_PAYLOAD_MAX_BYTES } from "../src/decisions.js";
import request from "./fixtures/system-one-request.json";
import systemOne from "./fixtures/system-one-response.json";
import fixture from "./fixtures/gemini-decisions-response.json";

const url = "https://generativelanguage.googleapis.com/v1beta/decisions";
const args = () => ({
  ...structuredClone(request),
  apiKey: "stored-key",
  model: "gemini-decision-1",
  signal: new AbortController().signal,
});
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture))));
afterEach(() => vi.unstubAllGlobals());

describe("Gemini Decisions", () => {
  it("offers the independent decision model without credentials or discovery I/O", async () => {
    expect(await resolveProviderModels(geminiProvider, { method: "decide" }))
      .toEqual([{ id: "gemini-decision-1", label: "Gemini Decision 1" }]);
    expect(geminiProvider.decisions.defaultModel).toBe("gemini-decision-1");
    expect((await resolveProviderModels(geminiProvider)).map(({ id }) => id))
      .not.toContain("gemini-decision-1");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("translates all three types and usage with header-only authentication", async () => {
    const input = args();
    input.questions.is_bug.criteria = { true: "Broken", false: "Working" };
    expect(await geminiProvider.decide(input)).toEqual({
      model: input.model, answers: systemOne.answers,
      usage: { inputTokens: 476, outputTokens: 0 },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
      method: "POST", redirect: "error", signal: input.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: JSON.stringify({ model: input.model, input: JSON.stringify(input.state), questions: {
        q0: { ...input.questions.is_bug, criteria: { true_description: "Broken", false_description: "Working" } },
        q1: { ...input.questions.team, criteria: {
          option_0: "account", option_1: "frontend: Rendering", option_2: "payments: Billing",
        } },
        q2: input.questions.urgency,
      } }),
    });
  });
  it.each(["plain text", ["JSON", { nested: true }], { type: "image", uri: "https://private.example/file" }])
    ("serializes state as data, never native media: %j", async (state) => {
      await geminiProvider.decide({ ...args(), state });
      expect(JSON.parse(fetch.mock.calls[0][1].body).input)
        .toBe(typeof state === "string" ? state : JSON.stringify(state));
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it("round-trips arbitrary question/choice keys without losing self-describing labels", async () => {
    const questions = JSON.parse('{"__proto__":{"type":"choice","instructions":"Which?","criteria":{" 🐈 ":null,"__proto__":"Prototype"}}}');
    fetch.mockResolvedValue(Response.json({ answers: { q0: {
      type: "choice", choice: "option_1", confidence: 1,
      probabilities: { option_0: 0, option_1: 1 },
    } } }));
    const result = await geminiProvider.decide({ ...args(), questions });
    expect(result.answers.__proto__.choice).toBe("__proto__");
    expect(Object.keys(result.answers.__proto__.probabilities)).toEqual([" 🐈 ", "__proto__"]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).questions.q0.criteria)
      .toEqual({ option_0: " 🐈 ", option_1: "__proto__: Prototype" });
  });
  it.each([undefined, "", "  "])("rejects absent credentials", async (apiKey) => {
    await expect(geminiProvider.decide({ ...args(), apiKey })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unknown models, invalid questions and empty score descriptions before I/O", async () => {
    await expect(geminiProvider.decide({ ...args(), model: "gemini-3.8-flash" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(geminiProvider.decide({ ...args(), questions: {} }))
      .rejects.toMatchObject({ code: "invalid_request" });
    const input = args(); input.questions.urgency.criteria[0] = "";
    expect(() => geminiProvider.preflightDecide(input)).toThrow(/non-empty/);
    await expect(geminiProvider.decide(input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds the translated body after nested JSON escaping", async () => {
    const input = args();
    const overhead = new TextEncoder().encode(JSON.stringify({ state: [""], questions: input.questions })).length;
    input.state = ['"'.repeat(Math.floor((DECISION_PAYLOAD_MAX_BYTES - overhead) / 2))];
    await expect(geminiProvider.decide(input)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("1 MB") });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    (body) => { delete body.answers.q0; },
    (body) => { body.answers.extra = body.answers.q0; },
    (body) => { body.answers.q0.noul = 2; },
    (body) => { body.answers.q0.confidence = -1; },
    (body) => { body.answers.q0.type = "choice"; },
    (body) => { body.answers.q1.choice = "option_0"; },
    (body) => { body.answers.q1.choice = "unknown"; },
    (body) => { body.answers.q1.probabilities.other = 0; },
    (body) => { delete body.answers.q1.probabilities.option_0; body.answers.q1.probabilities.other = 0; },
    (body) => { body.answers.q1.probabilities.option_0 = 0.4; },
    (body) => { body.answers.q2.score = 0; },
    (body) => { body.answers.q2.legend["0"] = "Changed"; },
    (body) => { body.usage.total_input_tokens = -1; },
    (body) => { body.usage.total_output_tokens = "0"; },
  ])("rejects malformed answers without fallback", async (mutate) => {
    const body = structuredClone(fixture); mutate(body);
    fetch.mockResolvedValue(Response.json(body));
    await expect(geminiProvider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[400, "invalid_request"], [413, "invalid_request"], [422, "invalid_request"], [401, "provider_error"], [403, "provider_error"], [429, "provider_error"], [404, "unavailable"], [503, "unavailable"]])
    ("maps HTTP %s with sanitized detail", async (status, code) => {
      fetch.mockResolvedValue(Response.json({ error: { code: "safety", message: "Blocked stored-key" } }, { status }));
      await expect(geminiProvider.decide(args())).rejects.toMatchObject({ code, message: expect.stringContaining("Blocked [redacted]") });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it("handles invalid JSON and network failure", async () => {
    fetch.mockResolvedValue(new Response("not JSON"));
    await expect(geminiProvider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    fetch.mockRejectedValue(new TypeError("offline"));
    await expect(geminiProvider.decide(args())).rejects.toMatchObject({ code: "unavailable" });
  });
  it("checks cancellation before I/O, during fetch and after JSON parsing", async () => {
    const pre = new AbortController(); pre.abort();
    await expect(geminiProvider.decide({ ...args(), signal: pre.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const assertion = expect(geminiProvider.decide({ ...args(), signal: active.signal })).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); active.abort(); await assertion;
    const late = new AbortController();
    fetch.mockResolvedValue({ ok: true, json: async () => { late.abort(); return fixture; } });
    await expect(geminiProvider.decide({ ...args(), signal: late.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
