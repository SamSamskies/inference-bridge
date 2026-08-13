import { describe, expect, it } from "vitest";
import {
  capabilityWarnings,
  fingerprintTools,
  fingerprintTrailingToolCalls,
  hostedToolLabel,
  isMessageHistoryExtension,
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

describe("fingerprintTrailingToolCalls", () => {
  it("fingerprints function names from the trailing assistant tool_calls", () => {
    expect(
      fingerprintTrailingToolCalls([
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
            {
              id: "c2",
              type: "function",
              function: { name: "get_time", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "{}" },
        { role: "tool", tool_call_id: "c2", content: "{}" },
      ])
    ).toBe("fn:get_time|fn:get_weather");
  });

  it("returns empty when messages are not a tool continuation", () => {
    expect(fingerprintTrailingToolCalls([{ role: "user", content: "hi" }])).toBe(
      ""
    );
    expect(fingerprintTrailingToolCalls(undefined)).toBe("");
  });
});

describe("isMessageHistoryExtension", () => {
  it("requires a strict extension of the prefix messages", () => {
    const prefix = [{ role: "user", content: "Weather in Austin?" }];
    expect(
      isMessageHistoryExtension(
        [
          ...prefix,
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
        ],
        prefix
      )
    ).toBe(true);
  });

  it("rejects equal length, shorter, mismatched, or empty prefixes", () => {
    const prefix = [{ role: "user", content: "Weather in Austin?" }];
    expect(isMessageHistoryExtension(prefix, prefix)).toBe(false);
    expect(isMessageHistoryExtension([], prefix)).toBe(false);
    expect(
      isMessageHistoryExtension(
        [{ role: "user", content: "Other prompt" }, { role: "tool", content: "{}" }],
        prefix
      )
    ).toBe(false);
    expect(isMessageHistoryExtension([{ role: "user", content: "x" }], [])).toBe(
      false
    );
    expect(isMessageHistoryExtension(undefined, prefix)).toBe(false);
  });
});

describe("isToolEpisodeContinuation", () => {
  it("requires a trailing assistant tool_calls turn with matching tool results", () => {
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

  it("rejects when a new user turn follows prior tool traffic", () => {
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
        { role: "user", content: "now book a flight" },
      ])
    ).toBe(false);
  });

  it("rejects tool results that do not match the preceding tool_calls", () => {
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
        { role: "tool", tool_call_id: "other", content: "{}" },
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
