import { describe, expect, it } from "vitest";
import {
  isUnsupportedTemperatureError,
  mapTemperatureForAnthropic,
  mapTemperatureForOllama,
  mapTemperatureForOpenAICompat,
  nextOpenAICompatTemperatureAfterError,
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

const NANO_TEMPERATURE_ERROR =
  "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.";

describe("OpenAI-compat temperature retry helpers", () => {
  it("detects OpenAI unsupported-temperature 400s only", () => {
    expect(isUnsupportedTemperatureError(400, NANO_TEMPERATURE_ERROR)).toBe(
      true
    );
    expect(isUnsupportedTemperatureError(401, NANO_TEMPERATURE_ERROR)).toBe(
      false
    );
    expect(isUnsupportedTemperatureError(400, "status 400")).toBe(false);
    expect(
      isUnsupportedTemperatureError(
        400,
        "Unsupported value: 'none' is not supported with the 'gpt-5-nano' model. Supported values are: 'minimal', 'low', 'medium', and 'high'."
      )
    ).toBe(false);
  });

  it("retries by omitting temperature; does not retry unrelated 400s", () => {
    expect(
      nextOpenAICompatTemperatureAfterError(400, NANO_TEMPERATURE_ERROR, 0)
    ).toEqual({ retry: true });
    expect(
      nextOpenAICompatTemperatureAfterError(400, NANO_TEMPERATURE_ERROR, 0.2)
    ).toEqual({ retry: true });
    expect(
      nextOpenAICompatTemperatureAfterError(400, "status 400", 0)
    ).toEqual({ retry: false });
    expect(
      nextOpenAICompatTemperatureAfterError(400, NANO_TEMPERATURE_ERROR, undefined)
    ).toEqual({ retry: false });
  });
});
