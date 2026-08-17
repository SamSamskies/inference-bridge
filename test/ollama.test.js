import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accumulateOllamaToolCalls,
  finalizeOllamaToolCalls,
  listOllamaModels,
  mapMessagesForOllama,
  ollamaProvider,
  OLLAMA_BASE_URL,
  parseArgumentsForOllama,
} from "../src/providers/ollama.js";

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
 * Newline-delimited JSON stream (Ollama /api/chat).
 * @param {string} text
 * @param {number} [status]
 */
function ndjsonResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

/**
 * @param {string[]} chunks
 * @param {number} [status]
 */
function chunkedNdjsonResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listOllamaModels", () => {
  it("maps name or model fields, skips empties, and sorts by id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        models: [
          { name: "llama3.2:latest" },
          { model: "gemma2:2b" },
          { name: "" },
          {},
          { name: "phi3:mini" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listOllamaModels();
    expect(models.map((m) => m.id)).toEqual([
      "gemma2:2b",
      "llama3.2:latest",
      "phi3:mini",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: undefined,
    });
  });

  it("throws unavailable on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(listOllamaModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });

  it("throws provider_error on invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 }))
    );
    await expect(listOllamaModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
    });
  });

  it("throws unavailable on 5xx listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "down" }, 503))
    );
    await expect(listOllamaModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });

  it("maps abort to aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })
    );
    controller.abort();
    await expect(
      listOllamaModels({ signal: controller.signal })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });
});

describe("ollamaProvider", () => {
  it("advertises optional ollama.com key and hosted web_search", () => {
    expect(ollamaProvider.requiresApiKey).toBe(false);
    expect(ollamaProvider.optionalApiKey).toBe(true);
    expect(ollamaProvider.supportsFunctionTools).toBe(true);
    expect(ollamaProvider.hostedTools).toEqual(["web_search"]);
  });
});

