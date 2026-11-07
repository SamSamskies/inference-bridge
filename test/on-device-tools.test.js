import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapMessagesForPromptApi,
  promptApiChatOptions,
  streamLanguageModelChat,
} from "../src/prompt-api-core.js";
import { runTools } from "../src/run-tools.js";
import { installChromeMock } from "./helpers/chrome-mock.js";

// Native fields live on prototypes and do not survive Chrome JSON messaging.
class NativeToolCall {
  constructor(init) { Object.defineProperty(this, "init", { value: init }); }
  get callId() { return this.init.callId; }
  get name() { return this.init.name; }
  get arguments() { return this.init.arguments; }
}
class NativeToolSuccess {
  constructor(init) { Object.defineProperty(this, "init", { value: init }); }
  get callId() { return this.init.callId; }
  get name() { return this.init.name; }
  get result() { return this.init.result; }
}
const toolScope = {
  LanguageModelToolCall: NativeToolCall,
  LanguageModelToolSuccess: NativeToolSuccess,
  LanguageModelToolError: class {},
};
const tools = [{ type: "function", function: {
  name: "weather", description: "Look up weather",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
} }];
const call = (id = "call-1", city = "Austin") => ({
  id, type: "function", function: { name: "weather", arguments: JSON.stringify({ city }) },
});
const history = () => [
  { role: "user", content: "Compare Austin and Chicago." },
  { role: "assistant", content: "Checking.", toolCalls: [call(), call("call-2", "Chicago")] },
  { role: "tool", toolCallId: "call-1", content: '{"tempC":22,"rain":null}' },
  { role: "tool", toolCallId: "call-2", content: "Cold" },
];
const signal = () => new AbortController().signal;
const languageModel = (chunks, overrides = {}) => ({
  availability: vi.fn(async () => "available"),
  create: vi.fn(async () => ({
    destroy: vi.fn(),
    promptStreaming: async function* () { yield* chunks; },
  })),
  ...overrides,
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native on-device tools", () => {
  it("maps mixed text and parallel calls without stringifying native chunks as text", async () => {
    const LM = languageModel([
      "Checking.",
      { type: "tool-call", value: new NativeToolCall({ callId: "call-1", name: "weather", arguments: { city: "Austin" } }) },
      { type: "tool-call", value: { callID: "call-2", name: "weather", arguments: { city: "Chicago" } } },
    ]);
    const onDelta = vi.fn();
    const result = await streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history().slice(0, 1), signal: signal(), onDelta });
    expect(result.message).toEqual({ role: "assistant", content: "Checking.", toolCalls: [call(), call("call-2", "Chicago")] });
    expect(onDelta.mock.calls).toEqual([["Checking."]]);
    expect(LM.availability).toHaveBeenCalledWith(expect.objectContaining({
      tools: [{ name: "weather", description: "Look up weather", inputSchema: tools[0].function.parameters }],
      expectedInputs: expect.arrayContaining([{ type: "tool-response" }]),
      expectedOutputs: expect.arrayContaining([{ type: "tool-call" }]),
    }));
    expect((await LM.create.mock.results[0].value).destroy).toHaveBeenCalledOnce();
  });

  it("restores calls using native instances and groups parallel results as the final user prompt", () => {
    const mapped = mapMessagesForPromptApi(history(), { scope: toolScope });
    const parts = mapped.initialPrompts[1].content;
    expect(parts[0]).toEqual({ type: "text", value: "Checking." });
    expect(parts[1].value).toBeInstanceOf(NativeToolCall);
    expect(parts[1].value.arguments).toEqual({ city: "Austin" });
    expect(mapped.prompt).toHaveLength(2);
    expect(mapped.prompt[0].value).toBeInstanceOf(NativeToolSuccess);
    expect(mapped.prompt[0].value.callId).toBe("call-1");
    expect(mapped.prompt[0].value.name).toBe("weather");
    expect(mapped.prompt[0].value.result).toEqual([{ type: "text", value: '{"tempC":22,"rain":null}' }]);
    expect(mapped.prompt[1].value.result).toEqual([{ type: "text", value: "Cold" }]);
    const later = mapMessagesForPromptApi([...history(), { role: "assistant", content: "Done" }, { role: "user", content: "Thanks" }]);
    expect(later.prompt).toBe("Thanks");
    expect(later.initialPrompts[2]).toMatchObject({ role: "user", content: [{ type: "tool-response" }, { type: "tool-response" }] });
  });

  it("keeps IDs unique when a fresh native session reuses a prior call ID", async () => {
    const LM = languageModel([{ type: "tool-call", value: { callId: "call-1", name: "weather", arguments: { city: "Boston" } } }]);
    const result = await streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history(), signal: signal(), onDelta: vi.fn() });
    expect(result.message.toolCalls[0].id).toBe("call-1_1");
    expect(() => mapMessagesForPromptApi([...history(), result.message,
      { role: "tool", toolCallId: "call-1_1", content: "Snow" }])).not.toThrow();
  });

  it("assigns unique IPA IDs to empty, missing and repeated native IDs", async () => {
    const values = [
      { callId: "", name: "weather", arguments: { city: "Austin" } },
      { name: "weather", arguments: { city: "Chicago" } },
      { callID: "same", name: "weather", arguments: { city: "Boston" } },
      { callID: "same", name: "weather", arguments: { city: "Denver" } },
    ];
    const LM = languageModel(values.map((value) => ({ type: "tool-call", value })));
    const result = await streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history().slice(0, 1), signal: signal(), onDelta: vi.fn() });
    const calls = result.message.toolCalls;
    expect(calls.map((call) => call.id)).toEqual(["on_device_tool", "on_device_tool_1", "same", "same_1"]);
    const messages = [...history().slice(0, 1), result.message,
      ...calls.map((call) => ({ role: "tool", toolCallId: call.id, content: "Sunny" }))];
    const mapped = mapMessagesForPromptApi(messages, { scope: toolScope });
    expect(mapped.prompt.map((part) => part.value.callId)).toEqual(calls.map((call) => call.id));
  });

  it.each([null, undefined, "", '{"city":"Austin"}'])("normalizes native arguments %j to an IPA JSON object", async (args) => {
    const LM = languageModel([{ type: "tool-call", value: new NativeToolCall({ callId: "call-1", name: "weather", arguments: args }) }]);
    const result = await streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history().slice(0, 1), signal: signal(), onDelta: vi.fn() });
    expect(result.message.toolCalls[0].function.arguments).toBe(args || "{}");
  });

  it.each([
    ["missing result", () => history().slice(0, -1)],
    ["unknown result", () => [{ role: "tool", toolCallId: "unknown", content: "x" }]],
    ["duplicate result", () => [...history(), history()[2]]],
    ["duplicate call ID", () => [history()[0], { ...history()[1], toolCalls: [call(), call()] }, ...history().slice(2)]],
    ["malformed arguments", () => [history()[0], { ...history()[1], toolCalls: [{ ...call(), function: { name: "weather", arguments: "oops" } }] }, history()[2]]],
    ["non-object arguments", () => [history()[0], { ...history()[1], toolCalls: [{ ...call(), function: { name: "weather", arguments: "null" } }] }, history()[2]]],
  ])("rejects %s in preflight", (_, getMessages) => {
    expect(() => mapMessagesForPromptApi(getMessages())).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("omits tools for none while retaining the input types needed for tool history", async () => {
    const LM = languageModel(["Done."]);
    const result = await streamLanguageModelChat({ LanguageModel: LM, toolScope, tools, toolChoice: "none",
      messages: history(), signal: signal(), onDelta: vi.fn() });
    expect(result.message).toEqual({ role: "assistant", content: "Done." });
    const options = LM.create.mock.calls[0][0];
    expect(options).not.toHaveProperty("tools");
    expect(options.expectedOutputs).not.toContainEqual({ type: "tool-call" });
    expect(options.expectedInputs).toEqual(expect.arrayContaining([{ type: "tool-call" }, { type: "tool-response" }]));
    expect(promptApiChatOptions({ tools, toolChoice: "none" }).expectedInputs).not.toContainEqual({ type: "tool-response" });
  });

  it.each(["required", { type: "function", function: { name: "weather" } }])("fails closed on unsupported choice %j", async (toolChoice) => {
    const LM = languageModel([]);
    await expect(streamLanguageModelChat({ LanguageModel: LM, toolScope, tools, toolChoice,
      messages: history().slice(0, 1), signal: signal(), onDelta: vi.fn() })).rejects.toMatchObject({ code: "unavailable" });
    expect(LM.create).not.toHaveBeenCalled();
  });

  it("supplies an empty object schema by default and rejects unsupported schemas", () => {
    expect(promptApiChatOptions({ tools: [{ type: "function", function: { name: "ping" } }] }).tools[0].inputSchema)
      .toEqual({ type: "object", properties: {} });
    expect(() => promptApiChatOptions({ tools: [{ type: "function", function: { name: "ping", parameters: { type: "array" } } }] }))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    const options = promptApiChatOptions({ wantsImage: true, tools, wantsToolHistory: true });
    expect(options.expectedInputs).toEqual(expect.arrayContaining([{ type: "image" }, { type: "tool-call" }, { type: "tool-response" }]));
  });

  it.each([
    { type: "tool-call", value: { callId: "x", name: "weather", arguments: [] } },
    { type: "tool-call", value: { callId: "x", name: "weather", arguments: "invalid JSON" } },
    { type: "tool-call", value: { callId: "x", name: "weather", arguments: "42" } },
    { type: "tool-call", value: { callId: "x", arguments: {} } },
    { type: "unknown", value: {} },
  ])("rejects malformed native output and destroys the session", async (chunk) => {
    const LM = languageModel([chunk]);
    await expect(streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history().slice(0, 1), signal: signal(), onDelta: vi.fn() })).rejects.toMatchObject({ code: "provider_error" });
    expect((await LM.create.mock.results[0].value).destroy).toHaveBeenCalledOnce();
  });

  it("aborts while waiting for tool chunks and destroys the session", async () => {
    const controller = new AbortController();
    const destroy = vi.fn();
    const LM = languageModel([], { create: vi.fn(async () => ({ destroy, promptStreaming: async function* () {
      yield "Checking";
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    } })) });
    await expect(streamLanguageModelChat({ LanguageModel: LM, toolScope, tools,
      messages: history().slice(0, 1), signal: controller.signal, onDelta: vi.fn() })).rejects.toMatchObject({ code: "aborted" });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("on-device offscreen relay", () => {
  let provider;
  let LM;
  let listeners;
  beforeEach(async () => {
    vi.resetModules();
    installChromeMock();
    listeners = new Set();
    chrome.runtime.onMessage = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
    chrome.runtime.getContexts = async () => [{}];
    // Approximate Chrome's JSON message serialization. Native values must be
    // normalized within the host, and hydrated there on the follow-up request.
    chrome.runtime.sendMessage = vi.fn((message) => new Promise((resolve) => {
      const wire = JSON.parse(JSON.stringify(message));
      let asyncResponse = false;
      for (const listener of listeners) {
        if (listener(wire, {}, (value) => resolve(JSON.parse(JSON.stringify(value)))) === true) asyncResponse = true;
      }
      if (!asyncResponse) resolve(undefined);
    }));
    Object.entries(toolScope).forEach(([key, value]) => vi.stubGlobal(key, value));
    LM = languageModel([]);
    vi.stubGlobal("LanguageModel", LM);
    await import("../offscreen/prompt-api.js");
    provider = (await import("../src/providers/on-device.js")).onDeviceProvider;
  });

  it("runs the existing page tool loop through provider, client and native host", async () => {
    const prompts = [];
    const sessions = [];
    LM.create.mockImplementation(async (options) => {
      const session = { destroy: vi.fn(), promptStreaming: async function* (input) {
        prompts.push({ options, input });
        if (!options.initialPrompts?.length) {
          yield "Checking.";
          yield { type: "tool-call", value: new NativeToolCall({ callId: "", name: "weather", arguments: { city: "Austin" } }) };
          yield { type: "tool-call", value: new NativeToolCall({ callId: "", name: "weather", arguments: '{"city":"Chicago"}' }) };
        } else {
          yield "Austin is warmer.";
        }
      } };
      sessions.push(session);
      return session;
    });
    const execute = vi.fn(({ city }) => ({ city, tempC: city === "Austin" ? 22 : 5, rain: null }));
    const deltas = [];
    const request = async function* (args) {
      provider.preflightMessages(args.messages);
      await provider.preflightChat(args);
      yield { type: "accepted" };
      const result = await provider.streamChat({ ...args, signal: signal(), onDelta: (text) => deltas.push(text) });
      yield { type: "done", ...result };
    };
    const result = await runTools({ request, messages: history().slice(0, 1), tools, execute: { weather: execute } });
    expect(execute.mock.calls).toEqual([[{ city: "Austin" }], [{ city: "Chicago" }]]);
    expect(result.final.message.content).toBe("Austin is warmer.");
    expect(deltas).toEqual(["Checking.", "Austin is warmer."]);
    expect(prompts[1].options.initialPrompts[1].content[1].value).toBeInstanceOf(NativeToolCall);
    expect(prompts[1].input[0].content[0].value).toBeInstanceOf(NativeToolSuccess);
    expect(prompts[1].input[0].content[0].value.result[0].value).toBe('{"city":"Austin","tempC":22,"rain":null}');
    expect(sessions.every((session) => session.destroy.mock.calls.length === 1)).toBe(true);
    expect(listeners.size).toBe(1); // Only the host listener remains.
  });

  it("fails preflight with flag guidance when native tool support is missing, while plain chat works", async () => {
    vi.stubGlobal("LanguageModelToolCall", undefined);
    await expect(provider.preflightChat({ messages: history().slice(0, 1), tools })).rejects.toMatchObject({
      code: "unavailable", message: expect.stringContaining("chrome://flags/#prompt-api-tool-use"),
    });
    expect(LM.create).not.toHaveBeenCalled();
    await expect(provider.preflightChat({ messages: history().slice(0, 1) })).resolves.toBeUndefined();
    await expect(provider.preflightChat({ messages: history().slice(0, 1), tools, toolChoice: "none" })).resolves.toBeUndefined();
  });
});
