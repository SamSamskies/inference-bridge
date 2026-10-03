import { installChromeMock } from "./helpers/chrome-mock.js";
import { getSettings, saveSettings } from "../src/storage.js";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/system-one-response.json";
import {
  DECISION_PAYLOAD_MAX_BYTES,
  decisionApprovalPreview,
  normalizeDecisionResponse,
} from "../src/decisions.js";
import {
  validateExperimentalInferenceRequest,
  validateInferenceRequest,
} from "../src/validate.js";

export const questions = {
  is_bug: { type: "noul", instructions: "Is this a software defect?" },
  team: {
    type: "choice",
    instructions: "Which team?",
    criteria: { account: null, frontend: "Rendering", payments: "Billing" },
  },
  urgency: {
    type: "score",
    instructions: "How urgent?",
    criteria: [
      "Can wait for the next release",
      "Should be fixed this week",
      "Blocking revenue right now",
    ],
  },
};
const request = (state = { ticket: "Checkout is blank" }) => ({
  method: "decide",
  state,
  questions,
});
const validate = validateExperimentalInferenceRequest;

describe("experimental decide validation", () => {
  it.each([
    "A ticket",
    { nested: [1, null, true, { text: "hi" }] },
    ["hi", {}],
  ])("accepts JSON state %j", (state) => {
    const result = validate(request(state));
    expect(result).toEqual({ ok: true, value: request(state) });
    expect(result.value.questions).not.toBe(questions);
    expect(validateInferenceRequest(request(state)).ok).toBe(false);
  });
  it.each([
    "provider",
    "model",
    "messages",
    "tools",
    "keep_alive",
    "output",
    "options",
    "stream",
  ])("rejects page field %s", (key) => {
    expect(validate({ ...request(), [key]: "bad" })).toMatchObject({
      ok: false,
      message: expect.stringContaining(key),
    });
  });
  it.each([
    undefined,
    null,
    1,
    true,
    "",
    "  ",
    { bad: undefined },
    { bad: NaN },
    { bad: Infinity },
    { bad: 1n },
    { bad: new Blob(["media"]) },
    { bad: new Date() },
    { bad: new Map() },
    { bad() {} },
    new Array(2),
  ])("rejects non-JSON or empty state", (state) => {
    expect(validate({ ...request(), state }).ok).toBe(false);
  });
  it("rejects cyclic and deeply nested state, but allows shared JSON references", () => {
    const cycle = {};
    cycle.self = cycle;
    expect(validate(request(cycle)).message).toMatch(/cycles/);
    let deep = {};
    for (let i = 0; i < 65; i++) deep = { child: deep };
    expect(validate(request(deep)).ok).toBe(false);
    const shared = { text: "same" };
    expect(validate(request({ a: shared, b: shared })).ok).toBe(true);
  });
  it.each([
    {},
    [],
    { "": questions.is_bug },
    { q: null },
    { q: { type: "noul", instructions: " " } },
    { q: { ...questions.is_bug, unknown: true } },
    { q: { ...questions.is_bug, criteria: { yes: "Yes" } } },
    { q: { ...questions.is_bug, criteria: { true: null } } },
    { q: { ...questions.team, criteria: { a: "One" } } },
    { q: { ...questions.team, criteria: { a: {}, b: null } } },
    { q: { ...questions.urgency, criteria: ["One"] } },
    { q: { ...questions.urgency, criteria: ["One", 2] } },
    { q: { ...questions.urgency, criteria: Array(11).fill("Level") } },
    { q: { type: "chat", instructions: "Hello" } },
  ])("rejects malformed questions %j", (value) => {
    expect(validate({ ...request(), questions: value }).ok).toBe(false);
  });
  it("bounds question/choice counts and measures UTF-8 bytes", () => {
    const many = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [String(i), questions.is_bug])
    );
    expect(validate({ ...request(), questions: many }).ok).toBe(true);
    expect(
      validate({
        ...request(),
        questions: { ...many, extra: questions.is_bug },
      }).ok
    ).toBe(false);
    const criteria = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [String(i), null])
    );
    expect(
      validate({
        ...request(),
        questions: { q: { ...questions.team, criteria } },
      }).ok
    ).toBe(true);
    criteria.extra = null;
    expect(
      validate({
        ...request(),
        questions: { q: { ...questions.team, criteria } },
      }).ok
    ).toBe(false);
    const overhead = new TextEncoder().encode(
      JSON.stringify({ state: "", questions })
    ).length;
    expect(
      validate(request("a".repeat(DECISION_PAYLOAD_MAX_BYTES - overhead))).ok
    ).toBe(true);
    expect(
      validate(request("a".repeat(DECISION_PAYLOAD_MAX_BYTES - overhead + 1)))
        .ok
    ).toBe(false);
    expect(validate(request("😀".repeat(17000))).ok).toBe(false);
  });
  it("keeps signal out of the wire snapshot and truncates approval state", () => {
    const value = validate({
      ...request("x".repeat(2000)),
      signal: new AbortController().signal,
    }).value;
    expect(value).not.toHaveProperty("signal");
    expect(decisionApprovalPreview(value)).toEqual({
      stateSummary: `${"x".repeat(1200)}…`,
      questionSummaries: [
        { id: "is_bug", type: "noul" },
        { id: "team", type: "choice" },
        { id: "urgency", type: "score" },
      ],
    });
  });
});

