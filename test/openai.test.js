import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiProvider } from "../src/providers/openai.js";

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

describe("openaiProvider.streamChat", () => {
  it("uses Chat Completions when only function tools are present", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Austin\\"}"}}]}}]}',
          "data: [DONE]",
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      toolChoice: { type: "function", function: { name: "get_weather" } },
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "get_weather" } },
    ]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
    expect(result.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });

  it("uses Responses when hosted web_search is requested", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"news"}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "latest?" }],
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "get_weather" } },
      ],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("defaults tool_choice to auto when tools are present and toolChoice is omitted", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toBe("auto");
  });

  it("round-trips assistant toolCalls and tool follow-up messages", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"72F"}}]}\ndata: [DONE]\n')
    );
    vi.stubGlobal("fetch", fetchMock);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "weather in Austin?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
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
          toolCallId: "call_1",
          content: '{"tempC":22}',
        },
      ],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
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

  it("maps options.reasoningEffort to reasoning_effort and omits auto", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "none" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe(
      "none"
    );

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "none" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).reasoning_effort).toBe(
      "minimal"
    );

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "auto" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(
      JSON.parse(fetchMock.mock.calls[2][1].body)
    ).not.toHaveProperty("reasoning_effort");
  });

  it("maps options.temperature to temperature", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.2 },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0.2);

    await openaiProvider.streamChat({
      apiKey: "sk-test",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body)
    ).not.toHaveProperty("temperature");
  });
});
