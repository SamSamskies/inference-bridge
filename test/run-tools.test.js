import { describe, expect, it, vi } from "vitest";
import {
  parseToolArguments,
  runTools,
  serializeToolResult,
} from "../src/run-tools.js";

/**
 * @param {Array<object | object[]>} turns
 *   Each turn is a list of chunks, or a single done-like message object turned into a done chunk.
 */
function scriptedRequest(turns) {
  let i = 0;
  return () => {
    const turn = turns[i++];
    const chunks = Array.isArray(turn)
      ? turn
      : [
          { type: "accepted" },
          { type: "done", message: turn, model: "test-model" },
        ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  };
}

const weatherTools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  },
];

describe("serializeToolResult / parseToolArguments", () => {
  it("keeps strings and JSON-stringifies objects", () => {
    expect(serializeToolResult("already")).toBe("already");
    expect(serializeToolResult({ tempC: 22 })).toBe('{"tempC":22}');
  });

  it("parses arguments JSON and treats empty as {}", () => {
    expect(parseToolArguments('{"city":"Austin"}', "get_weather")).toEqual({
      city: "Austin",
    });
    expect(parseToolArguments("", "get_weather")).toEqual({});
    expect(parseToolArguments(null, "get_weather")).toEqual({});
  });

  it("throws invalid_request on bad JSON", () => {
    try {
      parseToolArguments("{", "get_weather");
      expect.unreachable();
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({ name: "InferenceError" });
    }
  });
});

describe("runTools", () => {
  it("runs tool_calls then returns the final text done chunk", async () => {
    const execute = {
      get_weather: vi.fn(async ({ city }) => ({ city, tempC: 22 })),
    };

    const result = await runTools({
      request: scriptedRequest([
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
          role: "assistant",
          content: "It is 22°C in Austin.",
        },
      ]),
      messages: [{ role: "user", content: "Weather in Austin?" }],
      tools: weatherTools,
      execute,
    });

    expect(execute.get_weather).toHaveBeenCalledWith({ city: "Austin" });
    expect(result.final.message.content).toBe("It is 22°C in Austin.");
    expect(result.messages).toEqual([
      { role: "user", content: "Weather in Austin?" },
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
        content: '{"city":"Austin","tempC":22}',
      },
      { role: "assistant", content: "It is 22°C in Austin." },
    ]);
  });

  it("forwards tools and tool_choice on each round", async () => {
    /** @type {object[]} */
    const seen = [];
    const request = (req) => {
      seen.push(req);
      if (seen.length === 1) {
        return scriptedRequest([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
        ])();
      }
      return scriptedRequest([{ role: "assistant", content: "done" }])();
    };

    await runTools({
      request,
      messages: [{ role: "user", content: "hi" }],
      tools: weatherTools,
      tool_choice: "auto",
      execute: { get_weather: async () => ({ ok: true }) },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].tools).toEqual(weatherTools);
    expect(seen[0].tool_choice).toBe("auto");
    expect(seen[1].tools).toEqual(weatherTools);
    expect(seen[1].tool_choice).toBe("auto");
    expect(seen[1].messages).toHaveLength(3);
  });

  it("throws when execute handler is missing", async () => {
    await expect(
      runTools({
        request: scriptedRequest([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
        ]),
        messages: [{ role: "user", content: "hi" }],
        tools: weatherTools,
        execute: {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "invalid_request",
      message: 'No execute handler for tool "get_weather".',
    });
  });

  it("throws when maxRounds is exceeded", async () => {
    const request = scriptedRequest([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c2",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      },
    ]);

    await expect(
      runTools({
        request,
        messages: [{ role: "user", content: "hi" }],
        tools: weatherTools,
        execute: { get_weather: async () => ({ ok: true }) },
        maxRounds: 2,
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "provider_error",
      message: "Tool loop exceeded maxRounds (2).",
    });
  });

  it("propagates executor errors", async () => {
    await expect(
      runTools({
        request: scriptedRequest([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
        ]),
        messages: [{ role: "user", content: "hi" }],
        execute: {
          get_weather: async () => {
            throw new Error("network down");
          },
        },
      })
    ).rejects.toThrow("network down");
  });

  it("forwards onDelta across turns", async () => {
    const deltas = [];
    await runTools({
      request: scriptedRequest([
        [
          { type: "delta", content: "calling " },
          {
            type: "done",
            message: {
              role: "assistant",
              content: "calling ",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "get_weather", arguments: "{}" },
                },
              ],
            },
          },
        ],
        [
          { type: "delta", content: "22C" },
          {
            type: "done",
            message: { role: "assistant", content: "22C" },
          },
        ],
      ]),
      messages: [{ role: "user", content: "hi" }],
      execute: { get_weather: async () => ({ tempC: 22 }) },
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["calling ", "22C"]);
  });

  it("rejects when AbortSignal is already aborted", async () => {
    const signal = AbortSignal.abort();
    await expect(
      runTools({
        request: scriptedRequest([{ role: "assistant", content: "hi" }]),
        messages: [{ role: "user", content: "hi" }],
        signal,
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "aborted",
    });
  });

  it("returns immediately when the first turn has no tool_calls", async () => {
    const result = await runTools({
      request: scriptedRequest([
        { role: "assistant", content: "Just text." },
      ]),
      messages: [{ role: "user", content: "hi" }],
      tools: weatherTools,
      execute: { get_weather: async () => ({}) },
    });

    expect(result.final.message.content).toBe("Just text.");
    expect(result.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Just text." },
    ]);
  });
});