describe("ollamaProvider.streamChat", () => {
  it("streams message content deltas and maps usage from the done chunk", async () => {
    const body = [
      JSON.stringify({
        model: "llama3.2:latest",
        message: { role: "assistant", content: "Hi" },
        done: false,
      }),
      JSON.stringify({
        model: "llama3.2:latest",
        message: { role: "assistant", content: "!" },
        done: false,
      }),
      JSON.stringify({
        model: "llama3.2:latest",
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 2,
      }),
      "",
    ].join("\n");

    const fetchMock = vi.fn(async () => ndjsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    /** @type {string[]} */
    const deltas = [];
    const result = await ollamaProvider.streamChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Hi", "!"]);
    expect(result).toEqual({
      model: "llama3.2:latest",
      message: { role: "assistant", content: "Hi!" },
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(result.message).not.toHaveProperty("reasoning");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${OLLAMA_BASE_URL}/api/chat`);
    expect(JSON.parse(init.body)).toEqual({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
  });

  it("streams thinking as reasoning_delta and content as delta", async () => {
    const body = [
      JSON.stringify({
        model: "qwen3",
        message: { role: "assistant", thinking: "Hmm", content: "" },
        done: false,
      }),
      JSON.stringify({
        model: "qwen3",
        message: { role: "assistant", thinking: "...", content: "" },
        done: false,
      }),
      JSON.stringify({
        model: "qwen3",
        message: { role: "assistant", thinking: "", content: "4" },
        done: false,
      }),
      JSON.stringify({
        model: "qwen3",
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 5,
        eval_count: 1,
      }),
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(body)));

    /** @type {string[]} */
    const deltas = [];
    /** @type {string[]} */
    const reasoningDeltas = [];
    const result = await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "2+2?" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
      onReasoningDelta: (c) => reasoningDeltas.push(c),
    });

    expect(reasoningDeltas).toEqual(["Hmm", "..."]);
    expect(deltas).toEqual(["4"]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "4",
      reasoning: "Hmm...",
    });
  });

  it("round-trips prior message.reasoning as thinking", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning: "prior" },
      ],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", thinking: "prior" },
    ]);
  });

  it("reassembles NDJSON lines split across chunks and flushes a final line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chunkedNdjsonResponse([
          '{"message":{"content":"hel',
          'lo"},"done":false}\n{"message":{"content":"!"},"done":true,"eval_count":1}',
        ])
      )
    );

    /** @type {string[]} */
    const deltas = [];
    const result = await ollamaProvider.streamChat({
      model: "gemma2:2b",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["hello", "!"]);
    expect(result.message.content).toBe("hello!");
    expect(result.usage).toEqual({
      inputTokens: undefined,
      outputTokens: 1,
    });
  });

  it("throws unavailable when model is empty", async () => {
    await expect(
      ollamaProvider.streamChat({
        model: "",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: expect.stringContaining("No Ollama model selected"),
    });
  });

  it("maps 403 to unavailable with Origin guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "forbidden" }, 403))
    );

    await expect(
      ollamaProvider.streamChat({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: expect.stringContaining("OLLAMA_ORIGINS"),
    });
  });

  it("maps 404 to provider_error using body.error when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "model 'missing' not found" }, 404)
      )
    );

    await expect(
      ollamaProvider.streamChat({
        model: "missing",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "model 'missing' not found",
    });
  });

  it("throws provider_error on mid-stream error", async () => {
    const body = [
      JSON.stringify({
        message: { role: "assistant", content: "partial" },
        done: false,
      }),
      JSON.stringify({ error: "runner crashed" }),
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(body)));

    await expect(
      ollamaProvider.streamChat({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "runner crashed",
    });
  });

  it("maps abort to aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })
    );
    controller.abort();

    await expect(
      ollamaProvider.streamChat({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });

  it("maps network failure to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(
      ollamaProvider.streamChat({
        model: "llama3.2:latest",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: "Failed to fetch",
    });
  });

  it("errors when hosted web_search is requested without an Ollama API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ollamaProvider.streamChat({
        model: "qwen3",
        messages: [{ role: "user", content: "news?" }],
        tools: [{ type: "web_search" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: expect.stringMatching(/Ollama account API key/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps hosted web_search to function tools and keeps page function toolCalls", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  index: 0,
                  name: "get_weather",
                  arguments: { city: "Austin" },
                },
              },
            ],
          },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ollamaProvider.streamChat({
      apiKey: "ollama-key",
      model: "qwen3",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { type: "web_search" },
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${OLLAMA_BASE_URL}/api/chat`);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools.map((t) => t.function.name)).toEqual([
      "web_search",
      "web_fetch",
      "get_weather",
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(result.message.toolCalls).toEqual([
      {
        id: "ollama_call_0",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });

  it("executes ollama.com web_search and continues local chat until text", async () => {
    let chatTurns = 0;
    const fetchMock = vi.fn(async (url, init) => {
      const href = String(url);
      if (href === `${OLLAMA_BASE_URL}/api/chat`) {
        chatTurns += 1;
        if (chatTurns === 1) {
          return ndjsonResponse(
            JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "web_search",
                      arguments: { query: "NYC weather today" },
                    },
                  },
                ],
              },
              done: true,
            }) + "\n"
          );
        }
        return ndjsonResponse(
          JSON.stringify({
            message: { role: "assistant", content: "Sunny in New York." },
            done: true,
          }) + "\n"
        );
      }
      if (href === "https://ollama.com/api/web_search") {
        expect(init.headers.Authorization).toBe("Bearer ollama-key");
        expect(JSON.parse(init.body)).toEqual({ query: "NYC weather today" });
        return jsonResponse({
          results: [
            {
              title: "Weather",
              url: "https://example.com",
              content: "Sunny",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const deltas = [];
    const result = await ollamaProvider.streamChat({
      apiKey: "ollama-key",
      model: "qwen3",
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [{ type: "web_search" }],
      signal: new AbortController().signal,
      onDelta: (content) => deltas.push(content),
    });

    expect(chatTurns).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.message.content).toBe("Sunny in New York.");
    expect(result.message.toolCalls).toBeUndefined();
    expect(deltas.join("")).toBe("Sunny in New York.");

    const followUp = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(followUp.messages).toEqual([
      { role: "user", content: "What's the weather in NYC?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "web_search",
              arguments: { query: "NYC weather today" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: JSON.stringify({
          results: [
            {
              title: "Weather",
              url: "https://example.com",
              content: "Sunny",
            },
          ],
        }),
        tool_name: "web_search",
      },
    ]);
  });

  it("defaults tool_choice to auto when tools are present and toolChoice is omitted", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_choice).toBe(
      "auto"
    );
  });

  it("accumulates streamed toolCalls by index into done.message.toolCalls", async () => {
    const body = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "get_weather", arguments: '{"city":"' },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              index: 0,
              function: { arguments: 'NYC"}' },
            },
          ],
        },
        done: false,
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              index: 1,
              function: { name: "get_time", arguments: {} },
            },
          ],
        },
        done: true,
        prompt_eval_count: 4,
        eval_count: 2,
      }),
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(body)));

    const result = await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(result.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
      {
        id: "ollama_call_1",
        type: "function",
        function: { name: "get_time", arguments: "{}" },
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it("round-trips assistant toolCalls and tool follow-up messages", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: { role: "assistant", content: "72F" },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await ollamaProvider.streamChat({
      model: "qwen3",
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
          content: JSON.stringify({ tempF: 72 }),
        },
      ],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toEqual([
      { role: "user", content: "weather in Austin?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "get_weather",
              arguments: { city: "Austin" },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_name: "get_weather",
        content: '{"tempF":72}',
      },
    ]);
  });

  it("maps options.reasoningEffort onto think", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "none" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).think).toBe(false);

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "medium" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).think).toBe("medium");

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      options: { reasoningEffort: "auto" },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty(
      "think"
    );
  });

  it("maps options.temperature onto options.temperature", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.3 },
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).options).toEqual({
      temperature: 0.3,
    });

    await ollamaProvider.streamChat({
      model: "qwen3",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      "options"
    );
  });
});

