import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listVercelModels,
  vercelProvider,
} from "../src/providers/vercel.js";

/**
 * @param {unknown} body
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

describe("listVercelModels", () => {
  it("maps id and name, sorts by id, and keeps provider/model slugs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
            { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
            { id: "z-last/model" },
          ],
        })
      )
    );

    const models = await listVercelModels();
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-luna",
      "z-last/model",
    ]);
    expect(models).toContainEqual({
      id: "openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
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
    await expect(listVercelModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });
});

describe("vercelProvider.streamChat", () => {
  it("forwards function tools and maps hosted web_search to vercel:perplexity_search without config", async () => {
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

    const result = await vercelProvider.streamChat({
      apiKey: "vck-test",
      model: "openai/gpt-5.6-luna",
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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ai-gateway.vercel.sh/v1/chat/completions"
    );
    expect(body.tools).toEqual([
      { type: "vercel:perplexity_search" },
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ]);
    expect(body.tools[0].config).toBeUndefined();
    expect(body.tool_choice).toBe("auto");
    expect(result.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{}" },
      },
    ]);
  });

  it("sends vercel:perplexity_search when it is the only tool", async () => {
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

    await vercelProvider.streamChat({
      apiKey: "vck-test",
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "news?" }],
      tools: [{ type: "web_search" }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ type: "vercel:perplexity_search" }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits hosted web_search when toolChoice is none", async () => {
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

    await vercelProvider.streamChat({
      apiKey: "vck-test",
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "news?" }],
      tools: [{ type: "web_search" }],
      toolChoice: "none",
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("throws unavailable when no model is selected", async () => {
    await expect(
      vercelProvider.streamChat({
        apiKey: "vck-test",
        model: "",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
  });
});
