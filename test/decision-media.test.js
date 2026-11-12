import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import images from "./fixtures/decision-images.json";
import {
  DECISION_IMAGE_MEDIA_TYPES, DECISION_IMAGE_MAX_BYTES, DECISION_IMAGES_MAX_BYTES, DECISION_ATTACHMENT_MAX_COUNT,
  decisionImageByteLength,
  snapshotDecisionAttachments, validateDecisionImages, decisionImageDimensions,
  assertDecisionMediaSupported, coversDecisionMedia,
} from "../src/decision-media.js";
import { validateDecideRequest } from "../src/decisions.js";
import { DECISION_LIMITS } from "../src/providers/decision-limits.js";
import { decisionScreenshot } from "./helpers/decision-image.js";

const attachment = (mediaType = "image/png") => ({ type: "image", mediaType, data: images[mediaType] });
const request = (attachments) => ({ method: "decide", state: {}, questions: { q: { type: "noul", instructions: "Ready?" } }, attachments });
function jpegWithDimensions(width, height) {
  const jpeg = Uint8Array.from(atob(images["image/jpeg"]), (c) => c.charCodeAt(0));
  const sof = jpeg.findIndex((value, i) => value === 255 && [0xc0, 0xc2].includes(jpeg[i + 1]));
  const view = new DataView(jpeg.buffer);
  view.setUint16(sof + 5, height);
  view.setUint16(sof + 7, width);
  return jpeg;
}
beforeEach(() => vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 3, close: vi.fn() }))));
afterEach(() => vi.unstubAllGlobals());

