import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";

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

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
  globalThis.chrome.permissions = {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createOpenAICompatProvider", () => {
  const endpoint = {
    id: "compat:test-id",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
  };

  it("builds a provider with optional API key and the endpoint name as label", () => {
    const provider = createOpenAICompatProvider(endpoint);
    expect(provider.id).toBe("compat:test-id");
    expect(provider.label).toBe("LM Studio");
    expect(provider.requiresApiKey).toBe(false);
    expect(provider.optionalApiKey).toBe(true);
    expect(provider.supportsFunctionTools).toBe(true);
    expect(provider.hostedTools).toEqual([]);
    expect(typeof provider.listModels).toBe("function");
    expect(typeof provider.streamChat).toBe("function");
  });

  it("lists models from GET /models and sorts by id", async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/models");
      return jsonResponse({
        data: [
          { id: "zeta", name: "Zeta" },
          { id: "alpha" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["alpha", "zeta"]);
    expect(models).toContainEqual({ id: "zeta", label: "Zeta" });
    expect(models).toContainEqual({ id: "alpha" });
  });

  it("sends Bearer auth on listModels when an API key is provided", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe("Bearer secret");
      return jsonResponse({ data: [{ id: "local" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    const models = await provider.listModels({ apiKey: "secret" });
    expect(models).toEqual([{ id: "local" }]);
  });

  it("lists models without Authorization when no key", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init?.headers?.Authorization).toBeUndefined();
      return jsonResponse({ data: [{ id: "local" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await provider.listModels();
  });

  it("returns an empty list when /models fails so free-text can degrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const provider = createOpenAICompatProvider(endpoint);
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it("rejects listModels when host permission is missing", async () => {
    globalThis.chrome.permissions.contains = vi.fn(async () => false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await expect(provider.listModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: expect.stringMatching(/host permission/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams chat to /chat/completions without Authorization when no key", async () => {
    const sse = [
      'data: {"id":"1","model":"local","choices":[{"delta":{"content":"Hi"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(init.headers.Authorization).toBeUndefined();
      return sseResponse(sse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    /** @type {string[]} */
    const deltas = [];
    const result = await provider.streamChat({
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Hi"]);
    expect(result.message.content).toBe("Hi");
  });

  it("sends Bearer auth when an API key is provided", async () => {
    const sse = ["data: [DONE]", ""].join("\n");
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe("Bearer secret");
      return sseResponse(sse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await provider.streamChat({
      apiKey: "secret",
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
  });

  it("forwards function tools and toolChoice; strips hosted web_search", async () => {
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

    const provider = createOpenAICompatProvider(endpoint);
    const result = await provider.streamChat({
      model: "local",
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

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse(init.body);
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
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
  });

  it("omits tools and tool_choice when only hosted web_search is present", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n')
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await provider.streamChat({
      model: "local",
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

  it("accumulates streamed tool_calls by index into done.message.tool_calls", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    const provider = createOpenAICompatProvider(endpoint);
    const result = await provider.streamChat({
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "get_time" } },
      ],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    expect(result.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "get_time", arguments: "{}" },
      },
    ]);
  });

  it("round-trips assistant tool_calls and tool follow-up messages", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"72F"}}]}\ndata: [DONE]\n')
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await provider.streamChat({
      model: "local",
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
