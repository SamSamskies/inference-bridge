import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  geminiProvider,
  listGeminiModels,
  mapMessagesForGemini,
} from "../src/providers/gemini.js";
import {
  geminiCapabilities,
  geminiRequestWarning,
  mapGeminiReasoningEffort,
} from "../src/providers/gemini-capabilities.js";
import { geminiFetch, readGeminiEvents } from "../src/providers/gemini-api.js";
import { geminiCallState } from "../src/providers/gemini-call-state.js";

const key = "private-test-gemini-key";
const model = "gemini-3.8-flash";
const metadata = (id = model) => ({
  name: `models/${id}`,
  displayName: id,
  supportedGenerationMethods: ["generateContent"],
});
const fn = {
  type: "function",
  function: { name: "weather", parameters: { type: "object", properties: {} } },
};
const search = { type: "web_search" };
const start = (step = { type: "model_output" }, index = 0) => ({
  event_type: "step.start",
  index,
  step,
});
const delta = (text, index = 0) => ({
  event_type: "step.delta",
  index,
  delta: { type: "text", text },
});
const end = (extra = {}) => ({
  event_type: "interaction.completed",
  interaction: { status: "completed", model, ...extra },
});
function sse(events, { fragment = false, trailing = true } = {}) {
  const text =
    events
      .map(
        (event) =>
          `event: ${event.event_type}\r\ndata: ${JSON.stringify(event)}`
      )
      .join("\r\n\r\n") + (trailing ? "\r\n\r\n" : "");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (fragment) {
          for (let i = 0; i < bytes.length; i += 3)
            controller.enqueue(bytes.slice(i, i + 3));
        } else controller.enqueue(bytes);
        controller.close();
      },
    })
  );
}
function installStream(events, opts) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      url.includes("/models/")
        ? Response.json(metadata(new URL(url).pathname.split("/").at(-1)))
        : sse(events, opts)
    )
  );
}
function chat(extra = {}) {
  return geminiProvider.streamChat({
    apiKey: key,
    model,
    messages: [{ role: "user", content: "Hi" }],
    signal: new AbortController().signal,
    onDelta: vi.fn(),
    ...extra,
  });
}
beforeEach(() => {
  geminiCallState.clear();
  installStream([start(), delta("Hello"), end()]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Gemini discovery and capability boundaries", () => {
  it("paginates the live catalog and excludes dedicated media, agents, and embeddings", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            models: [
              metadata(model),
              metadata("gemma-4-26b-a4b-it"),
              metadata("gemini-3.1-flash-lite"),
              metadata("gemini-3.5-flash-lite"),
              metadata("gemini-3.6-flash"),
              metadata("gemini-2.5-flash"),
              metadata("gemini-3.1-flash-lite-preview"),
              metadata("gemini-3.1-pro-preview"),
              metadata("gemini-3.1-pro-preview-customtools"),
              metadata("gemini-flash-latest"),
              metadata("gemini-flash-lite-latest"),
              metadata("gemini-pro-latest"),
              metadata("nano-banana-pro-preview"),
              metadata("gemini-nano-banana-2.1"),
              metadata("antigravity-preview-latest"),
              metadata("gemini-3.8-flash-tts"),
              metadata("gemini-3.5-transcribe"),
              {
                name: "models/gemini-embedding-2",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "next page",
          })
        )
        .mockResolvedValueOnce(
          Response.json({
            models: [
              metadata("gemini-4-argon"),
              metadata("gemma-4-31b-it"),
              metadata(model),
            ],
          })
        )
    );
    const models = await listGeminiModels({ apiKey: key });
    expect(models.map((entry) => entry.id)).toEqual([
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      model,
      "gemini-4-argon",
    ]);
    expect(models.map((entry) => entry.label)).toEqual([
      "Gemma 4 26B A4B IT",
      "Gemma 4 31B IT",
      "Gemini 3.1 Flash Lite",
      "Gemini 3.5 Flash Lite",
      "Gemini 3.8 Flash",
      "Gemini 4 Argon",
    ]);
    expect(models[4].inputModalities).toContain("image");
    expect(models[0].inputModalities).toEqual(["text"]);
    expect(fetch.mock.calls[1][0]).toContain("pageToken=next%20page");
    for (const [url, init] of fetch.mock.calls) {
      expect(url).not.toContain(key);
      expect(init.headers["x-goog-api-key"]).toBe(key);
    }
  });
  it("shows only account-discovered eligible models and rejects removed saved routes before acceptance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ models: [metadata(model)] }))
    );
    expect(
      (await listGeminiModels({ apiKey: key })).map((entry) => entry.id)
    ).toEqual([model]);
    fetch.mockClear();
    await expect(
      geminiProvider.preflightChat({
        model: "gemini-3.1-pro-preview",
        messages: [],
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed catalogs and repeated pagination", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ models: [], nextPageToken: "same" }))
    );
    await expect(listGeminiModels({ apiKey: key })).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never infers optional capabilities from a model prefix", () => {
    expect(geminiCapabilities("gemini-4-unknown")).toEqual({});
    expect(
      geminiRequestWarning("gemini-4-unknown", { tools: [search] })
    ).toContain("not verified");
    expect(
      geminiRequestWarning("gemini-4-argon", { tools: [search, fn] })
    ).toBe("");
    expect(
      geminiRequestWarning("gemini-2.5-flash", { tools: [search, fn] })
    ).toContain("not verified");
    expect(
      geminiRequestWarning(model, { options: { reasoningEffort: "none" } })
    ).toBe("");
    expect(
      geminiRequestWarning(model, { options: { reasoningEffort: "low" } })
    ).toBe("");
  });
  it("maps none to the lowest documented thinking level, leaving unknown controls unset", async () => {
    expect(mapGeminiReasoningEffort(model, "none")).toBe("low");
    expect(mapGeminiReasoningEffort("gemini-4-argon", "none")).toBe("low");
    expect(mapGeminiReasoningEffort("gemini-3.6-flash", "none")).toBe(
      "minimal"
    );
    expect(mapGeminiReasoningEffort("gemini-3.5-flash-lite", "none")).toBe(
      "minimal"
    );
    expect(mapGeminiReasoningEffort(model, "auto")).toBeUndefined();
    expect(mapGeminiReasoningEffort("unknown", "high")).toBeUndefined();
    await chat({ options: { reasoningEffort: "none" } });
    expect(
      JSON.parse(fetch.mock.calls.at(-1)[1].body).generation_config
        .thinking_level
    ).toBe("low");
  });
  it("does not advertise typed Decisions or MP3 synthesis", () => {
    expect(geminiProvider.decisions).toBeUndefined();
    expect(geminiProvider.decide).toBeUndefined();
    expect(geminiProvider.synthesis).toBeUndefined();
    expect(geminiProvider.synthesize).toBeUndefined();
  });
});

