import { describe, expect, it, vi } from "vitest";
import {
  ON_DEVICE_MODEL_ID,
  PROMPT_API_SESSION_OPTIONS,
  applyStreamChunk,
  mapMessagesForPromptApi,
  probeLanguageModelAvailability,
  streamLanguageModelChat,
  installLanguageModel,
} from "../src/prompt-api-core.js";
import { onDeviceProvider } from "../src/providers/on-device.js";

describe("mapMessagesForPromptApi", () => {
  it("maps history to initialPrompts and keeps the last user turn as prompt", () => {
    expect(
      mapMessagesForPromptApi([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Bye" },
      ])
    ).toEqual({
      initialPrompts: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      prompt: "Bye",
    });
  });

  it("rejects tool messages and non-user finals", () => {
    expect(() =>
      mapMessagesForPromptApi([{ role: "assistant", content: "x" }])
    ).toThrow(/last message/);
    expect(() =>
      mapMessagesForPromptApi([
        { role: "tool", content: "{}", toolCallId: "1" },
        { role: "user", content: "hi" },
      ])
    ).toThrow(/tool result/);
  });
});

describe("applyStreamChunk", () => {
  it("handles incremental and cumulative chunks", () => {
    expect(applyStreamChunk("", "Hel")).toEqual({ full: "Hel", delta: "Hel" });
    expect(applyStreamChunk("Hel", "lo")).toEqual({
      full: "Hello",
      delta: "lo",
    });
    expect(applyStreamChunk("Hel", "Hello")).toEqual({
      full: "Hello",
      delta: "lo",
    });
  });
});

describe("probeLanguageModelAvailability", () => {
  it("returns missing when LanguageModel is absent", async () => {
    expect(await probeLanguageModelAvailability({})).toBe("missing");
  });

  it("forwards availability strings with session language options", async () => {
    const availability = vi.fn(async () => "downloadable");
    expect(
      await probeLanguageModelAvailability({
        LanguageModel: { availability },
      })
    ).toBe("downloadable");
    expect(availability).toHaveBeenCalledWith({ ...PROMPT_API_SESSION_OPTIONS });
  });
});

describe("installLanguageModel / streamLanguageModelChat", () => {
  it("installs via create + destroy and reports progress", async () => {
    const destroy = vi.fn();
    const create = vi.fn(async ({ monitor }) => {
      const target = {
        addEventListener(type, handler) {
          if (type === "downloadprogress") handler({ loaded: 0.5 });
        },
      };
      monitor(target);
      return { destroy };
    });
    const onProgress = vi.fn();
    await installLanguageModel({
      LanguageModel: { create },
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(destroy).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: PROMPT_API_SESSION_OPTIONS.expectedInputs,
        expectedOutputs: PROMPT_API_SESSION_OPTIONS.expectedOutputs,
      })
    );
  });

  it("streams deltas and returns the sentinel model id", async () => {
    const destroy = vi.fn();
    const create = vi.fn(async () => ({
      destroy,
      promptStreaming: async function* () {
        yield "Hi";
        yield " there";
      },
    }));
    const deltas = [];
    const result = await streamLanguageModelChat({
      LanguageModel: {
        availability: async () => "available",
        create,
      },
      messages: [{ role: "user", content: "Hello" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });
    expect(deltas.join("")).toBe("Hi there");
    expect(result.model).toBe(ON_DEVICE_MODEL_ID);
    expect(result.message.content).toBe("Hi there");
    expect(destroy).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: PROMPT_API_SESSION_OPTIONS.expectedInputs,
        expectedOutputs: PROMPT_API_SESSION_OPTIONS.expectedOutputs,
      })
    );
  });

  it("refuses to stream until the model is installed", async () => {
    await expect(
      streamLanguageModelChat({
        LanguageModel: {
          availability: async () => "downloadable",
          create: vi.fn(),
        },
        messages: [{ role: "user", content: "Hello" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("onDeviceProvider", () => {
  it("is a no-key provider with sentinel model and no tools", () => {
    expect(onDeviceProvider.id).toBe("on-device");
    expect(onDeviceProvider.label).toBe("On-device");
    expect(onDeviceProvider.requiresApiKey).toBe(false);
    expect(onDeviceProvider.defaultModel).toBe(ON_DEVICE_MODEL_ID);
    expect(onDeviceProvider.supportsFunctionTools).toBe(false);
    expect(onDeviceProvider.hostedTools).toEqual([]);
  });

  it("rejects non-user finals in preflight, before any provider work", () => {
    try {
      onDeviceProvider.preflightMessages?.([
        { role: "assistant", content: "Hello" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message: "On-device provider expects the last message to be from the user.",
      });
    }
  });

  it("rejects tool messages in preflight", () => {
    try {
      onDeviceProvider.preflightMessages?.([
        { role: "tool", content: "{}", toolCallId: "1" },
        { role: "user", content: "hi" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message: "On-device provider does not support tool result messages.",
      });
    }
  });

  it("accepts user-final threads in preflight", () => {
    expect(() =>
      onDeviceProvider.preflightMessages?.([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ])
    ).not.toThrow();
  });
});
