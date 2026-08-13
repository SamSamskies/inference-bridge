import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
  anthropicProvider,
  mapAnthropicStatus,
  mapMessagesForAnthropic,
  mapToolChoiceForAnthropic,
  mapToolsForAnthropic,
} from "../src/providers/anthropic.js";
import { getProvider, listProviders } from "../src/providers/registry.js";

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {string} text
 * @param {number} [status]
 */
function sseResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapMessagesForAnthropic", () => {
  it("peels system messages into a top-level system string", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ])
    ).toEqual({
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    });
  });

  it("joins multiple system messages and strips reasoning", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "Q", reasoning: "should-not-send" },
        {
          role: "assistant",
          content: "A1",
          reasoning: "internal",
        },
      ])
    ).toEqual({
      system: "A\n\nB",
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "A1" },
      ],
    });
  });

  it("omits system when there are no system messages", () => {
    expect(
      mapMessagesForAnthropic([{ role: "user", content: "Hi" }])
    ).toEqual({
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("rejects system-only requests that would leave messages empty", () => {
    try {
      mapMessagesForAnthropic([{ role: "system", content: "Be brief." }]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message: "Anthropic requires at least one non-system message",
      });
    }
  });

  it("rejects requests whose first non-system turn is assistant", () => {
    try {
      mapMessagesForAnthropic([
        { role: "system", content: "Be brief." },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Hi" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message:
          "Anthropic requires the first non-system message to be from the user",
      });
    }
  });

  it("merges consecutive same-role messages", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "user", content: "One" },
        { role: "user", content: "Two" },
        { role: "assistant", content: "A" },
        { role: "assistant", content: "B" },
        { role: "user", content: "Three" },
      ])
    ).toEqual({
      messages: [
        { role: "user", content: "One\n\nTwo" },
        { role: "assistant", content: "A\n\nB" },
        { role: "user", content: "Three" },
      ],
    });
  });

  it("merges same-role turns that were separated only by system messages", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "user", content: "Hi" },
        { role: "system", content: "Note" },
        { role: "user", content: "Again" },
      ])
    ).toEqual({
      system: "Note",
      messages: [{ role: "user", content: "Hi\n\nAgain" }],
    });
  });

  it("maps assistant tool_calls to tool_use blocks and tool results to user tool_result", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "user", content: "Weather in Austin?" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            {
              id: "toolu_1",
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
          tool_call_id: "toolu_1",
          content: '{"temp":72}',
        },
      ])
    ).toEqual({
      messages: [
        { role: "user", content: "Weather in Austin?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "Austin" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: '{"temp":72}',
            },
          ],
        },
      ],
    });
  });

  it("merges consecutive tool results into one user message", () => {
    expect(
      mapMessagesForAnthropic([
        { role: "user", content: "Do both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_a",
              type: "function",
              function: { name: "a", arguments: "{}" },
            },
            {
              id: "toolu_b",
              type: "function",
              function: { name: "b", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_a", content: "ra" },
        { role: "tool", tool_call_id: "toolu_b", content: "rb" },
      ])
    ).toEqual({
      messages: [
        { role: "user", content: "Do both" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "a", input: {} },
            { type: "tool_use", id: "toolu_b", name: "b", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "ra" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "rb" },
          ],
        },
      ],
    });
  });
});

