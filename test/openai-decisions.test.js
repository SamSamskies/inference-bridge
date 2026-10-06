import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiProvider } from "../src/providers/openai.js";
import { resolveProviderModels } from "../src/providers/registry.js";
import { DECISION_PAYLOAD_MAX_BYTES } from "../src/decisions.js";
import request from "./fixtures/system-one-request.json";
import systemOne from "./fixtures/system-one-response.json";
import fixture from "./fixtures/openai-decisions-response.json";

const url = "https://api.openai.com/v1/decisions";
const args = () => ({
  ...structuredClone(request),
  apiKey: "stored-key",
  model: "gpt-6-luna",
  signal: new AbortController().signal,
});
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture))));
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI Decisions", () => {
  it("uses an independent catalog containing the documented Decisions model", async () => {
    expect(await resolveProviderModels(openaiProvider, { method: "decide" }))
      .toEqual([{ id: "gpt-6-luna" }]);
    expect(openaiProvider.decisions.defaultModel).toBe("gpt-6-luna");
    expect(openaiProvider.decisions.models).not.toBe(openaiProvider.models);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("translates the three primitives and JSON state, retaining typed answers and usage", async () => {
    const input = args();
    expect(await openaiProvider.decide(input)).toEqual({
      model: fixture.model,
      answers: systemOne.answers,
      usage: { inputTokens: 476, outputTokens: 0 },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer stored-key" },
      signal: input.signal,
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: JSON.stringify(request.state),
        questions: [
          { name: "is_bug", type: "predicate", instructions: request.questions.is_bug.instructions },
          {
            name: "team", type: "choice", instructions: request.questions.team.instructions,
            choices: [
              { value: "account" },
              { value: "frontend", description: "Rendering" },
              { value: "payments", description: "Billing" },
            ],
          },
          {
            name: "urgency", type: "score", instructions: request.questions.urgency.instructions,
            levels: request.questions.urgency.criteria.map((description, i) => ({ label: String(i), description })),
          },
        ],
      }),
    });
  });
  it.each(["plain text", ["JSON", { nested: true }]])("preserves string or array state %j", async (state) => {
    await openaiProvider.decide({ ...args(), state });
    expect(JSON.parse(fetch.mock.calls[0][1].body).input)
      .toBe(typeof state === "string" ? state : JSON.stringify(state));
  });
  it("retains optional true/false criteria in predicate instructions", async () => {
    const input = args();
    input.questions.is_bug.criteria = { true: "Broken functionality", false: "Feature request" };
    await openaiProvider.decide(input);
    const { questions } = JSON.parse(fetch.mock.calls[0][1].body);
    expect(questions[0].instructions).toContain(input.questions.is_bug.instructions);
    expect(questions[0].instructions).toContain(JSON.stringify(input.questions.is_bug.criteria));
  });
  it("preserves per-question refusals alongside successful answers", async () => {
    const body = structuredClone(fixture);
    body.answers[1] = { type: "refusal", name: "team" };
    fetch.mockResolvedValue(Response.json(body));
    const result = await openaiProvider.decide(args());
    expect(result.answers).toEqual({ ...systemOne.answers, team: { type: "refusal" } });
    expect(result.answers.team).not.toHaveProperty("confidence");
  });
  it("keeps boolean-looking choice keys as strings and handles prototype-like ids", async () => {
    const questions = JSON.parse('{"__proto__":{"type":"choice","instructions":"Which?","criteria":{"true":null,"false":"No"}}}');
    fetch.mockResolvedValue(Response.json({
      model: "gpt-6-luna",
      answers: [{ name: "__proto__", type: "choice", choice: "true", confidence: 1,
        probabilities: [{ value: "true", probability: 1 }, { value: "false", probability: 0 }] }],
    }));
    const result = await openaiProvider.decide({ ...args(), questions });
    expect(result.answers.__proto__.choice).toBe("true");
    expect(JSON.parse(fetch.mock.calls[0][1].body).questions[0].choices)
      .toEqual([{ value: "true" }, { value: "false", description: "No" }]);
  });
  it.each([undefined, "", "  "])("rejects a missing key before networking", async (apiKey) => {
    await expect(openaiProvider.decide({ ...args(), apiKey })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unsupported models and malformed requests without chat fallback", async () => {
    await expect(openaiProvider.decide({ ...args(), model: "gpt-6-astra" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(openaiProvider.decide({ ...args(), questions: {} }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds the translated body, including JSON escaping and question expansion", async () => {
    const input = args();
    // Nested JSON is encoded as text input, adding a second layer of escaping.
    const overhead = new TextEncoder().encode(JSON.stringify({ state: [""], questions: input.questions })).length;
    input.state = ['"'.repeat(Math.floor((DECISION_PAYLOAD_MAX_BYTES - overhead) / 2))];
    await expect(openaiProvider.decide(input)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("64 KiB") });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    (body) => { body.answers = {}; },
    (body) => { body.answers.pop(); },
    (body) => { body.answers.reverse(); },
    (body) => { body.answers[0].name = null; },
    (body) => { body.answers[0].type = "noul"; },
    (body) => { body.answers[0].probability = 2; },
    (body) => { body.answers[1].choice = true; },
    (body) => { body.answers[1].confidence = -1; },
    (body) => { body.answers[1].probabilities[0].value = true; },
    (body) => { body.answers[1].probabilities[0].value = "payments"; },
    (body) => { body.answers[1].probabilities[0].probability = 0.5; },
    (body) => { body.answers[2].probabilities[0].value = 0.5; },
    (body) => { body.answers[2].probabilities[0].label = "unexpected"; },
    (body) => { body.answers[2].probabilities[0].value = 1; body.answers[2].probabilities[0].label = "1"; },
    (body) => { body.answers[2].score = 3; },
    (body) => { body.answers[2].probabilities[0] = null; },
    (body) => { body.answers[1] = { type: "refusal", name: "unknown" }; },
    (body) => { body.model = ""; },
    (body) => { body.usage.input_tokens = -1; },
  ])("rejects malformed provider responses", async (mutate) => {
    const body = structuredClone(fixture);
    mutate(body);
    fetch.mockResolvedValue(Response.json(body));
    await expect(openaiProvider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[400, "invalid_request"], [413, "invalid_request"], [422, "invalid_request"], [401, "provider_error"], [429, "provider_error"], [404, "unavailable"], [503, "unavailable"]])
    ("maps HTTP %s without fallback", async (status, code) => {
      fetch.mockResolvedValue(Response.json({ error: { message: "Upstream detail" } }, { status }));
      await expect(openaiProvider.decide(args())).rejects.toMatchObject({ code, message: "Upstream detail" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it("handles invalid JSON and network failure", async () => {
    fetch.mockResolvedValue(new Response("not JSON"));
    await expect(openaiProvider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    fetch.mockRejectedValue(new TypeError("offline"));
    await expect(openaiProvider.decide(args())).rejects.toMatchObject({ code: "unavailable" });
  });
  it("aborts before fetch and during the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(openaiProvider.decide({ ...args(), signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const assertion = expect(openaiProvider.decide({ ...args(), signal: active.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    active.abort();
    await assertion;
  });
});
