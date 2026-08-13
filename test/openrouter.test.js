import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOpenRouterModels,
  openrouterProvider,
} from "../src/providers/openrouter.js";

/**
 * @param {string} text
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

describe("listOpenRouterModels", () => {
  it("maps id and name, sorts by id, and includes router entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "openrouter/pareto-code", name: "Pareto Code Router" },
            { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
            { id: "openrouter/free", name: "Free Models Router" },
            { id: "z-last/model" },
          ],
        })
      )
    );

    const models = await listOpenRouterModels();
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "openrouter/free",
      "openrouter/pareto-code",
      "z-last/model",
    ]);
    expect(models).toContainEqual({
      id: "openrouter/free",
      label: "Free Models Router",
    });
    expect(models).toContainEqual({
      id: "openrouter/pareto-code",
      label: "Pareto Code Router",
    });
    expect(models.find((m) => m.id === "z-last/model")).toEqual({
      id: "z-last/model",
    });
  });

  it("throws unavailable on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(listOpenRouterModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });

  it("throws provider_error on invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 }))
    );
    await expect(listOpenRouterModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
    });
  });

  it("throws unavailable on 5xx listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "down" } }, 503))
    );
    await expect(listOpenRouterModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });
});

describe("openrouterProvider.streamChat", () => {
  it("streams deltas, ignores keep-alive comments, and maps usage", async () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      "",
      'data: {"id":"1","model":"openrouter/free","choices":[{"delta":{"content":"Hi"}}]}',
      ": OPENROUTER PROCESSING",
      'data: {"id":"1","model":"anthropic/claude-opus-5","choices":[{"delta":{"content":" there"}}]}',
      'data: {"id":"1","model":"anthropic/claude-opus-5","choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(sse))
    );

    /** @type {string[]} */
    const deltas = [];
    const result = await openrouterProvider.streamChat({
      apiKey: "sk-or-test",
      model: "openrouter/free",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Hi", " there"]);
    // Router slug resolves to the underlying model reported in later chunks.
    expect(result.model).toBe("anthropic/claude-opus-5");
    expect(result.message).toEqual({ role: "assistant", content: "Hi there" });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("throws provider_error on mid-stream error chunks", async () => {
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"partial"}}]}',
      'data: {"id":"1","error":{"code":"server_error","message":"Provider disconnected unexpectedly"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}',
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    await expect(
      openrouterProvider.streamChat({
        apiKey: "sk-or-test",
        model: "openrouter/free",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "Provider disconnected unexpectedly",
    });
  });

  it("maps 401 and 402 to provider_error", async () => {
    for (const status of [401, 402]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: `status ${status}` } }, status)
        )
      );
      await expect(
        openrouterProvider.streamChat({
          apiKey: "bad",
          model: "openrouter/free",
          messages: [{ role: "user", content: "hi" }],
          signal: new AbortController().signal,
          onDelta: () => {},
        })
      ).rejects.toMatchObject({
        name: "InferenceError",
        code: "provider_error",
      });
    }
  });

  it("maps 503 to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "no providers" } }, 503)
      )
    );
    await expect(
      openrouterProvider.streamChat({
        apiKey: "sk-or-test",
        model: "openrouter/free",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: "no providers",
    });
  });

  it("maps abort to aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        // Mimic fetch abort when the signal is already aborted.
        if (init?.signal?.aborted) throw err;
        throw err;
      })
    );
    controller.abort();
    await expect(
      openrouterProvider.streamChat({
        apiKey: "sk-or-test",
        model: "openrouter/free",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });

  it("forwards function tools and tool_choice; strips hosted web_search", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}}]}',
          "data: [DONE]",
          "",
        ].join("\n")
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openrouterProvider.streamChat({
      apiKey: "sk-or-test",
      model: "openrouter/auto",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { type: "web_search" },
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(result.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{}" },
      },
    ]);
  });

  it("round-trips assistant tool_calls and tool follow-up messages", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"72F"}}]}\ndata: [DONE]\n')
    );
    vi.stubGlobal("fetch", fetchMock);

    await openrouterProvider.streamChat({
      apiKey: "sk-or-test",
      model: "openrouter/auto",
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
        content: '{"tempF":72}',
      },
    ]);
  });
});
