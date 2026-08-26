import { describe, expect, it } from "vitest";
import {
  assembleAssistantContent,
  assertImagesSupported,
  blocksAllowForImages,
  collectOpenRouterImageParts,
  imageCapabilityWarnings,
  isImageGrantCovered,
  mapContentForOllama,
  mapContentForOpenAICompat,
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

  it("fail-closes image output and non-Ollama image input", () => {
    expect(() =>
      assertImagesSupported(
        { id: "openai", label: "OpenAI" },
        [{ role: "user", content: [pngPart] }],
        undefined
      )
    ).toThrow(/Ollama/);
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
});
