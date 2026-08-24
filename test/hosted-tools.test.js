import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  OPENAI_WEB_SEARCH_TOOL,
  OPENROUTER_WEB_SEARCH_TOOL,
  assertHostedWebSearchSupported,
  hasHostedWebSearch,
  hostedWebSearchActive,
  mapToolsForOpenRouter,
  omitHostedWebSearchIfNone,
} from "../src/providers/hosted-tools.js";

describe("hasHostedWebSearch", () => {
  it("detects Bridge-normalized web_search", () => {
    expect(hasHostedWebSearch([{ type: "web_search" }])).toBe(true);
    expect(
      hasHostedWebSearch([
        { type: "function", function: { name: "get_weather" } },
        { type: "web_search" },
      ])
    ).toBe(true);
  });

  it("is false without hosted search", () => {
    expect(hasHostedWebSearch(undefined)).toBe(false);
    expect(hasHostedWebSearch([])).toBe(false);
    expect(
      hasHostedWebSearch([{ type: "function", function: { name: "get_weather" } }])
    ).toBe(false);
  });
});

describe("mapToolsForOpenRouter", () => {
  it("maps web_search to openrouter:web_search and keeps function tools", () => {
    expect(
      mapToolsForOpenRouter([
        { type: "web_search" },
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ])
    ).toEqual([
      { ...OPENROUTER_WEB_SEARCH_TOOL },
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ]);
  });

  it("returns undefined when nothing maps", () => {
    expect(mapToolsForOpenRouter(undefined)).toBeUndefined();
    expect(mapToolsForOpenRouter([])).toBeUndefined();
  });
});

describe("hostedWebSearchActive / omitHostedWebSearchIfNone", () => {
  const searchTools = [
    { type: "web_search" },
    { type: "function", function: { name: "get_weather" } },
  ];

  it("is inactive when toolChoice is none", () => {
    expect(hostedWebSearchActive(searchTools, "none")).toBe(false);
    expect(hostedWebSearchActive(searchTools, "auto")).toBe(true);
    expect(hostedWebSearchActive(searchTools, undefined)).toBe(true);
  });

  it("drops hosted web_search when toolChoice is none", () => {
    expect(omitHostedWebSearchIfNone(searchTools, "none")).toEqual([
      { type: "function", function: { name: "get_weather" } },
    ]);
    expect(
      omitHostedWebSearchIfNone([{ type: "web_search" }], "none")
    ).toBeUndefined();
    expect(omitHostedWebSearchIfNone(searchTools, "auto")).toEqual(searchTools);
  });
});

describe("assertHostedWebSearchSupported", () => {
  it("throws unavailable when the provider cannot honor active web_search", () => {
    try {
      assertHostedWebSearchSupported(
        { id: "on-device", label: "On-device", hostedTools: [] },
        [{ type: "web_search" }],
        "auto"
      );
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toMatchObject({
        name: "InferenceError",
        code: "unavailable",
        message: expect.stringMatching(/On-device/i),
      });
    }
  });

  it("is a no-op when toolChoice is none or the provider honors search", () => {
    expect(() =>
      assertHostedWebSearchSupported(
        { id: "on-device", label: "On-device", hostedTools: [] },
        [{ type: "web_search" }],
        "none"
      )
    ).not.toThrow();
    expect(() =>
      assertHostedWebSearchSupported(
        { id: "openai", hostedTools: ["web_search"] },
        [{ type: "web_search" }],
        "auto"
      )
    ).not.toThrow();
  });
});

describe("pinned hosted tool shapes", () => {
  it("pins Anthropic and OpenAI hosted search types", () => {
    expect(ANTHROPIC_WEB_SEARCH_TOOL).toEqual({
      type: "web_search_20250305",
      name: "web_search",
    });
    expect(OPENAI_WEB_SEARCH_TOOL).toEqual({ type: "web_search" });
  });
});