describe("System One response mapping", () => {
  it("preserves all three typed primitives and maps usage without a chat message", () => {
    expect(normalizeDecisionResponse(fixture, questions)).toEqual({
      model: fixture.model,
      answers: fixture.answers,
      usage: { inputTokens: 476, outputTokens: 70 },
    });
    expect(
      normalizeDecisionResponse(
        { model: "nimble", answers: fixture.answers },
        questions
      )
    ).not.toHaveProperty("usage");
  });
  it.each([
    (body) => {
      delete body.answers.is_bug;
    },
    (body) => {
      body.answers.extra = body.answers.is_bug;
    },
    (body) => {
      body.answers.is_bug.type = "choice";
    },
    (body) => {
      body.answers.is_bug.noul = 2;
    },
    (body) => {
      body.answers.team.choice = "unknown";
    },
    (body) => {
      body.answers.team.confidence = NaN;
    },
    (body) => {
      body.answers.team.probabilities = { payments: 1 };
    },
    (body) => {
      body.answers.team.probabilities.frontend = 0.9;
    },
    (body) => {
      body.answers.urgency.score = 3;
    },
    (body) => {
      body.answers.urgency.legend["0"] = null;
    },
    (body) => {
      body.usage.input_tokens = -1;
    },
    (body) => {
      body.model = "";
    },
  ])("rejects malformed provider answers", (mutate) => {
    const body = structuredClone(fixture);
    mutate(body);
    expect(() => normalizeDecisionResponse(body, questions)).toThrow(
      expect.objectContaining({ code: "provider_error" })
    );
  });
});

describe("decisions settings", () => {
  it("keeps decisions defaults separate from speech and chat", async () => {
    installChromeMock();
    await saveSettings({
      experimentalSpeechEnabled: true,
      operationDefaults: {
        transcribe: { providerId: "openai", model: "gpt-4o-mini-transcribe" },
      },
    });
    await saveSettings({
      operationDefaults: {
        decide: { providerId: "openrouter", model: "typesafe/jev-1.13" },
      },
    });
    const settings = await getSettings();
    expect(settings.experimentalSpeechEnabled).toBe(true);
    expect(settings.defaultProviderId).toBe("openai");
    expect(settings.operationDefaults).toEqual({
      transcribe: { providerId: "openai", model: "gpt-4o-mini-transcribe" },
      decide: { providerId: "openrouter", model: "typesafe/jev-1.13" },
    });
    await saveSettings({ operationDefaults: { decide: null } });
    expect((await getSettings()).operationDefaults).not.toHaveProperty(
      "decide"
    );
    expect((await getSettings()).operationDefaults.transcribe).toBeDefined();
  });
});