describe("decision image validation", () => {
  it.each(DECISION_IMAGE_MEDIA_TYPES)("validates native %s and releases the decoder", async (mediaType) => {
    const input = [attachment(mediaType)];
    const summary = await validateDecisionImages(input);
    expect(summary).toEqual([{ index: 0, mediaType, byteLength: atob(input[0].data).length, width: 2, height: 3 }]);
    const blob = createImageBitmap.mock.calls[0][0];
    expect(blob.type).toBe(mediaType);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.from(atob(input[0].data), (c) => c.charCodeAt(0)));
    expect((await createImageBitmap.mock.results[0].value).close).toHaveBeenCalledOnce();
  });
  it.each([
    null, {}, new Array(1), Array(DECISION_ATTACHMENT_MAX_COUNT + 1).fill(attachment()),
    [{ ...attachment(), url: "https://private.example/photo" }],
    [{ ...attachment(), type: "audio" }], [{ ...attachment(), mediaType: "image/gif" }],
    [{ ...attachment(), mediaType: "image/jpg" }], [{ ...attachment(), mediaType: "image/png;charset=utf-8" }],
    [{ ...attachment(), data: "data:image/png;base64," + images["image/png"] }],
    [{ ...attachment(), data: "AA==\n" }], [{ ...attachment(), data: "AB==" }],
    [{ ...attachment(), data: "AAF=" }], [{ ...attachment(), data: "AA-_" }],
    [{ ...attachment(), data: "" }], [{ ...attachment(), data: new Blob(["raw"]) }],
    [{ ...attachment(), data: "A".repeat(4 * Math.ceil(DECISION_IMAGE_MAX_BYTES / 3) + 4) }],
  ])("rejects malformed, unadvertised or unbounded media before decoding", (input) => {
    expect(() => snapshotDecisionAttachments(input)).toThrow();
    expect(validateDecideRequest(request(input)).ok).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it("counts media separately from state and accepts omitted/empty attachments", () => {
    expect(validateDecideRequest(request([])).ok).toBe(true);
    const plain = request(); delete plain.attachments;
    expect(validateDecideRequest(plain).ok).toBe(true);
    const large = attachment();
    // Schema checks bound bytes without allocating or treating image base64 as state.
    large.data = "AAAA".repeat(400000);
    expect(validateDecideRequest(request([large])).ok).toBe(true);
  });
  it("accepts the 20 MB image boundary and rejects a one-byte overflow", () => {
    const data = Buffer.alloc(DECISION_IMAGE_MAX_BYTES).toString("base64");
    expect(decisionImageByteLength(data)).toBe(20_000_000);
    expect(() => decisionImageByteLength(Buffer.alloc(DECISION_IMAGE_MAX_BYTES + 1).toString("base64")))
      .toThrow(/20,000,001 > 20,000,000 bytes/);
  });
  it("bounds the combined decoded size independently of each image", () => {
    const half = { ...attachment(), data: Buffer.alloc(DECISION_IMAGES_MAX_BYTES / 2).toString("base64") };
    expect(snapshotDecisionAttachments([half, half])).toHaveLength(2);
    expect(() => snapshotDecisionAttachments([half, half, { ...attachment(), data: "AA==" }]))
      .toThrow(/32,000,001 > 32,000,000 bytes/);
  });
  it("applies Ollama Cloud's smaller limits to metadata before approval", () => {
    const provider = { label: "Ollama Cloud", decisions: DECISION_LIMITS["ollama-cloud"] };
    const summary = { index: 0, mediaType: "image/png", byteLength: 4 * 1024 * 1024, width: 4000, height: 4000 };
    expect(() => assertDecisionMediaSupported(provider, [summary, summary])).not.toThrow();
    expect(() => assertDecisionMediaSupported(provider, [{ ...summary, byteLength: 6_300_000 }]))
      .toThrow("Ollama Cloud decision attachment 0 is 6.3 MB; the limit is 4.2 MB.");
    expect(() => assertDecisionMediaSupported(provider, [summary, summary, { ...summary, byteLength: 1 }]))
      .toThrow(/8,388,609 > 8,388,608 bytes/);
  });
  it.each([
    [{ ...attachment("image/jpeg"), mediaType: "image/png" }],
    [{ ...attachment(), data: images["image/png"].slice(0, -8) }],
    [{ ...attachment(), data: btoa(atob(images["image/png"]).replace("IDAT", "IDAX")) }],
    [{ ...attachment("image/webp"), data: btoa(atob(images["image/webp"]).slice(0, -2)) }],
  ])("rejects mismatched or corrupt bytes before browser decoding", async (input) => {
    await expect(validateDecisionImages(input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it("rejects animation", () => {
    const webp = new Uint8Array(30); webp.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
    new DataView(webp.buffer).setUint32(4, 22, true);
    webp.set([..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 8);
    new DataView(webp.buffer).setUint32(16, 10, true); webp[20] = 2;
    expect(() => decisionImageDimensions(webp, "image/webp")).toThrow(/animated/);
  });
  it.each([[5120, 2880], [2880, 5120], [16000, 1000], [1000, 16000], [4284, 5712]])
    ("allows %i × %i images without a Bridge dimension or pixel cap", async (width, height) => {
      const jpeg = jpegWithDimensions(width, height);
      expect(decisionImageDimensions(jpeg, "image/jpeg")).toEqual({ width, height });
      createImageBitmap.mockResolvedValue({ width, height, close: vi.fn() });
      const input = { type: "image", mediaType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") };
      expect(await validateDecisionImages([input])).toMatchObject([{ width, height }]);
      expect((await createImageBitmap.mock.results[0].value).close).toHaveBeenCalledOnce();
    });
  it("validates a real image above 16 MP and releases its decoded bitmap", async () => {
    const close = vi.fn();
    createImageBitmap.mockResolvedValue({ width: 4284, height: 5712, close });
    const input = decisionScreenshot();
    expect(await validateDecisionImages([input])).toMatchObject([{ width: 4284, height: 5712 }]);
    const summary = { index: 0, mediaType: "image/png", byteLength: atob(input.data).length, width: 4284, height: 5712 };
    for (const id of ["gemini", "openai", "openrouter", "ollama"]) {
      const provider = { label: id, decisions: DECISION_LIMITS[id] };
      expect(() => assertDecisionMediaSupported(provider, [summary])).not.toThrow();
    }
    const cloud = { label: "Ollama Cloud", decisions: DECISION_LIMITS["ollama-cloud"] };
    expect(() => assertDecisionMediaSupported(cloud, [summary]))
      .toThrow("Ollama Cloud decision attachment 0 is 4284 × 5712 pixels; this provider's limit is 16 MP.");
    expect(close).toHaveBeenCalledOnce();
  });
  it("rejects corrupt encodings even when their headers are valid", async () => {
    createImageBitmap.mockRejectedValue(new DOMException("broken", "InvalidStateError"));
    await expect(validateDecisionImages([attachment()])).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("cancels pending decoding and closes a late bitmap", async () => {
    let resolve;
    createImageBitmap.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = validateDecisionImages([attachment(), attachment()], { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    controller.abort(); await rejected;
    const close = vi.fn(); resolve({ width: 2, height: 3, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(createImageBitmap).toHaveBeenCalledOnce();
  });
  it("keeps media scopes independent and requires a verified native route", () => {
    expect(coversDecisionMedia({ imageInput: true }, ["image/png"])).toBe(false);
    expect(coversDecisionMedia({}, [])).toBe(true);
    expect(coversDecisionMedia({ imageMediaTypes: ["image/png"] }, ["image/jpeg"])).toBe(false);
    expect(() => assertDecisionMediaSupported({ label: "Text", decisions: {} }, [attachment()])).toThrow(/native decision/);
    const provider = { label: "Vision", decisions: { imageMediaTypes: DECISION_IMAGE_MEDIA_TYPES, imageInputRequiresModelCapability: true } };
    expect(() => assertDecisionMediaSupported(provider, [attachment()], {})).toThrow(/not verified/);
    expect(() => assertDecisionMediaSupported(provider, [attachment()], { inputModalities: ["text", "image"] })).not.toThrow();
  });
});