describe("mapToolsForAnthropic / mapToolChoiceForAnthropic", () => {
  it("maps Bridge function tools to Anthropic tools", () => {
    expect(
      mapToolsForAnthropic([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather lookup",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
        {
          type: "function",
          function: { name: "noop" },
        },
      ])
    ).toEqual([
      {
        name: "get_weather",
        description: "Weather lookup",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
      {
        name: "noop",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("maps tool_choice auto/none/required/named function", () => {
    expect(mapToolChoiceForAnthropic("auto")).toEqual({ type: "auto" });
    expect(mapToolChoiceForAnthropic("none")).toEqual({ type: "none" });
    expect(mapToolChoiceForAnthropic("required")).toEqual({ type: "any" });
    expect(
      mapToolChoiceForAnthropic({
        type: "function",
        function: { name: "get_weather" },
      })
    ).toEqual({ type: "tool", name: "get_weather" });
  });
});

describe("mapAnthropicStatus", () => {
  it("maps auth and overload statuses", () => {
    expect(mapAnthropicStatus(401, "bad key").code).toBe("provider_error");
    expect(mapAnthropicStatus(429, "rate").code).toBe("provider_error");
    expect(mapAnthropicStatus(529, "overloaded").code).toBe("unavailable");
    expect(mapAnthropicStatus(503, "down").code).toBe("unavailable");
    expect(mapAnthropicStatus(400, "bad req").code).toBe("provider_error");
  });
});

describe("anthropicProvider", () => {
  it("is registered as a first-class BYOK provider", () => {
    expect(getProvider("anthropic")).toBe(anthropicProvider);
    expect(listProviders().map((p) => p.id)).toContain("anthropic");
    expect(anthropicProvider.requiresApiKey).toBe(true);
    expect(anthropicProvider.label).toBe("Anthropic");
    expect(anthropicProvider.defaultModel).toBe("claude-sonnet-5");
    expect(anthropicProvider.models).toContain("claude-fable-5");
    expect(anthropicProvider.models).toContain("claude-sonnet-5");
    expect(anthropicProvider.supportsFunctionTools).toBe(true);
    expect(anthropicProvider.hostedTools).toEqual([]);
  });

  it("rejects assistant-first threads in preflight, before any provider work", () => {
    try {
      anthropicProvider.preflightMessages?.([
        { role: "assistant", content: "Hello! How can I help?" },
        { role: "user", content: "Hi" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message:
          "Anthropic requires the first non-system message to be from the user",
      });
    }
  });

  it("accepts user-first threads in preflight", () => {
    expect(() =>
      anthropicProvider.preflightMessages?.([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ])
    ).not.toThrow();
  });

  it("streams text_delta chunks and maps usage from message events", async () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const fetchMock = vi.fn(async () => sseResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    /** @type {string[]} */
    const deltas = [];
    const result = await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Hello", "!"]);
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.message).toEqual({ role: "assistant", content: "Hello!" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      ANTHROPIC_URL,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-ant-test",
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      model: "claude-sonnet-5",
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: true,
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("streams thinking_delta as reasoning", async () => {
    const sse = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan…"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"42"}}',
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    /** @type {string[]} */
    const deltas = [];
    /** @type {string[]} */
    const reasoning = [];
    const result = await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "q" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
      onReasoningDelta: (c) => reasoning.push(c),
    });

    expect(reasoning).toEqual(["plan…"]);
    expect(deltas).toEqual(["42"]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "42",
      reasoning: "plan…",
    });
  });

  it("throws provider_error on mid-stream error events", async () => {
    const sse = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      "",
      "event: error",
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    await expect(
      anthropicProvider.streamChat({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "Overloaded",
    });
  });

  it("maps 401 to provider_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          },
          401
        )
      )
    );

    await expect(
      anthropicProvider.streamChat({
        apiKey: "bad",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "invalid x-api-key",
    });
  });

  it("maps 529 to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
          529
        )
      )
    );

    await expect(
      anthropicProvider.streamChat({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: "Overloaded",
    });
  });

  it("throws aborted when the signal aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })
    );

    await expect(
      anthropicProvider.streamChat({
        apiKey: "sk-ant-test",
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });

  it("forwards function tools and toolChoice; strips hosted web_search", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Austin\\"}"}}',
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { type: "web_search" },
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather lookup",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather lookup",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(result.message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });

  it("defaults tool_choice to auto when tools are present and toolChoice is omitted", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_choice).toEqual({
      type: "auto",
    });
  });

  it("omits tools and tool_choice when only hosted web_search is present", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("accumulates streamed tool_use input_json_delta into done.message.tool_calls", async () => {
    const sse = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sure."}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_a","name":"get_weather","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"NYC\\"}"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":1}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_b","name":"get_time","input":{}}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":2}',
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    /** @type {string[]} */
    const deltas = [];
    const result = await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Sure."]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "Sure.",
      tool_calls: [
        {
          id: "toolu_a",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"NYC"}' },
        },
        {
          id: "toolu_b",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    });
  });

  it("round-trips tool_result follow-up messages in the request body", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"72F"}}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await anthropicProvider.streamChat({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_1",
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
          tool_call_id: "toolu_1",
          content: '{"temp":72}',
        },
      ],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { city: "Austin" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"temp":72}',
          },
        ],
      },
    ]);
    expect(result.message).toEqual({ role: "assistant", content: "72F" });
  });
});
