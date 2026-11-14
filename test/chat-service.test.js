import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";

let storage, service, provider;
const request = () => ({ providerId: "openai", model: "gpt-5-nano", messages: [{ role: "user", content: "Hi" }], signal: new AbortController().signal, onDelta: vi.fn(), onReasoningDelta: vi.fn() });
beforeEach(async () => {
  vi.resetModules(); installChromeMock();
  chrome.permissions = { contains: vi.fn(async () => true) };
  storage = await import("../src/storage.js");
  ({ streamConfiguredChat: service } = await import("../src/chat-service.js"));
  ({ openaiProvider: provider } = await import("../src/providers/openai.js"));
  provider.streamChat = vi.fn(async (args) => { args.onDelta("ok"); return { model: args.model, message: { role: "assistant", content: "ok" } }; });
  await storage.saveSettings({ apiKeys: { openai: "private-test-key" }, chatReasoningEffort: "high" });
});

describe("configured chat service", () => {
  it("reuses saved credentials, reasoning settings, and hosted search without website grants", async () => {
    const args = request(); await service({ ...args, webSearch: true });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "private-test-key", model: args.model, tools: [{ type: "web_search" }], options: { reasoningEffort: "high" } }));
    expect(args.onDelta).toHaveBeenCalledWith("ok");
    expect((await storage.getSettings()).allowedOrigins).toEqual({});
    expect((await storage.getSettings()).originLastUsed).toEqual({});
  });
  it("preserves image parts and checks model capabilities", async () => {
    const args = request(); args.messages[0].content = [{ type: "text", text: "Look" }, { type: "image", mediaType: "image/png", data: "aGVsbG8=" }];
    await service(args);
    expect(provider.streamChat.mock.calls[0][0].messages).toEqual(args.messages);
    const probe = vi.spyOn(provider, "getModelCapabilities").mockResolvedValue({ imageInput: false, imageOutput: false });
    await expect(service(args)).rejects.toThrow("Image input");
    probe.mockRestore();
  });
  it("fails on missing keys, unknown providers, invalid input, and missing models", async () => {
    await storage.saveSettings({ apiKeys: { openai: "" } });
    await expect(service(request())).rejects.toThrow("API key");
    await expect(service({ ...request(), providerId: "removed" })).rejects.toThrow("removed");
    await expect(service({ ...request(), messages: [] })).rejects.toThrow("non-empty");
    await expect(service({ ...request(), model: "" })).rejects.toThrow("Choose a model");
    expect(provider.streamChat).not.toHaveBeenCalled();
  });
  it("checks compatibility endpoint host access before sending any messages", async () => {
    await storage.saveCompatEndpoints([{ id: "compat:test", name: "Local", baseUrl: "http://localhost:8080/v1" }]);
    chrome.permissions.contains.mockResolvedValue(false);
    await expect(service({ ...request(), providerId: "compat:test" })).rejects.toThrow("Restore host access");
    expect(provider.streamChat).not.toHaveBeenCalled();
  });
  it("does not silently ignore hosted search for incompatible providers", async () => {
    await storage.saveCompatEndpoints([{ id: "compat:test", name: "Local", baseUrl: "http://localhost:8080/v1" }]);
    await expect(service({ ...request(), providerId: "compat:test", webSearch: true })).rejects.toThrow(/search/i);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });
});
