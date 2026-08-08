import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listOllamaModels,
  ollamaProvider,
  OLLAMA_BASE_URL,
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
});
