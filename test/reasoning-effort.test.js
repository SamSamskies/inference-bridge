import { describe, expect, it } from "vitest";
import {
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
    expect(mapReasoningEffortForAnthropic(undefined)).toBeUndefined();
    expect(mapReasoningEffortForAnthropic("auto")).toBeUndefined();
  });

  it("disables thinking for none", () => {
    expect(mapReasoningEffortForAnthropic("none")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("enables adaptive thinking with output_config.effort", () => {
    expect(mapReasoningEffortForAnthropic("low")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(mapReasoningEffortForAnthropic("medium")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(mapReasoningEffortForAnthropic("high")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
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
