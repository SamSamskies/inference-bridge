import { describe, expect, it } from "vitest";
import {
  fallbackOpenAICompatReasoningEffort,
  isUnsupportedReasoningEffortError,
  mapReasoningEffortForAnthropic,
  mapReasoningEffortForOllama,
  mapReasoningEffortForOpenAICompat,
  nextOpenAICompatReasoningEffortAfterError,
  parseSupportedReasoningEfforts,
} from "../src/providers/reasoning-effort.js";

describe("mapReasoningEffortForOpenAICompat", () => {
  it("omits auto and undefined", () => {
    expect(mapReasoningEffortForOpenAICompat(undefined)).toBeUndefined();
    expect(mapReasoningEffortForOpenAICompat("auto")).toBeUndefined();
  });

  it("maps none from the OpenAI model id; passes through low / medium / high", () => {
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-5-nano")).toBe(
      "minimal"
    );
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-5-mini")).toBe(
      "minimal"
    );
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-5.4")).toBe("none");
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-5.4-nano")).toBe(
      "none"
    );
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-5.6-luna")).toBe(
      "none"
    );
    expect(mapReasoningEffortForOpenAICompat("none", "openai/gpt-5-nano")).toBe(
      "minimal"
    );
    expect(mapReasoningEffortForOpenAICompat("none", "gpt-4o")).toBeUndefined();
    expect(mapReasoningEffortForOpenAICompat("none", "unknown-model")).toBe(
      "none"
    );
    expect(mapReasoningEffortForOpenAICompat("low", "gpt-5-nano")).toBe("low");
    expect(mapReasoningEffortForOpenAICompat("medium")).toBe("medium");
    expect(mapReasoningEffortForOpenAICompat("high")).toBe("high");
  });
});

describe("mapReasoningEffortForAnthropic", () => {
  it("omits auto and undefined", () => {
    expect(mapReasoningEffortForAnthropic(undefined)).toBeUndefined();
    expect(mapReasoningEffortForAnthropic("auto")).toBeUndefined();
  });

  it("disables thinking for none on models that allow it", () => {
    expect(mapReasoningEffortForAnthropic("none", "claude-sonnet-5")).toEqual({
      thinking: { type: "disabled" },
    });
    expect(
      mapReasoningEffortForAnthropic("none", "claude-fable-5")
    ).toBeUndefined();
  });

  it("enables adaptive thinking with output_config.effort on Claude 4.6+", () => {
    expect(mapReasoningEffortForAnthropic("low", "claude-sonnet-5")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(mapReasoningEffortForAnthropic("medium", "claude-sonnet-4-6")).toEqual(
      {
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      }
    );
    expect(mapReasoningEffortForAnthropic("high", "claude-opus-5")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
  });

  it("uses extended thinking budgets on Claude 4.5 (Haiku)", () => {
    expect(mapReasoningEffortForAnthropic("low", "claude-haiku-4-5")).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(mapReasoningEffortForAnthropic("high", "claude-haiku-4-5")).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(mapReasoningEffortForAnthropic("none", "claude-haiku-4-5")).toEqual({
      thinking: { type: "disabled" },
    });
  });
});

describe("mapReasoningEffortForOllama", () => {
  it("omits auto and undefined", () => {
    expect(mapReasoningEffortForOllama(undefined)).toBeUndefined();
    expect(mapReasoningEffortForOllama("auto")).toBeUndefined();
  });

  it("maps none to false and levels to strings", () => {
    expect(mapReasoningEffortForOllama("none")).toBe(false);
    expect(mapReasoningEffortForOllama("low")).toBe("low");
    expect(mapReasoningEffortForOllama("medium")).toBe("medium");
    expect(mapReasoningEffortForOllama("high")).toBe("high");
  });
});

const NANO_NONE_ERROR =
  "Unsupported value: 'none' is not supported with the 'gpt-5-nano' model. Supported values are: 'minimal', 'low', 'medium', and 'high'.";

describe("OpenAI-compat reasoning-effort retry helpers", () => {
  it("detects OpenAI unsupported-effort 400s only", () => {
    expect(isUnsupportedReasoningEffortError(400, NANO_NONE_ERROR)).toBe(true);
    expect(isUnsupportedReasoningEffortError(401, NANO_NONE_ERROR)).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(400, "status 400")
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(
        400,
        "Unsupported value: 'none' is not supported for parameter 'tool_choice'."
      )
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(
        400,
        "Unsupported value: 'web_search' is not supported with this model for 'tools'."
      )
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(
        400,
        "Unsupported value: '0.2' is not supported with this model. Temperature is not supported."
      )
    ).toBe(false);
  });

  it("parses quoted efforts and prefers the next-lowest after none", () => {
    expect(parseSupportedReasoningEfforts(NANO_NONE_ERROR)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(fallbackOpenAICompatReasoningEffort("none", NANO_NONE_ERROR)).toBe(
      "minimal"
    );
    expect(
      fallbackOpenAICompatReasoningEffort(
        "none",
        "Unsupported value: 'none' is not supported"
      )
    ).toBeUndefined();
  });

  it("retries with minimal for the nano error; does not retry unrelated 400s", () => {
    expect(
      nextOpenAICompatReasoningEffortAfterError(400, NANO_NONE_ERROR, "none")
    ).toEqual({ retry: true, effort: "minimal" });
    expect(
      nextOpenAICompatReasoningEffortAfterError(400, "status 400", "none")
    ).toEqual({ retry: false });
    expect(
      nextOpenAICompatReasoningEffortAfterError(
        400,
        "Unsupported value: 'none' is not supported for parameter 'tool_choice'.",
        "none"
      )
    ).toEqual({ retry: false });
    expect(
      nextOpenAICompatReasoningEffortAfterError(400, NANO_NONE_ERROR, undefined)
    ).toEqual({ retry: false });
  });
});
