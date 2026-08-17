import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_RESPONSES_URL,
  mapMessagesForOpenAIResponses,
  mapToolChoiceForOpenAIResponses,
  mapToolsForOpenAIResponses,
  streamOpenAIResponsesChat,
} from "../src/providers/openai-responses.js";

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

describe("mapToolsForOpenAIResponses / mapToolChoiceForOpenAIResponses", () => {
  it("maps hosted search and flattens function tools", () => {
    expect(
      mapToolsForOpenAIResponses([
        { type: "web_search" },
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather lookup",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ])
    ).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "get_weather",
        description: "Weather lookup",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("maps toolChoice including named function", () => {
    expect(mapToolChoiceForOpenAIResponses(undefined)).toBe("auto");
    expect(mapToolChoiceForOpenAIResponses("required")).toBe("required");
    expect(
      mapToolChoiceForOpenAIResponses({
        type: "function",
        function: { name: "get_weather" },
      })
    ).toEqual({ type: "function", name: "get_weather" });
  });
});

describe("mapMessagesForOpenAIResponses", () => {
  it("maps function-call follow-ups to Responses items", () => {
    expect(
      mapMessagesForOpenAIResponses([
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
      ])
    ).toEqual([
      { role: "user", content: "weather in Austin?" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Austin"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"tempC":22}',
      },
    ]);
  });
});

describe("streamOpenAIResponsesChat", () => {
  it("POSTs /v1/responses with mapped tools and streams text", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"Hello"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"model":"gpt-resolved","usage":{"input_tokens":4,"output_tokens":2}}}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    /** @type {string[]} */
    const deltas = [];
    const result = await streamOpenAIResponsesChat({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(fetchMock.mock.calls[0][0]).toBe(OPENAI_RESPONSES_URL);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(deltas).toEqual(["Hello"]);
    expect(result).toEqual({
      model: "gpt-resolved",
      message: { role: "assistant", content: "Hello" },
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  it("accumulates function_call items and ignores hosted web_search_call", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: response.output_item.added",
          'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call"}}',
          "",
          "event: response.output_item.added",
          'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":""}}',
          "",
          "event: response.function_call_arguments.delta",
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":"}',
          "",
          "event: response.function_call_arguments.delta",
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"Austin\\"}"}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"looking"}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAIResponsesChat({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "get_weather" } },
      ],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(result.message.content).toBe("looking");
    expect(result.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });

  it("maps reasoningEffort and temperature", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamOpenAIResponsesChat({
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
      options: { reasoningEffort: "low", temperature: 0.2 },
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.temperature).toBe(0.2);
  });

  it("retries Responses reasoning.effort none → minimal after a model 400", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.reasoning?.effort === "none") {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported value: 'none' is not supported with the 'gpt-5-nano' model. Supported values are: 'minimal', 'low', 'medium', and 'high'.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return sseResponse(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          "",
        ].join("\n")
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAIResponsesChat({
      apiKey: "sk-test",
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search" }],
      options: { reasoningEffort: "none" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(result.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({
      effort: "none",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).reasoning).toEqual({
      effort: "minimal",
    });
  });

  it("throws provider_error on response.failed stream events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"partial"}',
            "",
            "event: response.failed",
            'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"backend failed"}}}',
            "",
          ].join("\n")
        )
      )
    );

    await expect(
      streamOpenAIResponsesChat({
        apiKey: "sk-test",
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "backend failed",
    });
  });

  it("throws provider_error on response.incomplete stream events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"partial"}',
            "",
            "event: response.incomplete",
            'data: {"type":"response.incomplete","response":{"status":"incomplete","error":null,"incomplete_details":{"reason":"max_output_tokens"}}}',
            "",
          ].join("\n")
        )
      )
    );

    await expect(
      streamOpenAIResponsesChat({
        apiKey: "sk-test",
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "OpenAI response incomplete: max_output_tokens",
    });
  });

  it("throws provider_error on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(
      streamOpenAIResponsesChat({
        apiKey: "sk-bad",
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "bad key",
    });
  });
});
