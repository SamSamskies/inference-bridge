import { describe, expect, it } from "vitest";
import {
  capabilityWarnings,
  fingerprintTools,
  hostedToolLabel,
  isToolEpisodeContinuation,
  isToolFingerprintCovered,
  summarizeToolsForPreview,
} from "../src/tool-approval.js";

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

const timeTool = {
  type: "function",
  function: { name: "get_time", description: "Current time" },
};

describe("fingerprintTools", () => {
  it("builds a stable sorted fingerprint from names and hosted tools", () => {
    expect(
      fingerprintTools([
        timeTool,
        { type: "web_search" },
        weatherTool,
        { type: "web_search" },
      ])
    ).toBe("fn:get_time|fn:get_weather|hosted:web_search");
  });

  it("ignores parameter schema differences", () => {
    const a = fingerprintTools([weatherTool]);
    const b = fingerprintTools([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "other",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(a).toBe(b);
  });

  it("returns empty for missing tools", () => {
    expect(fingerprintTools(undefined)).toBe("");
    expect(fingerprintTools([])).toBe("");
  });
});

describe("isToolFingerprintCovered", () => {
  it("treats subsets as covered", () => {
    const granted = fingerprintTools([weatherTool, timeTool, { type: "web_search" }]);
    const request = fingerprintTools([weatherTool]);
    expect(isToolFingerprintCovered(request, granted)).toBe(true);
  });

  it("rejects expanded tool sets", () => {
    const granted = fingerprintTools([weatherTool]);
    const request = fingerprintTools([weatherTool, timeTool]);
    expect(isToolFingerprintCovered(request, granted)).toBe(false);
  });

  it("rejects when grant has no fingerprint", () => {
    expect(isToolFingerprintCovered(fingerprintTools([weatherTool]), "")).toBe(
      false
    );
  });
});

describe("isToolEpisodeContinuation", () => {
  it("requires assistant tool_calls and a tool result", () => {
    expect(
      isToolEpisodeContinuation([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ])
    ).toBe(true);
  });

  it("rejects plain chat and incomplete tool threads", () => {
    expect(
      isToolEpisodeContinuation([{ role: "user", content: "hi" }])
    ).toBe(false);
    expect(
      isToolEpisodeContinuation([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ])
    ).toBe(false);
  });
});

describe("summarizeToolsForPreview / hostedToolLabel", () => {
  it("lists function names with descriptions and hosted tools", () => {
    expect(
      summarizeToolsForPreview([weatherTool, { type: "web_search" }, weatherTool])
    ).toEqual({
      functions: [
        { name: "get_weather", description: "Get weather for a city" },
      ],
      hosted: ["web_search"],
    });
    expect(hostedToolLabel("web_search")).toBe(
      "Web search (provider-hosted)"
    );
  });
});

describe("capabilityWarnings", () => {
  it("warns when function tools are unsupported", () => {
    const warnings = capabilityWarnings(
      { label: "Demo", supportsFunctionTools: false, hostedTools: [] },
      [weatherTool]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/function tools/i);
  });

  it("warns when web_search is not in hostedTools", () => {
    const warnings = capabilityWarnings(
      { label: "OpenAI", supportsFunctionTools: true, hostedTools: [] },
      [{ type: "web_search" }]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/web search/i);
  });

  it("returns no warnings when capabilities match", () => {
    expect(
      capabilityWarnings(
        {
          label: "OpenAI",
          supportsFunctionTools: true,
          hostedTools: ["web_search"],
        },
        [weatherTool, { type: "web_search" }]
      )
    ).toEqual([]);
  });
});
