import { describe, expect, it } from "vitest";
import {
  assembleAssistantContent,
  imagePartFromOpenAIBase64,
  openaiModelSupportsImageOutput,
  assertImagesSupported,
  blocksAllowForImages,
  collectOpenRouterImageParts,
  imageCapabilityNotes,
  imageCapabilityWarnings,
  isImageGrantCovered,
  mapContentForAnthropic,
  mapContentForOllama,
  mapContentForOpenAICompat,
  mapContentForOpenAIResponses,
  messagesHaveImageParts,
  requestWantsImageOutput,
} from "../src/image-parts.js";

const pngPart = {
  type: "image",
  mediaType: "image/png",
  data: "aaa",
};

describe("image helpers", () => {
  it("detects image parts and output.images", () => {
    expect(messagesHaveImageParts([{ role: "user", content: "hi" }])).toBe(
      false
    );
    expect(
      messagesHaveImageParts([
        {
          role: "user",
          content: [{ type: "text", text: "look" }, pngPart],
        },
      ])
    ).toBe(true);
    expect(requestWantsImageOutput(undefined)).toBe(false);
    expect(requestWantsImageOutput({ images: false })).toBe(false);
    expect(requestWantsImageOutput({ images: true })).toBe(true);
  });

  it("requires distinct imageInput / imageOutput grants", () => {
    expect(
      isImageGrantCovered({}, { imageInput: true, imageOutput: false })
    ).toBe(false);
    expect(
      isImageGrantCovered({ imageInput: true }, { imageInput: true })
    ).toBe(true);
    expect(
      isImageGrantCovered(
        { imageInput: true },
        { imageInput: true, imageOutput: true }
      )
    ).toBe(false);
    expect(
      isImageGrantCovered(
        { imageInput: true, imageOutput: true },
        { imageInput: true, imageOutput: true }
      )
    ).toBe(true);
  });

  it("disables Allow for image output and non-vision Ollama / other providers", () => {
    expect(
      blocksAllowForImages(
        { id: "ollama" },
        { imageInput: true, modelHasVision: true }
      )
    ).toBe(false);
    expect(
      blocksAllowForImages(
        { id: "ollama" },
        { imageInput: true, modelHasVision: false }
      )
    ).toBe(true);
    expect(
      blocksAllowForImages({ id: "openai" }, { imageInput: true })
    ).toBe(false);
    expect(
      blocksAllowForImages(
        { id: "openai" },
        { imageOutput: true, modelCanGenerateImages: true }
      )
    ).toBe(false);
    expect(
      blocksAllowForImages({ id: "openai" }, { imageOutput: true })
    ).toBe(true);
    expect(
      blocksAllowForImages({ id: "anthropic" }, { imageInput: true })
    ).toBe(false);
    expect(
      blocksAllowForImages({ id: "compat:local" }, { imageInput: true })
    ).toBe(false);
    expect(
      blocksAllowForImages({ id: "on-device" }, { imageInput: true })
    ).toBe(false);
    expect(
      blocksAllowForImages({ id: "on-device" }, { imageOutput: true })
    ).toBe(true);
    expect(
      blocksAllowForImages({ id: "ollama" }, { imageOutput: true })
    ).toBe(true);
    expect(
      blocksAllowForImages(
        { id: "openrouter" },
        { imageOutput: true, modelCanGenerateImages: true }
      )
    ).toBe(false);
    expect(
      blocksAllowForImages(
        { id: "openrouter" },
        { imageOutput: true, modelCanGenerateImages: false }
      )
    ).toBe(true);
    expect(
      blocksAllowForImages(
        { id: "openrouter" },
        { imageInput: true, modelHasVision: true }
      )
    ).toBe(false);
  });

  it("does not claim an Ollama model lacks vision until /api/show says so", () => {
    expect(
      imageCapabilityWarnings(
        { id: "ollama", label: "Ollama" },
        { imageInput: true }
      )
    ).toEqual([]);
    expect(
      imageCapabilityWarnings(
        { id: "ollama", label: "Ollama" },
        { imageInput: true, modelHasVision: true }
      )
    ).toEqual([]);
    expect(
      imageCapabilityWarnings(
        { id: "ollama", label: "Ollama" },
        { imageInput: true, modelHasVision: false }
      )
    ).toMatchObject([expect.stringMatching(/does not support image input/)]);
  });

  it("treats OpenAI-compatible vision guidance as a note, not a blocking warning", () => {
    expect(
      imageCapabilityWarnings(
        { id: "compat:lmstudio", label: "LM Studio" },
        { imageInput: true }
      )
    ).toEqual([]);
    expect(
      imageCapabilityNotes(
        { id: "compat:lmstudio", label: "LM Studio" },
        { imageInput: true }
      )
    ).toMatchObject([expect.stringMatching(/image_url/)]);
    expect(
      imageCapabilityNotes({ id: "openai", label: "OpenAI" }, { imageInput: true })
    ).toEqual([]);
    expect(openaiModelSupportsImageOutput("gpt-4o")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-5.6-luna")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-3.5-turbo")).toBe(false);
    expect(imagePartFromOpenAIBase64("iVBORw0K")).toEqual({
      type: "image",
      mediaType: "image/png",
      data: "iVBORw0K",
    });
    expect(
      imageCapabilityNotes(
        { id: "on-device", label: "On-device" },
        { imageInput: true }
      )
    ).toMatchObject([expect.stringMatching(/Prompt API/)]);
  });

  it("maps mixed content to Ollama string + images", () => {
    expect(
      mapContentForOllama([
        { type: "text", text: "what is this?" },
        pngPart,
      ])
    ).toEqual({ content: "what is this?", images: ["aaa"] });
    expect(
      mapContentForOllama([
        {
          type: "image",
          mediaType: "image/png",
          data: "data:image/png;base64,abc",
        },
      ])
    ).toEqual({ content: "", images: ["abc"] });
  });

  it("fail-closes image output and unsupported image input", () => {
    expect(() =>
      assertImagesSupported(
        { id: "openai", label: "OpenAI" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).not.toThrow();
    expect(() =>
      assertImagesSupported(
        { id: "anthropic", label: "Anthropic" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).not.toThrow();
    expect(() =>
      assertImagesSupported(
        { id: "compat:lmstudio", label: "LM Studio" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).not.toThrow();
    expect(() =>
      assertImagesSupported(
        { id: "on-device", label: "On-device" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).not.toThrow();
    expect(() =>
      assertImagesSupported(
        { id: "on-device", label: "On-device" },
        [{ role: "user", content: "draw" }],
        { images: true }
      )
    ).toThrow(/Image output/);
    expect(() =>
      assertImagesSupported(
        { id: "ollama", label: "Ollama" },
        [{ role: "user", content: "draw" }],
        { images: true }
      )
    ).toThrow(/Image output/);
    expect(() =>
      assertImagesSupported(
        { id: "ollama", label: "Ollama" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).not.toThrow();
    expect(() =>
      assertImagesSupported(
        { id: "openrouter", label: "OpenRouter" },
        [{ role: "user", content: "draw" }],
        { images: true },
        { imageOutput: true }
      )
    ).not.toThrow();
  });

  it("assembles OpenRouter data-URL images onto done content", () => {
    const url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const parts = collectOpenRouterImageParts([
      { type: "image_url", image_url: { url } },
    ]);
    expect(assembleAssistantContent("a square", parts)).toEqual([
      { type: "text", text: "a square" },
      {
        type: "image",
        mediaType: "image/png",
        data: url.slice("data:image/png;base64,".length),
      },
    ]);
    expect(
      mapContentForOpenAICompat([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "abc" },
      ])
    ).toEqual([
      { type: "text", text: "look" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
      },
    ]);
  });

  it("maps IPA parts to Anthropic image blocks and Responses input_image", () => {
    expect(
      mapContentForAnthropic([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "abc" },
      ])
    ).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ]);
    expect(
      mapContentForOpenAIResponses([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "abc" },
      ])
    ).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,abc" },
    ]);
  });
});
