import { describe, expect, it } from "vitest";
import {
  blocksAllowForMissingOllamaWebSearchKey,
  blocksAllowForRequestTools,
  blocksAllowForUnsupportedFunctionTools,
  capabilityWarnings,
  fingerprintTools,
  fingerprintTrailingToolCalls,
  hostedToolDescription,
  hostedToolLabel,
  isMessageHistoryExtension,
  isToolEpisodeContinuation,
  isToolFingerprintCovered,
  startsWithMessageHistory,
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
  it("fingerprints function names from the trailing assistant toolCalls", () => {
    expect(
      fingerprintTrailingToolCalls([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
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
        { role: "tool", toolCallId: "c1", content: "{}" },
        { role: "tool", toolCallId: "c2", content: "{}" },
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

describe("startsWithMessageHistory", () => {
  it("accepts equal and extended prefixes", () => {
    const prefix = [{ role: "user", content: "Weather in Austin?" }];
    expect(startsWithMessageHistory(prefix, prefix)).toBe(true);
    expect(
      startsWithMessageHistory(
        [
          ...prefix,
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
          { role: "tool", toolCallId: "c1", content: "{}" },
        ],
        prefix
      )
    ).toBe(true);
  });

  it("rejects shorter, mismatched, or empty prefixes", () => {
    const prefix = [{ role: "user", content: "Weather in Austin?" }];
    expect(startsWithMessageHistory([], prefix)).toBe(false);
    expect(
      startsWithMessageHistory(
        [{ role: "user", content: "Other prompt" }],
        prefix
      )
    ).toBe(false);
    expect(startsWithMessageHistory([{ role: "user", content: "x" }], [])).toBe(
      false
    );
    expect(startsWithMessageHistory(undefined, prefix)).toBe(false);
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
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
          { role: "tool", toolCallId: "c1", content: "{}" },
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
  it("requires a trailing assistant toolCalls turn with matching tool results", () => {
    expect(
      isToolEpisodeContinuation([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
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
          toolCalls: [
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
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
        { role: "user", content: "now book a flight" },
      ])
    ).toBe(false);
  });

  it("rejects tool results that do not match the preceding toolCalls", () => {
    expect(
      isToolEpisodeContinuation([
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", toolCallId: "other", content: "{}" },
      ])
    ).toBe(false);
  });

  it("rejects when only a subset of parallel toolCalls have results", () => {
    expect(
      isToolEpisodeContinuation([
        { role: "user", content: "weather and time?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
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
        { role: "tool", toolCallId: "c1", content: "{}" },
      ])
    ).toBe(false);
  });

  it("accepts when every parallel tool_call has a matching result", () => {
    expect(
      isToolEpisodeContinuation([
        { role: "user", content: "weather and time?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
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
        { role: "tool", toolCallId: "c1", content: "{}" },
        { role: "tool", toolCallId: "c2", content: "{}" },
      ])
    ).toBe(true);
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
    expect(hostedToolLabel("web_search", { id: "ollama" })).toBe(
      "Web search (Ollama cloud)"
    );
    expect(hostedToolDescription("web_search", { id: "ollama" })).toMatch(
      /ollama\.com/
    );
    expect(hostedToolDescription("web_search", { id: "openai" })).toBe("");
  });
});

describe("blocksAllowForUnsupportedFunctionTools", () => {
  it("blocks when function tools are present and provider lacks support", () => {
    expect(
      blocksAllowForUnsupportedFunctionTools(
        { supportsFunctionTools: false },
        [weatherTool]
      )
    ).toBe(true);
  });

  it("does not block when provider supports function tools", () => {
    expect(
      blocksAllowForUnsupportedFunctionTools(
        { supportsFunctionTools: true },
        [weatherTool]
      )
    ).toBe(false);
  });

  it("does not block hosted-only tools", () => {
    expect(
      blocksAllowForUnsupportedFunctionTools(
        { supportsFunctionTools: false, hostedTools: [] },
        [{ type: "web_search" }]
      )
    ).toBe(false);
  });

  it("does not block when tools are absent", () => {
    expect(
      blocksAllowForUnsupportedFunctionTools(
        { supportsFunctionTools: false },
        undefined
      )
    ).toBe(false);
  });
});

describe("blocksAllowForMissingOllamaWebSearchKey", () => {
  const ollamaNoKey = {
    id: "ollama",
    label: "Ollama",
    supportsFunctionTools: true,
    hostedTools: ["web_search"],
    hasApiKey: false,
  };

  it("blocks Ollama web_search when the account key is missing", () => {
    expect(
      blocksAllowForMissingOllamaWebSearchKey(ollamaNoKey, [
        { type: "web_search" },
      ])
    ).toBe(true);
    expect(
      blocksAllowForRequestTools(ollamaNoKey, [{ type: "web_search" }])
    ).toBe(true);
  });

  it("does not block Ollama chat without hosted search", () => {
    expect(
      blocksAllowForMissingOllamaWebSearchKey(ollamaNoKey, [weatherTool])
    ).toBe(false);
    expect(blocksAllowForMissingOllamaWebSearchKey(ollamaNoKey, [])).toBe(
      false
    );
  });

  it("does not block when a key is saved or hasApiKey is unknown", () => {
    expect(
      blocksAllowForMissingOllamaWebSearchKey(
        { ...ollamaNoKey, hasApiKey: true },
        [{ type: "web_search" }]
      )
    ).toBe(false);
    expect(
      blocksAllowForMissingOllamaWebSearchKey(
        { id: "ollama", supportsFunctionTools: true },
        [{ type: "web_search" }]
      )
    ).toBe(false);
  });

  it("does not block other providers", () => {
    expect(
      blocksAllowForMissingOllamaWebSearchKey(
        {
          id: "openai",
          hasApiKey: false,
          hostedTools: ["web_search"],
        },
        [{ type: "web_search" }]
      )
    ).toBe(false);
  });
});

describe("capabilityWarnings", () => {
  it("warns when function tools are unsupported", () => {
    const warnings = capabilityWarnings(
      { label: "On-device", supportsFunctionTools: false, hostedTools: [] },
      [weatherTool]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/does not support function tools/i);
    expect(warnings[0]).toMatch(/choose another provider/i);
  });

  it("warns when web_search is not in hostedTools", () => {
    const warnings = capabilityWarnings(
      { id: "on-device", label: "On-device", supportsFunctionTools: false, hostedTools: [] },
      [{ type: "web_search" }]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/web search is not supported by On-device/i);
    expect(warnings[0]).toMatch(/will not run a hosted search/i);
    expect(warnings[0]).not.toMatch(/allow will still work/i);
  });

  it("does not name a custom OpenAI-compatible server in the web_search warning", () => {
    const warnings = capabilityWarnings(
      {
        id: "compat:ppq",
        label: "PPQ",
        supportsFunctionTools: true,
        hostedTools: [],
      },
      [{ type: "web_search" }]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/OpenAI-compatible servers/i);
    expect(warnings[0]).toMatch(/not mapped/i);
    expect(warnings[0]).not.toMatch(/PPQ/);
    expect(warnings[0]).not.toMatch(/allow will still work/i);
  });

  it("does not warn in red when Ollama web search is ready", () => {
    expect(
      capabilityWarnings(
        {
          id: "ollama",
          label: "Ollama",
          supportsFunctionTools: true,
          hostedTools: ["web_search"],
          hasApiKey: true,
        },
        [{ type: "web_search" }]
      )
    ).toEqual([]);
  });

  it("tells the user to save an Ollama API key when it is missing", () => {
    const warnings = capabilityWarnings(
      {
        id: "ollama",
        label: "Ollama",
        supportsFunctionTools: true,
        hostedTools: ["web_search"],
        hasApiKey: false,
      },
      [{ type: "web_search" }]
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ollama\.com/i);
    expect(warnings[0]).toMatch(/save an Ollama account API key in Options/i);
    expect(warnings[0]).toMatch(/enable Allow/i);
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
