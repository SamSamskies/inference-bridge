import { openaiModelSupportsImageOutput } from "../src/providers/openai-capabilities.js";
import { describe, expect, it } from "vitest";
import {
  assembleAssistantContent,
  imagePartFromOpenAIBase64,
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

  it("uses resolved model capabilities independently of provider identity", () => {
    for (const state of [false, null, undefined]) {
      expect(blocksAllowForImages({ imageInput: state }, { imageInput: true })).toBe(true);
      expect(blocksAllowForImages({ imageOutput: state }, { imageOutput: true })).toBe(true);
    }
    expect(blocksAllowForImages({ imageInput: true }, { imageInput: true })).toBe(false);
    expect(blocksAllowForImages({ imageOutput: true }, { imageOutput: true })).toBe(false);
    expect(blocksAllowForImages({ imageInput: false, imageOutput: true }, { imageInput: true, imageOutput: true })).toBe(true);
    expect(blocksAllowForImages({ imageInput: null, imageInputPassthrough: true }, { imageInput: true })).toBe(false);
    expect(blocksAllowForImages({ imageInput: false, imageInputPassthrough: true }, { imageInput: true })).toBe(true);
  });

  it("distinguishes unverified vision from an unsupported model", () => {
    const provider = { label: "Ollama" };
    expect(imageCapabilityWarnings(provider, { imageInput: true }, { imageInput: null }))
      .toMatchObject([expect.stringMatching(/could not verify image input/)]);
    expect(imageCapabilityWarnings(provider, { imageInput: true }, { imageInput: false }))
      .toMatchObject([expect.stringMatching(/does not support image input/)]);
    expect(imageCapabilityWarnings(provider, { imageInput: true }, { imageInput: true })).toEqual([]);
  });

  it("keeps adapter-supplied guidance informational for unverified native forwarding", () => {
    const caps = { imageInput: null, imageInputPassthrough: true, imageInputNote: "Forwarded as image_url" };
    expect(imageCapabilityWarnings({ label: "Local server" }, { imageInput: true }, caps)).toEqual([]);
    expect(imageCapabilityNotes({ imageInput: true }, caps)).toEqual([caps.imageInputNote]);
    expect(imageCapabilityNotes({}, caps)).toEqual([]);
    expect(openaiModelSupportsImageOutput("gpt-4o")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-5.6-luna")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-6-astra")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-6.1-sol")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-6.1-terra")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-6-sol")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-6-luna")).toBe(true);
    expect(openaiModelSupportsImageOutput("gpt-3.5-turbo")).toBe(false);
    expect(imagePartFromOpenAIBase64("iVBORw0K")).toEqual({
      type: "image",
      mediaType: "image/png",
      data: "iVBORw0K",
    });

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

  it("rejects required images unless the resolved capability permits them", () => {
    const provider = { label: "Test provider" };
    const messages = [{ role: "user", content: [pngPart] }];
    expect(() => assertImagesSupported(provider, messages)).toThrow(/Image input/);
    expect(() => assertImagesSupported(provider, messages, undefined, { imageInput: true })).not.toThrow();
    expect(() => assertImagesSupported(provider, messages, undefined, { imageInput: null, imageInputPassthrough: true })).not.toThrow();
    expect(() => assertImagesSupported(provider, [], { images: true })).toThrow(/Image output/);
    expect(() => assertImagesSupported(provider, messages, { images: true }, { imageOutput: true })).toThrow(/Image input/);
    expect(() => assertImagesSupported(provider, messages, { images: true }, { imageOutput: true, imageInput: true })).not.toThrow();
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
