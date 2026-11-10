import { afterEach, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { chatAdapterContract } from "./helpers/chat-adapter-contract.js";
import { getProvider } from "../src/providers/registry.js";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";
import { saveSettings } from "../src/storage.js";

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}
const encoder = new TextEncoder();
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
function fixture(protocol, model, text) {
  const content = `Hello ${text}`;
  if (protocol === "ollama") return [
    JSON.stringify({ model, message: { content: "Hel" } }) + "\n",
    JSON.stringify({ model, message: { content: content.slice(3) }, done: true, prompt_eval_count: 2, eval_count: 3 }) + "\n",
  ];
  if (protocol === "anthropic") return [sse([
    { type: "message_start", message: { model, usage: { input_tokens: 2 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
  ]), sse([
    { type: "content_block_delta", delta: { type: "text_delta", text: content.slice(3) } },
    { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_stop" },
  ])];
  if (protocol === "gemini") return [sse([
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: "Hel" } },
  ]), sse([
    { event_type: "step.delta", index: 0, delta: { type: "text", text: content.slice(3) } },
    { event_type: "interaction.completed", interaction: { status: "completed", model, usage: { total_input_tokens: 2, total_output_tokens: 3 } } },
  ])];
  if (protocol === "responses") return [sse([{ type: "response.output_text.delta", delta: "Hel" }]), sse([
    { type: "response.output_text.delta", delta: content.slice(3) },
    { type: "response.completed", response: { model, usage: { input_tokens: 2, output_tokens: 3 } } },
  ])];
  return [sse([{ model, choices: [{ delta: { content: "Hel" } }] }]), sse([
    { model, choices: [{ delta: { content: content.slice(3) } }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  ]) + "data: [DONE]\n\n"];
}

const cases = [
  ["OpenAI Chat Completions", "openai", "compat", "gpt-5-nano", "gpt-6-luna"],
  ["OpenAI Responses", "openai", "responses", "gpt-6-luna", "gpt-6.1-sol"],
  ["Anthropic", "anthropic", "anthropic", "claude-sonnet-5-5", "claude-haiku-5-5"],
  ["Gemini", "gemini", "gemini", "gemini-3.8-flash", "gemini-4-carbon"],
  ["Ollama", "ollama", "ollama", "contract-a", "contract-b"],
  ["OpenRouter", "openrouter", "compat", "contract/model-a", "contract/model-b"],
  ["PayPerQ", "ppq", "compat", "model-a", "model-b"],
  ["Named OpenAI-compatible endpoint", "compat:contract", "compat", "model-a", "model-b"],
  ["On-device Prompt API", "on-device", "on-device", "on-device", "on-device"],
];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const [name, id, protocol, model, otherModel] of cases) {
  chatAdapterContract(name, async () => {
    installChromeMock();
    chrome.permissions = { contains: vi.fn(async () => true) };
    chrome.runtime.onMessage = event();
    chrome.runtime.getContexts = async () => [{}];
    // Explicit call configuration must win over this unrelated saved route/key.
    await saveSettings({ apiKeys: { [id]: "saved-key-must-not-be-used" }, defaultModel: "saved-model" });
    const provider = id.startsWith("compat:") ? createOpenAICompatProvider({ id, name: "Contract server", baseUrl: "https://contract.example/v1" }) : getProvider(id);
    let completionGate = Promise.resolve(), requestGate = () => Promise.resolve(), failure, wasCancelled = false;
    const calls = [], pendingNative = new Map();
    const failureText = (apiKey) => `denied ${apiKey} ${"x".repeat(1400)}`;
    function response(call) {
      if (failure === "http") return Response.json({ error: protocol === "ollama" ? failureText(call.apiKey || "private-contract-key-A") : { message: failureText(call.apiKey || "private-contract-key-A"), debug: "private-debug-field" }, debug: "private-debug-field" }, { status: 401 });
      if (failure === "network") throw Object.assign(new Error(`network ${call.apiKey}`), { request: "private-debug-field" });
      const parts = failure === "stream" ? [protocol === "ollama"
        ? JSON.stringify({ error: failureText(call.apiKey || "private-contract-key-A") }) + "\n"
        : protocol === "gemini" ? sse([{ event_type: "error", error: { message: failureText(call.apiKey || "private-contract-key-A") } }])
        : sse([{ type: "error", error: { message: failureText(call.apiKey || "private-contract-key-A"), debug: "private-debug-field" } }])]
        : fixture(protocol, call.model, call.text);
      let index = 0;
      return new Response(new ReadableStream({
        start(controller) {
          call.signal.addEventListener("abort", () => {
            wasCancelled = true;
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
        async pull(controller) {
          if (index > 0) await completionGate;
          if (call.signal.aborted) return;
          if (index < parts.length) controller.enqueue(encoder.encode(parts[index++]));
          else controller.close();
        },
        cancel() { wasCancelled = true; },
      }), { headers: { "Content-Type": protocol === "ollama" ? "application/x-ndjson" : "text/event-stream" } });
    }
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      if (url.includes("/models/")) return Response.json({ name: `models/${url.split("/").at(-1)}`, supportedGenerationMethods: ["generateContent"] });
      if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion"] });
      const body = JSON.parse(init.body);
      const last = body.messages?.at(-1)?.content || body.input?.at(-1)?.content;
      const text = typeof last === "string" ? last : last?.map((part) => part.text).join("");
      const headers = new Headers(init.headers);
      const call = { model: body.model, text, apiKey: headers.get("x-api-key") || headers.get("x-goog-api-key") || headers.get("Authorization")?.replace(/^Bearer /, ""), signal: init.signal };
      calls.push(call);
      await requestGate(call);
      return response(call);
    }));
    chrome.runtime.sendMessage = async (message) => {
      if (message.type === "prompt-api-ping") return { ok: true };
      if (message.type === "prompt-api-abort-stream") {
        wasCancelled = true;
        pendingNative.get(message.requestId)?.({ ok: false, code: "aborted", error: "Request aborted" });
        return { ok: true };
      }
      if (message.type !== "prompt-api-stream") throw new Error(`Unexpected message ${message.type}`);
      const last = message.messages.at(-1).content;
      const text = typeof last === "string" ? last : last.map((part) => part.text).join("");
      const call = { text, model };
      calls.push(call);
      await requestGate(call);
      if (failure === "network") throw new Error("Offscreen disconnected");
      if (failure) return { ok: false, code: "provider_error", error: failureText("private-contract-key-A"), debug: "private-debug-field" };
      const emit = (content) => chrome.runtime.onMessage.emit({ type: "prompt-api-stream-delta", requestId: message.requestId, content });
      emit("Hel");
      return Promise.race([
        completionGate.then(() => { emit(`lo ${text}`); return { ok: true, result: { model, message: { role: "assistant", content: `Hello ${text}` } } }; }),
        new Promise((resolve) => pendingNative.set(message.requestId, resolve)),
      ]);
    };
    return {
      provider, model, otherModel, calls, local: ["ollama", "on-device"].includes(id),
      extra: protocol === "responses" ? { tools: [{ type: "function", function: { name: "lookup" } }] } : {},
      setCompletionGate: (gate) => { completionGate = gate; },
      setRequestGate: (gate) => { requestGate = gate; },
      setFailure: (value) => { failure = value; }, cancelled: () => wasCancelled,
    };
  });
}

it("isolates simultaneous named endpoints, including an explicitly absent credential", async () => {
  installChromeMock();
  chrome.permissions = { contains: vi.fn(async () => true) };
  const endpoints = [
    { id: "compat:a", name: "A", baseUrl: "https://a.example/v1" },
    { id: "compat:b", name: "B", baseUrl: "https://b.example/v1" },
  ];
  const requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: new Headers(init.headers), body });
    return new Response(fixture("compat", body.model, body.messages[0].content).join(""));
  }));
  const results = await Promise.all(endpoints.map((endpoint, i) => createOpenAICompatProvider(endpoint).streamChat({
    model: `model-${i}`, apiKey: i ? undefined : "endpoint-a-only-key",
    messages: [{ role: "user", content: String(i) }],
    signal: new AbortController().signal, onDelta: vi.fn(),
  })));
  expect(results.map((result) => result.message.content)).toEqual(["Hello 0", "Hello 1"]);
  for (const [i, endpoint] of endpoints.entries()) {
    const request = requests.find((entry) => entry.url.startsWith(endpoint.baseUrl));
    expect(request.url).toBe(`${endpoint.baseUrl}/chat/completions`);
    expect(request.body.model).toBe(`model-${i}`);
    expect(request.headers.get("Authorization")).toBe(i ? null : "Bearer endpoint-a-only-key");
  }
});
