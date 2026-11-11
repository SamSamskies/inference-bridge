import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { DECISION_LIMITS, assertDecisionBodyLimit, decisionQuestionLimitMessage } from "../src/providers/decision-limits.js";
import { DECISION_PAYLOAD_MAX_BYTES } from "../src/decisions.js";
import { decisionApiSchema } from "../src/decision-api-core.js";
import openrouterCatalog from "./fixtures/openrouter-decisions-models.json";
import ppqCatalog from "./fixtures/ppq-decisions-models.json";

const question = { type: "noul", instructions: "Is the input ready?" };
const questions = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`question_${i}`, question]));
const cases = [
  ["gemini", "gemini-decision-1", 1000],
  ["openai", "gpt-6-luna", 400],
  ["openrouter", "typesafe/jev-1.13", 1000],
  ["ppq", "typesafe/jev-1.13", 1000],
  ["ollama", "nimble:latest", 64],
  ["ollama-cloud", "clef:27b", 64],
];
let getProvider;
function nativeResponse(url, options) {
  const body = JSON.parse(options.body);
  if (url === "https://api.openai.com/v1/decisions") return {
    model: body.model,
    answers: body.questions.map(({ name }) => ({ name, type: "predicate", probability: 0.8 })),
  };
  return {
    model: body.model,
    answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, {
      type: "noul", noul: 0.8,
      ...(url.includes("generativelanguage") ? { confidence: 0.8 } : {}),
    }])),
  };
}
beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  getProvider = (await import("../src/providers/registry.js")).getProvider;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (url.endsWith("?output_modalities=decisions")) return Response.json(openrouterCatalog);
    if (url.endsWith("/decisions/models")) return Response.json(ppqCatalog);
    if (url.endsWith("/api/show")) return Response.json({ capabilities: ["decision"], details: { format: "gguf" } });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "nimble:latest" }] });
    return Response.json(nativeResponse(url, options));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(cases)("%s decision request limits", (providerId, model, maximum) => {
  const args = (count, extra = {}) => ({
    apiKey: "test-key", signal: new AbortController().signal, model,
    state: "Ready", questions: questions(count), ...extra,
  });
  it("completes its maximum batch in one inference call without dropping questions", async () => {
    const provider = getProvider(providerId);
    expect(provider.decisions.maxQuestions).toBe(maximum);
    const result = await provider.decide(args(maximum));
    expect(Object.keys(result.answers)).toEqual(Object.keys(questions(maximum)));
    expect(Object.values(result.answers).every((answer) => answer.noul === 0.8)).toBe(true);
    const inferenceCalls = fetch.mock.calls.filter(([url]) => /\/decisions$|\/systemone$/.test(url));
    expect(inferenceCalls).toHaveLength(1);
    expect(Object.keys(JSON.parse(inferenceCalls[0][1].body).questions)).toHaveLength(maximum);
  });
  it("rejects one question above its maximum before networking", async () => {
    await expect(getProvider(providerId).decide(args(maximum + 1)))
      .rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining(String(maximum)) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("applies a route-specific body limit", async () => {
    const input = args(1, { state: "x".repeat(100 * 1024) });
    if (providerId === "ollama") {
      await expect(getProvider(providerId).decide(input)).rejects.toMatchObject({
        code: "invalid_request", message: expect.stringContaining("64 KiB"),
      });
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/v1/systemone"))).toBe(false);
    } else {
      const result = await getProvider(providerId).decide(input);
      expect(result.answers.question_0.noul).toBe(0.8);
    }
  });
  it("maps upstream request limits to invalid_request without retrying or splitting", async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => /\/decisions$|\/systemone$/.test(url)
      ? Response.json({ error: { message: "Input exceeds the model context limit" } }, { status: 413 })
      : original(url, options));
    await expect(getProvider(providerId).decide(args(1))).rejects.toMatchObject({
      code: "invalid_request", message: expect.stringContaining("context limit"),
    });
    expect(fetch.mock.calls.filter(([url]) => /\/decisions$|\/systemone$/.test(url))).toHaveLength(1);
  });
});

it("retains the native on-device limit of 16", () => {
  expect(decisionApiSchema(questions(16)).questions).toHaveLength(16);
  expect(() => decisionApiSchema(questions(17))).toThrow(/16 questions/);
});
it("uses the same provider descriptor in approval messages and enforces exact UTF-8 body sizes", () => {
  expect(decisionQuestionLimitMessage("OpenAI", DECISION_LIMITS.openai.maxQuestions, 400)).toBe("");
  expect(decisionQuestionLimitMessage("OpenAI", DECISION_LIMITS.openai.maxQuestions, 401)).toContain("400");
  const body = "😀".repeat(DECISION_PAYLOAD_MAX_BYTES / 4);
  expect(() => assertDecisionBodyLimit("Provider", DECISION_PAYLOAD_MAX_BYTES, body)).not.toThrow();
  expect(() => assertDecisionBodyLimit("Provider", DECISION_PAYLOAD_MAX_BYTES, body + "a")).toThrow(/1024 KiB/);
});