describe("mapMessagesForOllama / tool helpers", () => {
  it("parses JSON-string arguments into objects", () => {
    expect(parseArgumentsForOllama('{"city":"NYC"}')).toEqual({ city: "NYC" });
    expect(parseArgumentsForOllama("{")).toEqual({});
    expect(parseArgumentsForOllama({ city: "NYC" })).toEqual({ city: "NYC" });
  });

  it("round-trips assistant toolCalls and maps toolCallId to tool_name", () => {
    expect(
      mapMessagesForOllama([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          reasoning: "plan",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "20" },
      ])
    ).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        thinking: "plan",
        tool_calls: [
          {
            type: "function",
            function: { name: "get_weather", arguments: { city: "NYC" } },
          },
        ],
      },
      { role: "tool", tool_name: "get_weather", content: "20" },
    ]);
  });

  it("accumulates and finalizes toolCalls by index", () => {
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const byIndex = new Map();
    accumulateOllamaToolCalls(byIndex, [
      {
        function: {
          index: 0,
          name: "get_weather",
          arguments: { city: "NYC" },
        },
      },
      {
        function: {
          index: 1,
          name: "get_time",
          arguments: "{}",
        },
      },
    ]);
    expect(finalizeOllamaToolCalls(byIndex)).toEqual([
      {
        id: "ollama_call_0",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
      {
        id: "ollama_call_1",
        type: "function",
        function: { name: "get_time", arguments: "{}" },
      },
    ]);
  });

  it("merges argument deltas that omit index into the in-progress call", () => {
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const byIndex = new Map();
    accumulateOllamaToolCalls(byIndex, [
      {
        id: "call_1",
        function: { name: "get_weather", arguments: '{"city":"' },
      },
    ]);
    accumulateOllamaToolCalls(byIndex, [
      { function: { arguments: 'NYC"}' } },
    ]);
    expect(finalizeOllamaToolCalls(byIndex)).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  it("keeps distinct parallel toolCalls when Ollama reuses index 0", () => {
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const byIndex = new Map();
    accumulateOllamaToolCalls(byIndex, [
      {
        index: 0,
        id: "call_a",
        function: { name: "file_write", arguments: '{"path":"a.py"}' },
      },
    ]);
    accumulateOllamaToolCalls(byIndex, [
      {
        index: 0,
        id: "call_b",
        function: { name: "file_write", arguments: '{"path":"b.py"}' },
      },
    ]);
    accumulateOllamaToolCalls(byIndex, [
      {
        function: {
          index: 0,
          name: "get_weather",
          arguments: { city: "NYC" },
        },
      },
    ]);
    expect(finalizeOllamaToolCalls(byIndex)).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "file_write", arguments: '{"path":"a.py"}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "file_write", arguments: '{"path":"b.py"}' },
      },
      {
        id: "ollama_call_2",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  it("drops incomplete toolCalls missing a name", () => {
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const byIndex = new Map();
    accumulateOllamaToolCalls(byIndex, [
      { function: { arguments: "{}" } },
      {
        id: "call_ok",
        function: { name: "ok", arguments: {} },
      },
    ]);
    expect(finalizeOllamaToolCalls(byIndex)).toEqual([
      {
        id: "call_ok",
        type: "function",
        function: { name: "ok", arguments: "{}" },
      },
    ]);
  });
});
