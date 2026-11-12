import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import images from "./fixtures/decision-images.json";
import request from "./fixtures/system-one-request.json";
import fixture from "./fixtures/system-one-response.json";
import openaiFixture from "./fixtures/openai-decisions-response.json";
import geminiFixture from "./fixtures/gemini-decisions-response.json";
import catalog from "./fixtures/openrouter-decisions-models.json";
import { sizedDecisionPng, decisionScreenshot } from "./helpers/decision-image.js";

const cases = [
  ["gemini", "gemini-decision-1"], ["openai", "gpt-6-luna"],
  ["openrouter", "typesafe/jev-1.13"], ["ollama", "clef:latest"], ["ollama-cloud", "clef:27b"],
];
const attachments = () => Object.entries(images).map(([mediaType, data]) => ({ type: "image", mediaType, data }));
let getProvider, vision;
const input = (model) => ({ ...structuredClone(request), model, apiKey: "test-key", attachments: attachments(), signal: new AbortController().signal });
const inferenceCalls = () => fetch.mock.calls.filter(([url]) => /\/decisions$|\/systemone$/.test(url));
beforeEach(async () => {
  vi.resetModules(); installChromeMock(); vision = true;
  getProvider = (await import("../src/providers/registry.js")).getProvider;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 3, close() {} })));
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url.endsWith("?output_modalities=decisions")) return Response.json({ data: catalog.data.map((entry) => ({
      ...entry, architecture: { ...entry.architecture, input_modalities: vision ? ["text", "image"] : ["text"] },
    })) });
    if (url.endsWith("/api/show")) return Response.json({ capabilities: vision ? ["decision", "vision"] : ["decision"], details: { format: "gguf" } });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "clef:latest" }, { name: "clef:27b" }] });
    if (url === "https://api.openai.com/v1/decisions") return Response.json(openaiFixture);
    if (url.includes("generativelanguage")) return Response.json(geminiFixture);
    return Response.json(fixture);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe.each(cases)("%s native decision images", (id, model) => {
  it("uses only provider-specific pixel limits for a 4284 × 5712 image", async () => {
    const args = input(model); args.attachments = [decisionScreenshot()];
    createImageBitmap.mockResolvedValue({ width: 4284, height: 5712, close() {} });
    if (id === "ollama-cloud") {
      expect(() => getProvider(id).preflightDecide(args)).toThrow(/Ollama Cloud.*this provider's limit is 16 MP/);
      expect(createImageBitmap).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    await getProvider(id).decide(args);
    expect(inferenceCalls()).toHaveLength(1);
    const body = JSON.parse(inferenceCalls()[0][1].body);
    const sent = id === "gemini" ? body.input[1].data
      : id === "openai" ? body.input[0].content[1].image_url.split(",")[1]
      : id === "openrouter" ? body.state[1].image_url.url.split(",")[1] : body.images[0];
    expect(sent).toBe(args.attachments[0].data);
  });
  it("forwards an image larger than the former 2 MiB limit unchanged", async () => {
    const args = input(model);
    const data = sizedDecisionPng(3_000_000);
    args.attachments = [{ type: "image", mediaType: "image/png", data }];
    await getProvider(id).decide(args);
    expect(inferenceCalls()).toHaveLength(1);
    const body = JSON.parse(inferenceCalls()[0][1].body);
    const sent = id === "gemini" ? body.input[1].data
      : id === "openai" ? body.input[0].content[1].image_url.split(",")[1]
      : id === "openrouter" ? body.state[1].image_url.url.split(",")[1] : body.images[0];
    expect(sent).toBe(data);
  });
  it("forwards all formats once, in order, with complete state and exact image bytes", async () => {
    const args = input(model);
    const result = await getProvider(id).decide(args);
    expect(result.answers).toEqual(fixture.answers);
    expect(inferenceCalls()).toHaveLength(1);
    const body = JSON.parse(inferenceCalls()[0][1].body);
    if (id === "gemini") {
      expect(body.input[0]).toEqual({ type: "text", text: JSON.stringify(request.state) });
      expect(body.input.slice(1)).toEqual(args.attachments.map(({ data, mediaType }) => ({ type: "image", data, mime_type: mediaType })));
    } else if (id === "openai") {
      expect(body.input[0].content[0]).toEqual({ type: "input_text", text: JSON.stringify(request.state) });
      expect(body.input[0].content.slice(1)).toEqual(args.attachments.map(({ data, mediaType }) => ({ type: "input_image", image_url: `data:${mediaType};base64,${data}` })));
    } else if (id === "openrouter") {
      expect(body.state[0]).toEqual({ type: "text", text: JSON.stringify(request.state) });
      expect(body.state.slice(1)).toEqual(args.attachments.map(({ data, mediaType }) => ({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } })));
    } else {
      expect(body.state).toEqual(request.state);
      expect(body.images).toEqual(args.attachments.map(({ data }) => data));
    }
    expect(JSON.stringify(body.questions)).not.toContain(images["image/png"]);
    expect(fetch.mock.calls.some(([url]) => url.includes("private.example"))).toBe(false);
  });
  it("fails corrupt image data before inference without text fallback", async () => {
    const args = input(model); args.attachments[0].data = btoa("corrupt");
    await expect(getProvider(id).decide(args)).rejects.toMatchObject({ code: "invalid_request" });
    expect(inferenceCalls()).toHaveLength(0);
  });
  it("supports preflight without sending image bytes to a provider", async () => {
    await getProvider(id).preflightDecide(input(model));
    expect(fetch).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
it("rejects an oversized cloud image during preflight without network or decoding", async () => {
  const args = input("clef:27b");
  args.attachments = [{ type: "image", mediaType: "image/png", data: Buffer.alloc(5_000_000).toString("base64") }];
  expect(() => getProvider("ollama-cloud").preflightDecide(args)).toThrow(/5 MB; the limit is 4.2 MB/);
  expect(fetch).not.toHaveBeenCalled();
  expect(createImageBitmap).not.toHaveBeenCalled();
});
it("applies the local Ollama full body limit independently of its text budget", async () => {
  const args = input("clef:latest");
  const image = { type: "image", mediaType: "image/png", data: Buffer.alloc(13_000_000).toString("base64") };
  args.attachments = [image, image];
  expect(() => getProvider("ollama").preflightDecide(args)).toThrow(/34.7 MB; the limit is 33.6 MB/);
  expect(fetch).not.toHaveBeenCalled();
  expect(createImageBitmap).not.toHaveBeenCalled();
});
it.each(cases.slice(2))("rejects unverified vision models on %s", async (id, model) => {
  vision = false;
  await expect(getProvider(id).decide(input(model))).rejects.toMatchObject({ code: "unavailable" });
  expect(inferenceCalls()).toHaveLength(0);
});
it.each(["ppq", "on-device"])("rejects decision images on text-only %s", async (id) => {
  await expect(Promise.resolve().then(() => getProvider(id).preflightDecide(input(id === "on-device" ? "on-device" : "typesafe/jev-1.13"))))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([["openrouter", "typesafe/jev-1.13"], ["ppq", "typesafe/jev-1.13"]])
  ("keeps native-looking state as ordinary text on %s without media permission", async (id, model) => {
    const state = [{ type: "image_url", image_url: { url: "https://private.example/photo" } }];
    const args = { ...input(model), state }; delete args.attachments;
    if (id === "ppq") {
      const original = fetch.getMockImplementation();
      fetch.mockImplementation((url, options) => url.endsWith("/decisions/models")
        ? Promise.resolve(Response.json({ data: [{ id: model, type: "decision" }] })) : original(url, options));
    }
    await getProvider(id).decide(args);
    const body = JSON.parse(inferenceCalls()[0][1].body);
    expect(body.state).toBe(JSON.stringify(state));
    expect(body).not.toHaveProperty("images");
    expect(body).not.toHaveProperty("attachments");
    expect(fetch.mock.calls.some(([url]) => url.includes("private.example"))).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
