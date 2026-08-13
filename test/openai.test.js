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
  it("forwards function tools only and returns accumulated tool_calls", async () => {
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
    expect(result.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });
});