describe("Gemini native chat", () => {
  it.each([false, true])(
    "privately replays native function signatures (completion-only: %s) and suppresses tools",
    async (completionOnly) => {
      const native = {
        type: "function_call",
        id: "signed-call",
        name: "weather",
        arguments: { city: "Austin" },
        signature: "opaque-native-signature",
      };
      installStream(
        completionOnly
          ? [
              start({ ...native, signature: undefined, arguments: {} }),
              {
                event_type: "step.delta",
                index: 0,
                delta: {
                  type: "arguments_delta",
                  arguments: JSON.stringify(native.arguments),
                },
              },
              end({ status: "requires_action", steps: [native] }),
            ]
          : [start(native), end({ status: "requires_action" })]
      );
      const first = await chat({
        origin: "https://charts.example",
        tools: [fn],
      });
      expect(JSON.stringify(first)).not.toContain(native.signature);
      const messages = [
        { role: "user", content: "Hi" },
        first.message,
        { role: "tool", toolCallId: native.id, content: "sunny" },
      ];
      installStream([start(), delta("It is sunny."), end()]);
      await geminiProvider.preflightChat({
        apiKey: key,
        model,
        origin: "https://charts.example",
        messages,
      });
      const final = await chat({
        origin: "https://charts.example",
        messages,
        tools: [fn, search],
        toolChoice: "none",
      });
      const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
      expect(body.input.find((s) => s.type === "function_call")).toEqual(
        native
      );
      expect(body.tools).toBeUndefined();
      expect(final.message.content).toBe("It is sunny.");
      await expect(
        geminiProvider.preflightChat({
          apiKey: key,
          model,
          origin: "https://other.example",
          messages,
        })
      ).rejects.toMatchObject({ code: "unavailable" });
      const tampered = structuredClone(messages);
      tampered[1].toolCalls[0].function.arguments = JSON.stringify({
        city: "London",
      });
      await expect(
        chat({
          origin: "https://charts.example",
          messages: tampered,
          tools: [fn],
        })
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  );
  it("maps system instructions, images, function calls and function results", () => {
    expect(
      mapMessagesForGemini([
        { role: "system", content: "Be brief" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/png", data: "AQID" },
          ],
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Chicago"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "call-1", content: "sunny" },
      ])
    ).toEqual({
      system_instruction: "Be brief",
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mime_type: "image/png", data: "AQID" },
          ],
        },
        {
          type: "function_call",
          id: "call-1",
          name: "weather",
          arguments: { city: "Chicago" },
        },
        {
          type: "function_result",
          call_id: "call-1",
          name: "weather",
          result: [{ type: "text", text: "sunny" }],
        },
      ],
    });
    expect(() =>
      mapMessagesForGemini([{ role: "system", content: "Only system" }])
    ).toThrow("non-system");
    expect(() =>
      mapMessagesForGemini([
        { role: "tool", toolCallId: "unknown", content: "result" },
      ])
    ).toThrow("preceding assistant function call");
  });
  it("streams split UTF-8 records and normalizes usage with storage disabled", async () => {
    installStream(
      [
        start(),
        delta("Héllo 🌎"),
        end({ usage: { total_input_tokens: 4, total_output_tokens: 3 } }),
      ],
      { fragment: true, trailing: false }
    );
    const onDelta = vi.fn();
    const result = await chat({
      onDelta,
      options: { temperature: 0.2, reasoningEffort: "low" },
    });
    expect(result.message.content).toBe("Héllo 🌎");
    expect(onDelta).toHaveBeenCalledWith("Héllo 🌎");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
    expect(body).toMatchObject({
      model,
      store: false,
      stream: true,
      generation_config: { temperature: 0.2, thinking_level: "low" },
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("preserves sources from annotations and search results without exposing internal tool calls", async () => {
    installStream(
      [
        start({ type: "google_search_call", id: "internal", arguments: {} }),
        start(
          {
            type: "google_search_result",
            result: [{ url: "https://example.com/source", title: "Source" }],
          },
          1
        ),
        start({ type: "model_output" }, 2),
        delta("Grounded answer.", 2),
        {
          event_type: "step.delta",
          index: 2,
          delta: {
            type: "text_annotation_delta",
            annotations: [
              { type: "url_citation", url: "https://example.com/source" },
              { type: "url_citation", url: "javascript:alert(1)" },
              { url: "https://example.com/other" },
            ],
          },
        },
        end(),
      ],
      { fragment: true }
    );
    const text = [];
    const result = await chat({
      tools: [search],
      onDelta: (value) => text.push(value),
    });
    expect(result.message.toolCalls).toBeUndefined();
    expect(result.message.content).toBe(
      "Grounded answer.\n\nSources:\n- <https://example.com/source>\n- <https://example.com/other>"
    );
    expect(text.join("")).toBe(result.message.content);
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).tools).toEqual([
      { type: "google_search" },
    ]);
  });
  it.each([undefined, "none"])(
    "does not enable search when not active (%s)",
    async (choice) => {
      await chat(choice ? { tools: [search, fn], toolChoice: choice } : {});
      expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).tools).toBeUndefined();
      expect(
        JSON.parse(fetch.mock.calls.at(-1)[1].body).generation_config
          .tool_choice
      ).toBeUndefined();
    }
  );
  it("fails unsupported combinations and images before making a request", async () => {
    await expect(
      chat({ model: "gemini-2.5-flash", tools: [fn, search] })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(chat({ output: { images: true } })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      chat({
        model: "gemma-4-31b-it",
        messages: [
          {
            role: "user",
            content: [{ type: "image", mediaType: "image/png", data: "AQID" }],
          },
        ],
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("normalizes function argument fragments, and does not duplicate repeated completed steps", async () => {
    const call = {
      type: "function_call",
      id: "c1",
      name: "weather",
      arguments: {},
    };
    installStream([
      start(call),
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '{"city":' },
      },
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '"Austin"}' },
      },
      end({
        status: "requires_action",
        steps: [{ ...call, arguments: { city: "Austin" } }],
      }),
    ]);
    const result = await chat({
      tools: [fn],
      toolChoice: { type: "function", function: { name: "weather" } },
    });
    expect(result.message.toolCalls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Austin"}' },
      },
    ]);
    expect(
      JSON.parse(fetch.mock.calls.at(-1)[1].body).generation_config.tool_choice
    ).toEqual({ allowed_tools: { mode: "any", tools: ["weather"] } });
  });
  it("supports mixed native search and functions on Argon", async () => {
    await chat({ model: "gemini-4-argon", tools: [search, fn] });
    expect(
      JSON.parse(fetch.mock.calls.at(-1)[1].body).tools.map((tool) => tool.type)
    ).toEqual(["google_search", "function"]);
  });
  it("does not duplicate completed text, and streams thought summaries separately", async () => {
    installStream([
      start(),
      {
        event_type: "step.delta",
        index: 1,
        delta: {
          type: "thought_summary",
          content: { type: "text", text: "Summary" },
        },
      },
      delta("Answer"),
      end({
        steps: [
          { type: "model_output", content: [{ type: "text", text: "Answer" }] },
        ],
      }),
    ]);
    const reasoning = vi.fn();
    const result = await chat({ onReasoningDelta: reasoning });
    expect(result.message).toMatchObject({
      content: "Answer",
      reasoning: "Summary",
    });
    expect(reasoning).toHaveBeenCalledWith("Summary");
  });
  it.each([
    [start(), delta("partial")],
    [start(), end({ status: "failed" })],
    [
      start({
        type: "function_call",
        id: "x",
        name: "undeclared",
        arguments: {},
      }),
      end(),
    ],
  ])("rejects incomplete or invalid provider streams", async (...events) => {
    installStream(events);
    await expect(chat()).rejects.toMatchObject({ code: "provider_error" });
  });
  it("cancels a pending reader on abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readGeminiEvents(response, {
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(cancel).toHaveBeenCalled();
  });
});

