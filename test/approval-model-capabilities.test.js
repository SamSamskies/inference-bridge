import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { createModelCapabilityCheck } from "../ui/model-capability-check.js";
import { blocksAllowForImages, imageCapabilityWarnings } from "../src/image-parts.js";

const origin = "https://capabilities.example";
const image = [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "YQ==" }] }];
function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) };
}
let storage, permissions, registry;
beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  chrome.runtime.onConnect = event(); chrome.runtime.onMessage = event();
  chrome.permissions = { contains: vi.fn(async () => true), onRemoved: event() };
  chrome.windows.onRemoved = event();
  chrome.tabs = { onRemoved: event(), onUpdated: event() };
  chrome.action = { onClicked: event() };
  storage = await import("../src/storage.js");
  permissions = await import("../src/permissions.js");
  registry = await import("../src/providers/registry.js");
  await import("../background/service-worker.js");
  chrome.runtime.sendMessage = (message) => new Promise((resolve) => chrome.runtime.onMessage.emit(message, { url: chrome.runtime.getURL("ui/approval.html") }, resolve));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const cases = [
  ["Ollama vision", "ollama", "vision", { imageInput: true }, false],
  ["Ollama text model", "ollama", "no-vision", { imageInput: true }, true],
  ["Ollama discovery failure", "ollama", "network-error", { imageInput: true }, true],
  ["Ollama missing metadata", "ollama", "missing-metadata", { imageInput: true }, true],
  ["OpenRouter vision", "openrouter", "cap/vision", { imageInput: true }, false],
  ["OpenRouter unknown model", "openrouter", "cap/unknown", { imageInput: true }, true],
  ["OpenRouter discovery failure", "openrouter", "cap/network-error", { imageInput: true }, true],
  ["OpenRouter missing metadata", "openrouter", "cap/missing", { imageInput: true }, true],
  ["OpenRouter images both ways", "openrouter", "cap/both", { imageInput: true, imageOutput: true }, false],
  ["OpenRouter output without image input", "openrouter", "cap/output-only", { imageInput: true, imageOutput: true }, true],
  ["OpenAI image output", "openai", "gpt-6-luna", { imageOutput: true }, false],
  ["OpenAI unknown image output", "openai", "unverified-model", { imageOutput: true }, true],
  ["Gemini verified model", "gemini", "gemini-3.8-flash", { imageInput: true }, false],
  ["Gemini unknown model", "gemini", "gemini-unverified", { imageInput: true }, true],
  ["Gemini native output restriction", "gemini", "gemini-3.8-flash", { imageOutput: true }, true],
];

describe("approval UI and permissions share model capability results", () => {
  it.each(cases)("%s", async (_label, providerId, model, request, blocked) => {
    await storage.saveSettings({ apiKeys: { [providerId]: "stored-explicit-key" } });
    const route = { providerId, model };
    await storage.grantOriginAlways(origin, { ...route, imageInput: true, imageOutput: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (model.includes("network-error")) throw new Error("private failure detail");
      if (providerId === "ollama") return Response.json(model === "missing-metadata" ? {} : { capabilities: model === "vision" ? ["vision"] : ["completion"] });
      return Response.json({ data: [
        { id: "cap/vision", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
        { id: "cap/both", architecture: { input_modalities: ["image"], output_modalities: ["text", "image"] } },
        { id: "cap/output-only", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
        { id: "cap/missing" },
      ] });
    }));
    let uiCaps;
    await createModelCapabilityCheck(chrome.runtime.sendMessage, (caps) => { uiCaps = caps; })({ enabled: true, providerId, model });
    expect(blocksAllowForImages(uiCaps, request)).toBe(blocked);
    if (blocked) expect(imageCapabilityWarnings({ label: providerId }, request, uiCaps).length).toBeGreaterThan(0);
    else expect(imageCapabilityWarnings({}, request, uiCaps)).toEqual([]);
    const requestId = "capability-consent";
    let result;
    const permission = permissions.ensurePermission({ requestId, origin, messages: request.imageInput ? image : [{ role: "user", content: "draw" }], ...(request.imageOutput ? { output: { images: true } } : {}) }).then((value) => { result = value; return value; });
    await vi.waitFor(() => expect(Boolean(result || permissions.getPendingApproval(requestId))).toBe(true));
    if (blocked) {
      expect(result).toBeUndefined();
      expect(permissions.getPendingApproval(requestId)).not.toBeNull();
      permissions.cancelApproval(requestId);
      expect(await permission).toMatchObject({ allowed: false });
    } else {
      expect(await permission).toMatchObject({ allowed: true, ...route, once: false });
      expect(permissions.getPendingApproval(requestId)).toBeNull();
    }
  });

  it("honors adapter changes without adding provider ID branches to either consumer", async () => {
    const provider = registry.getProvider("anthropic");
    const lookup = vi.spyOn(provider, "getModelCapabilities").mockResolvedValue({ imageInput: false, imageOutput: true });
    await storage.saveSettings({ apiKeys: { anthropic: "specific-key" } });
    await storage.grantOriginAlways(origin, { providerId: "anthropic", model: "claude-sonnet-5-5", imageInput: true });
    let caps;
    await createModelCapabilityCheck(chrome.runtime.sendMessage, (value) => { caps = value; })({ enabled: true, providerId: "anthropic", model: "claude-sonnet-5-5" });
    expect(blocksAllowForImages(caps, { imageInput: true })).toBe(true);
    const controller = new AbortController();
    const pending = permissions.ensurePermission({ requestId: "modified-adapter", origin, messages: image, signal: controller.signal });
    await vi.waitFor(() => expect(permissions.getPendingApproval("modified-adapter")).not.toBeNull());
    expect(lookup).toHaveBeenCalledWith({ model: "claude-sonnet-5-5", apiKey: "specific-key", signal: controller.signal });
    permissions.cancelApproval("modified-adapter"); await pending;
  });

  it("does not use operation grants or an image-input grant for image output", async () => {
    const route = { providerId: "openai", model: "gpt-6-luna" };
    await storage.saveSettings({ apiKeys: { openai: "key" } });
    await storage.grantOriginOperationAlways(origin, "synthesize", { providerId: "openai", model: "tts-1", voice: "alloy" });
    await storage.grantOriginAlways(origin, { ...route, imageInput: true });
    const pending = permissions.ensurePermission({ requestId: "separate-images", origin, messages: [{ role: "user", content: "draw" }], output: { images: true } });
    await vi.waitFor(() => expect(permissions.getPendingApproval("separate-images")).not.toBeNull());
    permissions.cancelApproval("separate-images"); await pending;
    expect(await storage.getOriginOperationGrant(origin, "synthesize")).toMatchObject({ model: "tts-1" });
  });
});
