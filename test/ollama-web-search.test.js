import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_HOSTED_SEARCH_MAX_TURNS,
  OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS,
  OLLAMA_WEB_FETCH_FUNCTION_TOOL,
  OLLAMA_WEB_FETCH_URL,
  OLLAMA_WEB_SEARCH_FUNCTION_TOOL,
  OLLAMA_WEB_SEARCH_URL,
  executeOllamaHostedToolCall,
  executeOllamaWebFetch,
  executeOllamaWebSearch,
  hasOllamaWebSearchApiKey,
  hostedSearchFollowUpMessages,
  isOllamaHostedSearchToolName,
  mapToolsForOllama,
  missingOllamaWebSearchKeyMessage,
  runOllamaHostedSearchLoop,
} from "../src/providers/ollama-web-search.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapToolsForOllama", () => {
  it("maps web_search to web_search + web_fetch and keeps function tools", () => {
    expect(
      mapToolsForOllama([
        { type: "web_search" },
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ])
    ).toEqual([
      OLLAMA_WEB_SEARCH_FUNCTION_TOOL,
      OLLAMA_WEB_FETCH_FUNCTION_TOOL,
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ]);
  });

  it("does not inject a hosted schema when the page already defined that name", () => {
    const pageSearch = {
      type: "function",
      function: { name: "web_search", description: "page tool" },
    };
    expect(mapToolsForOllama([{ type: "web_search" }, pageSearch])).toEqual([
      OLLAMA_WEB_FETCH_FUNCTION_TOOL,
      pageSearch,
    ]);
  });

  it("returns only function tools when hosted search is absent", () => {
    expect(
      mapToolsForOllama([
        { type: "function", function: { name: "get_weather" } },
      ])
    ).toEqual([{ type: "function", function: { name: "get_weather" } }]);
  });

  it("returns undefined when nothing maps", () => {
    expect(mapToolsForOllama(undefined)).toBeUndefined();
    expect(mapToolsForOllama([])).toBeUndefined();
  });
});

describe("hosted search helpers", () => {
  it("detects API keys and hosted tool names", () => {
    expect(hasOllamaWebSearchApiKey(undefined)).toBe(false);
    expect(hasOllamaWebSearchApiKey("  ")).toBe(false);
    expect(hasOllamaWebSearchApiKey("ollama-key")).toBe(true);
    expect(isOllamaHostedSearchToolName("web_search")).toBe(true);
    expect(isOllamaHostedSearchToolName("web_fetch")).toBe(true);
    expect(isOllamaHostedSearchToolName("get_weather")).toBe(false);
    expect(missingOllamaWebSearchKeyMessage()).toMatch(/localhost:11434/);
  });

  it("builds assistant + tool follow-up messages", () => {
    expect(
      hostedSearchFollowUpMessages(
        { role: "assistant", content: "", reasoning: "plan" },
        [
          {
            id: "ollama_call_0",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"q"}' },
          },
        ],
        ['{"results":[]}']
      )
    ).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning: "plan",
        toolCalls: [
          {
            id: "ollama_call_0",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"q"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"results":[]}',
        toolCallId: "ollama_call_0",
      },
    ]);
  });
});

describe("executeOllamaWebSearch / web_fetch", () => {
  it("returns a tool error without fetching when query is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await executeOllamaWebSearch({ apiKey: "k", query: "" })).toBe(
      JSON.stringify({ error: "query is required" })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs query and optional max_results with the Bearer key", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [{ title: "Ollama", url: "https://ollama.com", content: "hi" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeOllamaWebSearch({
      apiKey: " ollama-key ",
      query: "what is ollama?",
      max_results: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OLLAMA_WEB_SEARCH_URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ollama-key",
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      query: "what is ollama?",
      max_results: 3,
    });
    expect(JSON.parse(result)).toEqual({
      results: [{ title: "Ollama", url: "https://ollama.com", content: "hi" }],
    });
  });

  it("clamps max_results to 1..10", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeOllamaWebSearch({ apiKey: "k", query: "q", max_results: 99 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_results).toBe(10);
  });

  it("POSTs web_fetch with url", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ title: "Ollama", content: "docs", links: [] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeOllamaWebFetch({
      apiKey: "k",
      url: "https://ollama.com",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(OLLAMA_WEB_FETCH_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      url: "https://ollama.com",
    });
    expect(JSON.parse(result).title).toBe("Ollama");
  });

  it("throws unavailable on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401))
    );
    await expect(
      executeOllamaWebSearch({ apiKey: "bad", query: "q" })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });

  it("truncates oversized JSON results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ content: "x".repeat(20_000) }))
    );
    const result = await executeOllamaWebFetch({
      apiKey: "k",
      url: "https://example.com",
    });
    expect(result.length).toBe(OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS);
  });

  it("dispatches hosted tool calls by name", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeOllamaHostedToolCall({
      apiKey: "k",
      toolCall: {
        id: "c1",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "q" }),
        },
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(OLLAMA_WEB_SEARCH_URL);
  });
});

