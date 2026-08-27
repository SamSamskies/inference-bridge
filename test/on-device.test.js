import { describe, expect, it, vi } from "vitest";
import {
  ON_DEVICE_MODEL_ID,
  PROMPT_API_SESSION_OPTIONS,
  PROMPT_API_VISION_SESSION_OPTIONS,
  applyStreamChunk,
  assertOnDeviceAvailable,
  mapContentForPromptApi,
  mapMessagesForPromptApi,
  wrapPromptForPromptApi,
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

  it("rejects system messages that are not first in initialPrompts", () => {
    expect(() =>
      mapMessagesForPromptApi([
        { role: "user", content: "Hi" },
        { role: "system", content: "Be brief." },
        { role: "user", content: "Bye" },
      ])
    ).toThrow(/system message only as the first/);
    expect(() =>
      mapMessagesForPromptApi([
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "Hi" },
      ])
    ).toThrow(/system message only as the first/);
  });

  it("maps image parts to Prompt API image blobs", () => {
    const mapped = mapContentForPromptApi([
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", data: "YQ==" },
    ]);
    expect(Array.isArray(mapped)).toBe(true);
    expect(mapped[0]).toEqual({ type: "text", value: "what is this?" });
    expect(mapped[1]).toMatchObject({ type: "image" });
    expect(mapped[1].value).toBeInstanceOf(Blob);
    expect(mapped[1].value.type).toBe("image/png");

    expect(
      mapMessagesForPromptApi([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "YQ==" },
          ],
        },
      ]).prompt
    ).toEqual(mapped);

    expect(wrapPromptForPromptApi(mapped)).toEqual([
      { role: "user", content: mapped },
    ]);
    expect(wrapPromptForPromptApi("hello")).toBe("hello");
  });

  it("rejects image parts whose base64 cannot be decoded", () => {
    try {
      mapContentForPromptApi([
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: "!!!" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message: "Image part data must be valid base64.",
      });
    }
    expect(() =>
      mapMessagesForPromptApi([
        {
          role: "user",
          content: [{ type: "image", mediaType: "image/png", data: "!!!" }],
        },
      ])
    ).toThrow(/valid base64/);
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

describe("assertOnDeviceAvailable", () => {
  it("allows available", () => {
    expect(() => assertOnDeviceAvailable("available")).not.toThrow();
  });

  it("rejects downloadable and downloading with install guidance", () => {
    for (const availability of ["downloadable", "downloading"]) {
      try {
        assertOnDeviceAvailable(
          /** @type {import("../src/prompt-api-core.js").OnDeviceAvailability} */ (
            availability
          )
        );
        expect.unreachable("expected throw");
      } catch (err) {
        expect(/** @type {any} */ (err).code).toBe("unavailable");
        expect(err).toMatchObject({
          name: "InferenceError",
          message:
            "Install the on-device model in Inference Bridge Options before using this provider.",
        });
      }
    }
  });

  it("rejects missing and unavailable as device-level unavailable", () => {
    for (const availability of ["missing", "unavailable"]) {
      try {
        assertOnDeviceAvailable(
          /** @type {import("../src/prompt-api-core.js").OnDeviceAvailability} */ (
            availability
          )
        );
        expect.unreachable("expected throw");
      } catch (err) {
        expect(/** @type {any} */ (err).code).toBe("unavailable");
        expect(err).toMatchObject({
          name: "InferenceError",
          message:
            "On-device AI is unavailable on this device (hardware, OS, or browser flags).",
        });
      }
    }
  });

  it("rejects vision gaps with vision-specific copy", () => {
    for (const availability of ["downloadable", "downloading"]) {
      try {
        assertOnDeviceAvailable(
          /** @type {import("../src/prompt-api-core.js").OnDeviceAvailability} */ (
            availability
          ),
          { wantsImage: true }
        );
        expect.unreachable("expected throw");
      } catch (err) {
        expect(/** @type {any} */ (err).code).toBe("unavailable");
        expect(err).toMatchObject({
          name: "InferenceError",
          message:
            "On-device vision is not installed. Re-run Install in Options, then try again.",
        });
      }
    }
    for (const availability of ["missing", "unavailable"]) {
      try {
        assertOnDeviceAvailable(
          /** @type {import("../src/prompt-api-core.js").OnDeviceAvailability} */ (
            availability
          ),
          { wantsImage: true }
        );
        expect.unreachable("expected throw");
      } catch (err) {
        expect(/** @type {any} */ (err).code).toBe("unavailable");
        expect(err).toMatchObject({
          name: "InferenceError",
          message: "On-device vision is not available in this browser.",
        });
      }
    }
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
        expectedInputs: PROMPT_API_VISION_SESSION_OPTIONS.expectedInputs,
        expectedOutputs: PROMPT_API_VISION_SESSION_OPTIONS.expectedOutputs,
      })
    );
  });

  it("falls back to text session options when vision install is unsupported", async () => {
    const destroy = vi.fn();
    const create = vi.fn(async (options) => {
      const hasImage = (options.expectedInputs || []).some(
        (input) => input.type === "image"
      );
      if (hasImage) throw new Error("image input unsupported");
      return { destroy };
    });
    await installLanguageModel({ LanguageModel: { create } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].expectedInputs).toEqual(
      PROMPT_API_SESSION_OPTIONS.expectedInputs
    );
    expect(destroy).toHaveBeenCalled();
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

  it("uses vision session options and image blobs when messages include image parts", async () => {
    const destroy = vi.fn();
    const availability = vi.fn(async () => "available");
    /** @type {unknown} */
    let streamedInput;
    const create = vi.fn(async () => ({
      destroy,
      promptStreaming: async function* (input) {
        streamedInput = input;
        yield "a cat";
      },
    }));
    const result = await streamLanguageModelChat({
      LanguageModel: { availability, create },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "YQ==" },
          ],
        },
      ],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    expect(result.message.content).toBe("a cat");
    expect(availability).toHaveBeenCalledWith({
      ...PROMPT_API_VISION_SESSION_OPTIONS,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: PROMPT_API_VISION_SESSION_OPTIONS.expectedInputs,
      })
    );
    expect(streamedInput).toEqual([
      {
        role: "user",
        content: [
          { type: "text", value: "what is this?" },
          expect.objectContaining({ type: "image", value: expect.any(Blob) }),
        ],
      },
    ]);
  });

  it("fail-closes vision when the Prompt API cannot take image input", async () => {
    await expect(
      streamLanguageModelChat({
        LanguageModel: {
          availability: async () => "unavailable",
          create: vi.fn(),
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", mediaType: "image/png", data: "YQ==" },
            ],
          },
        ],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      code: "unavailable",
      message: /On-device vision is not available/,
    });
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

  it("fails closed with unavailable when hosted web_search is requested", async () => {
    await expect(
      onDeviceProvider.streamChat({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search" }],
        signal: new AbortController().signal,
        onDelta: () => {},
      })
    ).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
    });
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

  it("rejects misplaced system messages in preflight", () => {
    try {
      onDeviceProvider.preflightMessages?.([
        { role: "user", content: "Hi" },
        { role: "system", content: "Be brief." },
        { role: "user", content: "Bye" },
      ]);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(/** @type {any} */ (err).code).toBe("invalid_request");
      expect(err).toMatchObject({
        name: "InferenceError",
        message:
          "On-device provider allows a system message only as the first message.",
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

  it("accepts user image parts in preflight", () => {
    expect(() =>
      onDeviceProvider.preflightMessages?.([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "YQ==" },
          ],
        },
      ])
    ).not.toThrow();
  });
});
