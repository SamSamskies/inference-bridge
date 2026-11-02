import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelCapabilities, getProvider } from "../src/providers/registry.js";
import { UNKNOWN_MODEL_CAPABILITIES } from "../src/providers/model-capabilities.js";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";
import { blocksAllowForImages, imageCapabilityWarnings } from "../src/image-parts.js";
import { createModelCapabilityCheck } from "../ui/model-capability-check.js";
import { installChromeMock } from "./helpers/chrome-mock.js";

beforeEach(() => installChromeMock());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared model capability lookup", () => {
  it("forwards the exact explicit credential, model, and signal without mutating configuration", async () => {
    const args = Object.freeze({ model: "chosen", apiKey: undefined, signal: new AbortController().signal });
    const provider = { getModelCapabilities: vi.fn(async () => ({ imageInput: true, imageOutput: false })) };
    expect(await resolveModelCapabilities(provider, args)).toEqual({ imageInput: true, imageOutput: false });
    expect(provider.getModelCapabilities).toHaveBeenCalledWith(args);
    expect(provider.getModelCapabilities.mock.calls[0][0]).toHaveProperty("apiKey", undefined);
  });

  it("does not infer model support from provider flags, a catalog, or malformed values", async () => {
    expect(await resolveModelCapabilities({ imageInput: true, models: [{ id: "x", inputModalities: ["image"] }] }, { model: "x" }))
      .toEqual(UNKNOWN_MODEL_CAPABILITIES);
    expect(await resolveModelCapabilities({ getModelCapabilities: () => ({ imageInput: "yes", imageOutput: 1, imageInputPassthrough: true }) }, { model: "x" }))
      .toEqual(UNKNOWN_MODEL_CAPABILITIES);
  });

  it("returns explicit unknown results for failed discovery without forwarding failure details", async () => {
    const result = await resolveModelCapabilities({ getModelCapabilities: () => { throw new Error("secret credential"); } }, { model: "x" });
    expect(result).toEqual(UNKNOWN_MODEL_CAPABILITIES);
    expect(blocksAllowForImages(result, { imageInput: true })).toBe(true);
  });

  it.each(["before", "during"])("preserves cancellation %s discovery", async (when) => {
    const controller = new AbortController();
    const provider = { getModelCapabilities: vi.fn(() => { controller.abort(); throw new Error("secret"); }) };
    if (when === "before") controller.abort();
    await expect(resolveModelCapabilities(provider, { model: "x", signal: controller.signal })).rejects.toMatchObject({ code: "aborted", message: "Request aborted" });
    expect(provider.getModelCapabilities).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  });

  it("keeps unverified native forwarding explicit without asserting model support", async () => {
    const compat = createOpenAICompatProvider({ id: "compat:test", name: "Server", baseUrl: "https://server.example/v1" });
    for (const provider of [compat, getProvider("openai"), getProvider("anthropic")]) {
      const caps = await resolveModelCapabilities(provider, { model: "unknown-model" });
      expect(caps).toMatchObject({ imageInput: null, imageInputPassthrough: true });
      expect(blocksAllowForImages(caps, { imageInput: true })).toBe(false);
      expect(blocksAllowForImages(caps, { imageOutput: true })).toBe(true);
    }
  });

  it("uses Gemini verified profiles without granting unknown names image capabilities", async () => {
    const provider = getProvider("gemini");
    expect(await resolveModelCapabilities(provider, { model: "gemini-3.8-flash" })).toEqual({ imageInput: true, imageOutput: false });
    const unknown = await resolveModelCapabilities(provider, { model: "gemini-future-unverified" });
    expect(unknown).toEqual({ imageInput: null, imageOutput: false });
    expect(blocksAllowForImages(unknown, { imageInput: true })).toBe(true);
  });

  it.each(["available", "downloadable", "downloading", "missing", "unavailable"])(
    "keeps on-device image support distinct from native readiness (%s)", async (availability) => {
      const client = await import("../src/prompt-api-client.js");
      const probe = vi.spyOn(client, "getOnDeviceAvailability").mockResolvedValue(availability);
      const provider = getProvider("on-device");
      const capabilities = await resolveModelCapabilities(provider, { model: provider.defaultModel });
      expect(capabilities.imageInput).toBe(["available", "downloadable", "downloading"].includes(availability) ? true : null);
      expect(probe).toHaveBeenCalledWith({ wantsImage: true });
      const preflight = provider.preflightChat({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "YQ==" }] }] });
      if (availability === "available") await expect(preflight).resolves.toBeUndefined();
      else await expect(preflight).rejects.toMatchObject({ code: "unavailable" });
    }
  );

  it("keeps missing Ollama metadata unknown, does not cache failures, and can retry successfully", async () => {
    const provider = getProvider("ollama");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ capabilities: ["vision"] }));
    vi.stubGlobal("fetch", fetchMock);
    const args = { model: "retry-vision-contract" };
    expect(await resolveModelCapabilities(provider, args)).toMatchObject({ imageInput: null, imageOutput: false });
    expect(await resolveModelCapabilities(provider, args)).toMatchObject({ imageInput: null });
    expect(await resolveModelCapabilities(provider, args)).toMatchObject({ imageInput: true });
    expect(await resolveModelCapabilities(provider, args)).toMatchObject({ imageInput: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares OpenRouter metadata with adapter preflight and rejects unknown image requirements", async () => {
    const provider = getProvider("openrouter");
    const { resetOpenRouterModalitiesCache } = await import("../src/providers/openrouter.js");
    resetOpenRouterModalitiesCache();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "cap/text-only", architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] })));
    expect(await resolveModelCapabilities(provider, { model: "cap/text-only" })).toEqual({ imageInput: false, imageOutput: false });
    const unknown = await resolveModelCapabilities(provider, { model: "cap/unknown" });
    expect(unknown).toEqual(UNKNOWN_MODEL_CAPABILITIES);
    await expect(provider.streamChat({ model: "cap/unknown", apiKey: "key", messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "YQ==" }] }], signal: new AbortController().signal, onDelta: vi.fn() })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch.mock.calls.every(([url]) => url.endsWith("/models"))).toBe(true);
  });
});

