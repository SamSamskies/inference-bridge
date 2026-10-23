// Paste into the charts demo's DevTools console, with Inference Bridge loaded:
// https://samsamskies.github.io/inference-provider-api/charts/
// Choose Google Gemini / Gemini 3.8 Flash in Options or the approval prompt.
// This uses the public IPA API; credentials stay inside the extension.
void (async () => {
  const trace = (window.geminiToolRepro = { rounds: [] });
  const messages = [
    {
      role: "user",
      content: "Use add to add 2 and 3, then state the result briefly.",
    },
  ];
  const tools = [
    {
      type: "function",
      function: {
        name: "add",
        description: "Add two numbers",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    },
  ];

  async function turn(label, toolChoice) {
    const request = {
      method: "chat",
      messages,
      tools,
      toolChoice,
      options: { reasoningEffort: "none" },
    };
    const round = { label, request: structuredClone(request), chunks: [] };
    trace.rounds.push(round);
    let done;
    for await (const chunk of window.inference.request(request)) {
      round.chunks.push(structuredClone(chunk));
      console.log(`[${label}]`, chunk);
      if (chunk.type === "done") done = chunk;
    }
    if (!done) throw new Error(`${label}: no done chunk`);
    return done;
  }

  try {
    if (!window.inference)
      throw new Error("Inference Bridge is unavailable on this page");
    const first = await turn("1: function call", {
      type: "function",
      function: { name: "add" },
    });
    if (first.model !== "gemini-3.8-flash")
      throw new Error(
        `Choose Gemini 3.8 Flash to reproduce; received ${first.model}`
      );
    if (!first.message.toolCalls?.length)
      throw new Error("Expected an add function call");
    messages.push(first.message);
    for (const call of first.message.toolCalls) {
      if (call.function.name !== "add")
        throw new Error("Unexpected function name");
      const { a, b } = JSON.parse(call.function.arguments);
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new Error("Invalid function arguments");
      console.log("Local function result:", a + b);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: String(a + b),
      });
    }
    const final = await turn("2: function result", "none");
    console.log("SUCCESS:", final.message.content);
  } catch (error) {
    trace.error = {
      name: error.name,
      code: error.code,
      message: error.message,
    };
    console.error("Reproduction failed:", trace.error);
  }
  console.log("Inspect the trace:", window.geminiToolRepro);
})();
