import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_THINKING_BUDGETS,
  mapReasoningEffortForAnthropic,
  mapReasoningEffortForOllama,
  mapReasoningEffortForOpenAICompat,
} from "../src/providers/reasoning-effort.js";

describe("mapReasoningEffortForOpenAICompat", () => {
  it("omits auto and undefined", () => {
    expect(mapReasoningEffortForOpenAICompat(undefined)).toBeUndefined();
    expect(mapReasoningEffortForOpenAICompat("auto")).toBeUndefined();
  });

  it("passes through none / low / medium / high", () => {
    expect(mapReasoningEffortForOpenAICompat("none")).toBe("none");
    expect(mapReasoningEffortForOpenAICompat("low")).toBe("low");
    expect(mapReasoningEffortForOpenAICompat("medium")).toBe("medium");
    expect(mapReasoningEffortForOpenAICompat("high")).toBe("high");
  });
});

describe("mapReasoningEffortForAnthropic", () => {
  it("omits auto and undefined", () => {
    expect(mapReasoningEffortForAnthropic(undefined, 8192)).toBeUndefined();
    expect(mapReasoningEffortForAnthropic("auto", 8192)).toBeUndefined();
  });

  it("disables thinking for none", () => {
    expect(mapReasoningEffortForAnthropic("none", 8192)).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("enables thinking with budget tiers and bumps max_tokens when needed", () => {
    expect(mapReasoningEffortForAnthropic("low", 8192)).toEqual({
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_THINKING_BUDGETS.low,
      },
    });
    expect(mapReasoningEffortForAnthropic("medium", 8192)).toEqual({
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_THINKING_BUDGETS.medium,
      },
    });
    expect(mapReasoningEffortForAnthropic("high", 8192)).toEqual({
      thinking: {
        type: "enabled",
        budget_tokens: ANTHROPIC_THINKING_BUDGETS.high,
      },
      max_tokens: ANTHROPIC_THINKING_BUDGETS.high + 4096,
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
