import { describe, expect, it } from "vitest";
import {
  isValidOrigin,
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
        messages: [{ role: "system", content: "x", tool_calls: [] }],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: 42 }],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "tool", content: 42 }],
      }).ok
    ).toBe(false);
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

  it("accepts MCP-style tools and strips unknown fields", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Weather lookup",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
          extra: 1,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather lookup",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("omits tools from value when absent", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(true);
    expect(result.value).not.toHaveProperty("tools");
  });

  it("rejects invalid tools", () => {
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: "nope",
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [{}],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "", description: 3, inputSchema: "x" }],
      }).ok
    ).toBe(false);
  });

  it("round-trips tool-role messages and assistant tool_calls", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", name: "get_weather", arguments: { city: "NYC" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "20" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "get_weather", arguments: { city: "NYC" } }],
      },
      { role: "tool", content: "20", tool_call_id: "call_1" },
    ]);
  });

  it("parses string tool_calls arguments into an object", () => {
    const result = validateInferenceRequest({
      method: "chat",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { name: "get_weather", arguments: '{"city":"NYC"}' },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.value.messages[0].tool_calls[0].arguments).toEqual({
      city: "NYC",
    });
  });

  it("rejects tool_calls on non-assistant messages and malformed calls", () => {
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [{ role: "user", content: "x", tool_calls: [] }],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [
          { role: "assistant", content: "x", tool_calls: [{ name: "t", arguments: 5 }] },
        ],
      }).ok
    ).toBe(false);
    expect(
      validateInferenceRequest({
        method: "chat",
        messages: [
          { role: "assistant", content: "x", tool_calls: [{ name: "t", arguments: "not-json" }] },
        ],
      }).ok
    ).toBe(false);
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
