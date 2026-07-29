import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompatChat } from "../src/providers/openai-compat-stream.js";

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

/**
 * SSE body delivered across multiple reader chunks (tests buffer spanning).
 * @param {string[]} chunks
 * @param {number} [status]
 */
function chunkedSseResponse(chunks, status = 200) {
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
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * @param {Partial<Parameters<typeof streamOpenAICompatChat>[0]>} [overrides]
 */
function baseArgs(overrides = {}) {
  return {
    url: "https://api.example.com/v1/chat/completions",
    apiKey: "sk-test",
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    onDelta: () => {},
    label: "Example",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("streamOpenAICompatChat", () => {
  it("streams deltas, resolves model, maps usage, and sends auth + stream_options", async () => {
    const sse = [
      'data: {"id":"1","model":"gpt-resolved","choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"id":"1","choices":[{"delta":{"content":"!"}}]}',
      'data: {"id":"1","choices":[{"delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const fetchMock = vi.fn(async () => sseResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    /** @type {string[]} */
    const deltas = [];
    const result = await streamOpenAICompatChat(
      baseArgs({ onDelta: (c) => deltas.push(c) })
    );

    expect(deltas).toEqual(["Hello", "!"]);
    expect(result).toEqual({
      model: "gpt-resolved",
      message: { role: "assistant", content: "Hello!" },
      usage: { inputTokens: 4, outputTokens: 2 },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("omits Authorization when apiKey is absent and merges extraHeaders", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"x"}}]}\ndata: [DONE]\n')
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamOpenAICompatChat(
      baseArgs({
        apiKey: undefined,
        extraHeaders: { "HTTP-Referer": "https://example.com" },
      })
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
  });

  it("ignores SSE comments, blank lines, [DONE], and malformed JSON", async () => {
    const sse = [
      ": keep-alive",
      "",
      "data: not-json",
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "data:",
      "data: [DONE]",
      "",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    /** @type {string[]} */
    const deltas = [];
    const result = await streamOpenAICompatChat(
      baseArgs({ onDelta: (c) => deltas.push(c) })
    );

    expect(deltas).toEqual(["ok"]);
    expect(result.message.content).toBe("ok");
  });

  it("reassembles SSE lines split across reader chunks and flushes a final line without newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chunkedSseResponse([
          'data: {"choices":[{"delta":{"content":"par',
          't"}}]}\ndata: {"choices":[{"delta":{"content":"ial"}}]}',
        ])
      )
    );

    /** @type {string[]} */
    const deltas = [];
    const result = await streamOpenAICompatChat(
      baseArgs({ onDelta: (c) => deltas.push(c) })
    );

    expect(deltas).toEqual(["part", "ial"]);
    expect(result.message.content).toBe("partial");
  });

  it("strips trailing CR from SSE lines", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"cr"}}]}\r\ndata: [DONE]\r\n';
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    /** @type {string[]} */
    const deltas = [];
    await streamOpenAICompatChat(baseArgs({ onDelta: (c) => deltas.push(c) }));
    expect(deltas).toEqual(["cr"]);
  });

  it("throws provider_error on mid-stream error object", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      'data: {"error":{"message":"upstream failed"}}',
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sse)));

    await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "upstream failed",
    });
  });

  it("throws provider_error on mid-stream string error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse('data: {"error":"plain failure"}\n')
      )
    );

    await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "plain failure",
    });
  });

  it("maps HTTP error statuses with defaultMapStatus", async () => {
    const cases = [
      { status: 401, code: "provider_error" },
      { status: 403, code: "provider_error" },
      { status: 429, code: "provider_error" },
      { status: 400, code: "provider_error" },
      { status: 503, code: "unavailable" },
    ];

    for (const { status, code } of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: `status ${status}` } }, status)
        )
      );
      await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
        name: "InferenceError",
        code,
        message: `status ${status}`,
      });
    }
  });

  it("uses custom mapStatus when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "pay up" } }, 402))
    );

    await expect(
      streamOpenAICompatChat(
        baseArgs({
          mapStatus: (status, detail) =>
            status === 402
              ? { code: "provider_error", message: detail }
              : { code: "unavailable", message: detail },
        })
      )
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "pay up",
    });
  });

  it("falls back to label HTTP status when error JSON is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 418 }))
    );

    await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "Example HTTP 418",
    });
  });

  it("maps network failure to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: "Failed to fetch",
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
      streamOpenAICompatChat(baseArgs({ signal: controller.signal }))
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });

  it("throws provider_error when response has no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );

    await expect(streamOpenAICompatChat(baseArgs())).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "Example response had no body",
    });
  });
});
