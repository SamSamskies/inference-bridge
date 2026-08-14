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
  it("forwards function tools only and returns accumulated toolCalls", async () => {
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
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "get_weather" } },
      ],
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
});
