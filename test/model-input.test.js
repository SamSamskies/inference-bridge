import { describe, expect, it } from "vitest";
import {
  COMPAT_MODEL_AUTOSUGGEST_THRESHOLD,
  isModelValid,
  usesModelAutosuggest,
} from "../ui/model-input.js";

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
  it("is always enabled for OpenRouter", () => {
    expect(usesModelAutosuggest("openrouter")).toBe(true);
    expect(usesModelAutosuggest("openrouter", [{ id: "a" }])).toBe(true);
  });

  it("uses a select for compat:* when the catalog is small", () => {
    expect(usesModelAutosuggest("compat:abc", [{ id: "local" }])).toBe(false);
    const atThreshold = Array.from(
      { length: COMPAT_MODEL_AUTOSUGGEST_THRESHOLD },
      (_, i) => ({ id: `m${i}` })
    );
    expect(usesModelAutosuggest("compat:abc", atThreshold)).toBe(false);
  });

  it("uses autosuggest for compat:* when the catalog is large", () => {
    const large = Array.from(
      { length: COMPAT_MODEL_AUTOSUGGEST_THRESHOLD + 1 },
      (_, i) => ({ id: `m${i}` })
    );
    expect(usesModelAutosuggest("compat:abc", large)).toBe(true);
  });

  it("uses free-text for compat:* when the catalog is empty or unknown", () => {
    expect(usesModelAutosuggest("compat:abc")).toBe(true);
    expect(usesModelAutosuggest("compat:abc", [])).toBe(true);
  });

  it("is disabled for OpenAI and Ollama", () => {
    expect(usesModelAutosuggest("openai")).toBe(false);
    expect(usesModelAutosuggest("ollama")).toBe(false);
  });
});