describe("approval capability checks", () => {
  it("invalidates prior model results immediately and ignores a slower stale reply", async () => {
    let release;
    const stale = new Promise((resolve) => { release = resolve; });
    const send = vi.fn().mockReturnValueOnce(stale).mockResolvedValue({ ok: true, capabilities: { imageInput: false, imageOutput: false } });
    const render = vi.fn();
    const refresh = createModelCapabilityCheck(send, render);
    const first = refresh({ enabled: true, providerId: "a", model: "old" });
    await refresh({ enabled: true, providerId: "b", model: "new" });
    expect(render.mock.calls.at(-1)[0]).toEqual({ imageInput: false, imageOutput: false });
    release({ ok: true, capabilities: { imageInput: true, imageOutput: true } });
    await first;
    expect(render.mock.calls.at(-1)[0]).toEqual({ imageInput: false, imageOutput: false });
    await refresh({ enabled: false });
    expect(render.mock.calls.at(-1)[0]).toEqual(UNKNOWN_MODEL_CAPABILITIES);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { ok: false }])("retries missing worker replies once and retains unknown on failure (%j)", async (response) => {
    const send = vi.fn(async () => response), render = vi.fn();
    await createModelCapabilityCheck(send, render)({ enabled: true, providerId: "any-provider", model: "any-model" });
    expect(send).toHaveBeenCalledTimes(2);
    const caps = render.mock.calls.at(-1)[0];
    expect(caps).toEqual(UNKNOWN_MODEL_CAPABILITIES);
    expect(blocksAllowForImages(caps, { imageInput: true })).toBe(true);
    expect(imageCapabilityWarnings({}, { imageInput: true }, caps).join(" ")).toMatch(/could not verify/);
  });
});