describe("Gemini credentials and errors", () => {
  it("reads HTTP errors encoded as native SSE records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            'event: error\ndata: {"error":{"message":"Tool configuration requires tools"}}\n\n',
            { status: 400 }
          )
      )
    );
    await expect(
      geminiFetch("/v1beta/interactions", { apiKey: key })
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("Tool configuration requires tools"),
    });
  });
  it("reads HTTP errors wrapped in the streaming API's JSON array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([{ error: { message: "Invalid tool result" } }], {
          status: 400,
        })
      )
    );
    await expect(
      geminiFetch("/v1beta/interactions", { apiKey: key })
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("Invalid tool result"),
    });
  });
  it("reads native top-level error messages without an error wrapper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "invalid_argument", message: "Invalid Gemini tool choice" },
          { status: 400 }
        )
      )
    );
    await expect(
      geminiFetch("/v1beta/interactions", { apiKey: key })
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("Invalid Gemini tool choice"),
    });
  });
  it("stops at completion before a trailing SSE DONE sentinel", async () => {
    const payload =
      [start(), delta("OK"), end()]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        url.includes("/models/")
          ? Response.json(metadata())
          : new Response(payload)
      )
    );
    expect((await chat()).message.content).toBe("OK");
  });
  it.each([
    [401, "authentication"],
    [403, "permissions"],
    [429, "quota"],
    [400, "API billing"],
    [503, "HTTP 503"],
  ])("gives useful safe errors for HTTP %s", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: `${status === 400 ? "Billing required" : "Denied"} ${key}`,
            },
          },
          { status }
        )
      )
    );
    const error = await geminiFetch("/v1beta/models", { apiKey: key }).catch(
      (error) => error
    );
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(key);
    expect(error.code).toBe(status >= 500 ? "unavailable" : "provider_error");
  });
  it("rejects credential-bearing cross-host upload URLs and missing keys without a fetch", async () => {
    await expect(
      geminiFetch("https://evil.example/upload", { apiKey: key })
    ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      geminiFetch("/v1beta/models", { apiKey: " " })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns aborted without sending a request for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(chat({ signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
