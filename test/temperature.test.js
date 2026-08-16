import { describe, expect, it } from "vitest";
import {
  mapTemperatureForAnthropic,
  mapTemperatureForOllama,
  mapTemperatureForOpenAICompat,
} from "../src/providers/temperature.js";

describe("mapTemperatureForOpenAICompat", () => {
  it("omits undefined", () => {
    expect(mapTemperatureForOpenAICompat(undefined)).toBeUndefined();
  });

  it("passes through values in [0, 2]", () => {
    expect(mapTemperatureForOpenAICompat(0)).toBe(0);
    expect(mapTemperatureForOpenAICompat(0.7)).toBe(0.7);
    expect(mapTemperatureForOpenAICompat(2)).toBe(2);
  });
});

describe("mapTemperatureForAnthropic", () => {
  it("omits undefined", () => {
    expect(mapTemperatureForAnthropic(undefined)).toBeUndefined();
  });

  it("passes through values in [0, 1] and clamps above 1", () => {
    expect(mapTemperatureForAnthropic(0)).toBe(0);
    expect(mapTemperatureForAnthropic(0.5)).toBe(0.5);
    expect(mapTemperatureForAnthropic(1)).toBe(1);
    expect(mapTemperatureForAnthropic(1.5)).toBe(1);
    expect(mapTemperatureForAnthropic(2)).toBe(1);
  });
});

describe("mapTemperatureForOllama", () => {
  it("omits undefined", () => {
    expect(mapTemperatureForOllama(undefined)).toBeUndefined();
  });

  it("passes through values in [0, 2]", () => {
    expect(mapTemperatureForOllama(0.3)).toBe(0.3);
    expect(mapTemperatureForOllama(2)).toBe(2);
  });
});
