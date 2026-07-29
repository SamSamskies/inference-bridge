import { describe, expect, it } from "vitest";
import { isModelValid, usesModelAutosuggest } from "../ui/model-input.js";

describe("isModelValid", () => {
  const models = [
    { id: "gpt-4o-mini" },
    { id: "anthropic/claude-opus-5", label: "Anthropic: Claude Opus 5" },
    { id: "openrouter/free", label: "Free Models Router" },
  ];

  it("rejects blank values", () => {
    expect(isModelValid("", models)).toBe(false);
    expect(isModelValid("   ", models)).toBe(false);
    expect(isModelValid(undefined, models)).toBe(false);
  });

  it("accepts known ids regardless of allowUnknown", () => {
    expect(isModelValid("openrouter/free", models, { allowUnknown: false })).toBe(
      true
    );
    expect(isModelValid("openrouter/free", models, { allowUnknown: true })).toBe(
      true
    );
  });

  it("accepts unknown values when allowUnknown is true", () => {
    expect(
      isModelValid("openai/gpt-custom", models, { allowUnknown: true })
    ).toBe(true);
  });

  it("rejects unknown values when allowUnknown is false", () => {
    expect(
      isModelValid("not-installed", models, { allowUnknown: false })
    ).toBe(false);
  });
});

describe("usesModelAutosuggest", () => {
  it("is only enabled for OpenRouter", () => {
    expect(usesModelAutosuggest("openrouter")).toBe(true);
    expect(usesModelAutosuggest("openai")).toBe(false);
    expect(usesModelAutosuggest("ollama")).toBe(false);
  });
});