describe("runOllamaHostedSearchLoop", () => {
  it("executes web_search and continues until a text turn", async () => {
    /** @type {unknown[][]} */
    const turnMessages = [];
    const streamTurn = vi.fn(async ({ messages }) => {
      turnMessages.push(messages);
      if (streamTurn.mock.calls.length === 1) {
        return {
          model: "qwen3",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "ollama_call_0",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "ollama" }),
                },
              },
            ],
          },
        };
      }
      return {
        model: "qwen3",
        message: { role: "assistant", content: "Ollama runs local models." },
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [{ title: "Ollama", url: "https://ollama.com", content: "local" }],
        })
      )
    );

    const result = await runOllamaHostedSearchLoop({
      apiKey: "k",
      tools: [{ type: "web_search" }],
      messages: [{ role: "user", content: "What is Ollama?" }],
      signal: new AbortController().signal,
      streamTurn,
    });

    expect(result.message.content).toBe("Ollama runs local models.");
    expect(streamTurn).toHaveBeenCalledTimes(2);
    expect(turnMessages[1][1]).toMatchObject({
      role: "assistant",
      toolCalls: [{ function: { name: "web_search" } }],
    });
    expect(turnMessages[1][2]).toMatchObject({
      role: "tool",
      toolCallId: "ollama_call_0",
    });
    expect(JSON.parse(turnMessages[1][2].content).results[0].title).toBe(
      "Ollama"
    );
  });

  it("returns page function toolCalls when mixed with hosted search in the same turn", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const streamTurn = vi.fn(async () => ({
      model: "qwen3",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "ollama_call_0",
            type: "function",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: "Austin weather" }),
            },
          },
          {
            id: "ollama_call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Austin"}' },
          },
        ],
      },
    }));
    const result = await runOllamaHostedSearchLoop({
      apiKey: "k",
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "get_weather" } },
      ],
      messages: [{ role: "user", content: "weather?" }],
      signal: new AbortController().signal,
      streamTurn,
    });
    expect(result.message.toolCalls).toEqual([
      {
        id: "ollama_call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Austin"}' },
      },
    ]);
    expect(streamTurn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns page function toolCalls without calling ollama.com", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runOllamaHostedSearchLoop({
      apiKey: "k",
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "get_weather" } },
      ],
      messages: [{ role: "user", content: "weather?" }],
      signal: new AbortController().signal,
      streamTurn: async () => ({
        model: "qwen3",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "ollama_call_0",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Austin"}' },
            },
          ],
        },
      }),
    });
    expect(result.message.toolCalls[0].function.name).toBe("get_weather");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the API key is missing", async () => {
    await expect(
      runOllamaHostedSearchLoop({
        apiKey: "",
        tools: [{ type: "web_search" }],
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        streamTurn: async () => {
          throw new Error("should not stream");
        },
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });

  it("throws after the max number of search turns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: [] })));
    await expect(
      runOllamaHostedSearchLoop({
        apiKey: "k",
        tools: [{ type: "web_search" }],
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        streamTurn: async () => ({
          model: "qwen3",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "ollama_call_0",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "q" }),
                },
              },
            ],
          },
        }),
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: expect.stringMatching(String(OLLAMA_HOSTED_SEARCH_MAX_TURNS)),
    });
  });
});
