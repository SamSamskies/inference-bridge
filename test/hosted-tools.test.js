import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  OPENAI_WEB_SEARCH_TOOL,
  OPENROUTER_WEB_SEARCH_TOOL,
  hasHostedWebSearch,
  mapToolsForOpenRouter,
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

describe("pinned hosted tool shapes", () => {
  it("pins Anthropic and OpenAI hosted search types", () => {
    expect(ANTHROPIC_WEB_SEARCH_TOOL).toEqual({
      type: "web_search_20250305",
      name: "web_search",
    });
    expect(OPENAI_WEB_SEARCH_TOOL).toEqual({ type: "web_search" });
  });
});
