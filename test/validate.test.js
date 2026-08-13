import { describe, expect, it } from "vitest";
import {
  isValidOrigin,
  validateExperimentalInferenceRequest,
  validateInferenceRequest,
} from "../src/validate.js";

describe("validateInferenceRequest", () => {
  it("accepts a minimal valid chat request", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
  });

  it("rejects non-objects and arrays", () => {
    expect(validateInferenceRequest(null).ok).toBe(false);
    expect(validateInferenceRequest(undefined).ok).toBe(false);
    expect(validateInferenceRequest("chat").ok).toBe(false);
    expect(validateInferenceRequest([]).ok).toBe(false);
  });

  it("rejects unsupported methods", () => {
    const result = validateInferenceRequest({
      method: "embeddings",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/chat/);
  });

  it("rejects empty or missing messages", () => {
    expect(
      validateInferenceRequest({ method: "chat", messages: [] }).ok
    ).toBe(false);
    expect(validateInferenceRequest({ method: "chat" }).ok).toBe(false);
  });

  it("rejects invalid message shapes and roles", () => {
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [null],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "tool", content: "x" }],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: 42 }],
      }).ok
    ).toBe(false);
  });

  it("rejects tools, tool_choice, tool_calls, and tool_call_id (experimental-only)", () => {
    const tools = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
    });
    expect(tools.ok).toBe(false);
    expect(tools.message).toMatch(/experimental/);

    const toolChoice = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
    });
    expect(toolChoice.ok).toBe(false);
    expect(toolChoice.message).toMatch(/experimental/);

    const toolCalls = validateInferenceRequest({
      method: "chat",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ],
    });
    expect(toolCalls.ok).toBe(false);
    expect(toolCalls.message).toMatch(/experimental/);

    const toolCallId = validateInferenceRequest({
      method: "chat",
      messages: [
        { role: "assistant", content: "ok", tool_call_id: "call_1" },
      ],
    });
    expect(toolCallId.ok).toBe(false);
    expect(toolCallId.message).toMatch(/experimental/);
  });

  it("ignores undefined tool fields on the stable path (option spreads)", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [
        {
          role: "assistant",
          content: "ok",
          tool_calls: undefined,
          tool_call_id: undefined,
        },
      ],
      tools: undefined,
      tool_choice: undefined,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        method: "chat",
        messages: [{ role: "assistant", content: "ok" }],
      },
    });
  });

  it("strips unknown fields and keeps system/user/assistant", () => {
    const result = validateInferenceRequest({
      method: "chat",
      temperature: 0.2,
      messages: [
        { role: "system", content: "be brief", extra: true },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("preserves optional message.reasoning and rejects non-string reasoning", () => {
    const ok = validateInferenceRequest({
      method: "chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning: "why" },
        { role: "assistant", content: "empty", reasoning: "" },
      ],
    });
    expect(ok).toEqual({
      ok: true,
      value: {
        method: "chat",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", reasoning: "why" },
          { role: "assistant", content: "empty" },
        ],
      },
    });

    const bad = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "assistant", content: "x", reasoning: 1 }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/reasoning/);
  });

  it("ignores a serialized signal field", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      signal: { aborted: false },
    });
    expect(result.ok).toBe(true);
    expect(result.value).not.toHaveProperty("signal");
  });
});

describe("validateExperimentalInferenceRequest", () => {
  it("accepts plain chat without tools", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
  });

  it("accepts function tools, hosted web_search, and tool_choice", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
        { type: "web_search" },
      ],
      tool_choice: "auto",
    });
    expect(result.ok).toBe(true);
    expect(result.value.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
      { type: "web_search" },
    ]);
    expect(result.value.tool_choice).toBe("auto");
  });

  it("accepts assistant tool_calls and role tool follow-ups", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [
        { role: "user", content: "weather in Austin?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Austin"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: '{"tempC":22}',
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages).toEqual([
      { role: "user", content: "weather in Austin?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Austin"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"tempC":22}',
      },
    ]);
  });

  it("normalizes omitted assistant content to null when tool_calls are present", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: "{}" },
        },
      ],
    });
  });

  it("accepts function-shaped tool_choice", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      tool_choice: {
        type: "function",
        function: { name: "get_weather" },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("rejects invalid tools and tool_choice", () => {
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "browser" }],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "" } }],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "maybe",
      }).ok
    ).toBe(false);
  });

  it("rejects invalid tool messages and assistant shapes", () => {
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [{ role: "tool", content: "x" }],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [
          {
            role: "assistant",
            content: 1,
          },
        ],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "x", type: "function", function: { name: "a" } }],
          },
        ],
      }).ok
    ).toBe(false);
    expect(
      validateExperimentalInferenceRequest({
        method: "chat",
        messages: [
          {
            role: "user",
            content: "hi",
            tool_calls: [],
          },
        ],
      }).ok
    ).toBe(false);
  });

  it("preserves assistant reasoning on the experimental path", () => {
    const result = validateExperimentalInferenceRequest({
      method: "chat",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning: "why" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages[1]).toEqual({
      role: "assistant",
      content: "hello",
      reasoning: "why",
    });
  });
});

describe("isValidOrigin", () => {
  it("accepts https and localhost http origins", () => {
    expect(isValidOrigin("https://example.com")).toBe(true);
    expect(isValidOrigin("http://localhost:3000")).toBe(true);
    expect(isValidOrigin("http://127.0.0.1:8080")).toBe(true);
  });

  it("rejects opaque, file, empty, and non-origin strings", () => {
    expect(isValidOrigin("null")).toBe(false);
    expect(isValidOrigin("file:///tmp/x.html")).toBe(false);
    expect(isValidOrigin("")).toBe(false);
    expect(isValidOrigin("https://example.com/path")).toBe(false);
    expect(isValidOrigin("not a url")).toBe(false);
  });
});
