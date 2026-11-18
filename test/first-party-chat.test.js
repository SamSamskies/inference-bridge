import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createWebLocksMock } from "./helpers/web-locks-mock.js";

vi.mock("../src/chat-service.js", () => ({ streamConfiguredChat: vi.fn() }));
let history, connectChat, isTrustedProviderCatalogSender, service;
const event = () => { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) }; };
function port(sender = { id: "test", url: "chrome-extension://test/ui/chat.html" }) {
  const p = { sender, messages: [], onMessage: event(), onDisconnect: event(), disconnect: vi.fn(), postMessage(m) { this.messages.push(m); } };
  connectChat(p); return p;
}
async function start(p) {
  const chat = history.newChat("openai", "vision-model");
  chat.webSearch = true; chat.messages.push({ role: "user", content: "Find recent news" });
  await history.saveChat(chat); p.onMessage.emit({ type: "start", chatId: chat.id }); return chat;
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { locks: createWebLocksMock() });
  vi.stubGlobal("chrome", { runtime: { id: "test", getURL: (path) => `chrome-extension://test/${path}` }, permissions: { onRemoved: event() } });
  history = await import("../src/chat-history.js");
  ({ connectChat, isTrustedProviderCatalogSender } = await import("../background/chat.js"));
  ({ streamConfiguredChat: service } = await import("../src/chat-service.js"));
  service.mockReset().mockImplementation(async ({ onDelta }) => { onDelta("Hello"); return { model: "vision-model", message: { role: "assistant", content: "Hello" } }; });
});

describe("first-party chat channel", () => {
  it.each([
    { id: "test", url: "https://app.example/", origin: "chrome-extension://test" },
    { id: "test", url: "chrome-extension://test/ui/options.html" },
    { id: "other", url: "chrome-extension://test/ui/chat.html" },
    { id: "test", url: "chrome-extension://test/ui/chat.html/evil" },
    {},
  ])("rejects untrusted senders %j", (sender) => {
    expect(port(sender).disconnect).toHaveBeenCalledOnce(); expect(service).not.toHaveBeenCalled();
  });
  it.each([
    { id: "test", url: "chrome-extension://test/ui/options.html" },
    { id: "test", url: "chrome-extension://test/ui/approval.html?requestId=stream_1" },
    { id: "test", url: "chrome-extension://test/ui/chat.html" },
  ])("allows provider catalog reads from extension UI %j", (sender) => {
    expect(isTrustedProviderCatalogSender(sender)).toBe(true);
  });
  it.each([
    { id: "test", url: "https://app.example/" },
    { id: "other", url: "chrome-extension://test/ui/options.html" },
    { id: "test", url: "chrome-extension://test/ui/popup.html" },
    {},
  ])("rejects provider catalog reads from untrusted senders %j", (sender) => {
    expect(isTrustedProviderCatalogSender(sender)).toBe(false);
  });
  it("streams with the saved route/search choice and durably saves the answer", async () => {
    const p = port(); const chat = await start(p);
    p.onMessage.emit({ type: "start", chatId: chat.id });
    await vi.waitFor(() => expect(p.messages.at(-1)?.type).toBe("done"));
    expect(service).toHaveBeenCalledOnce();
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai", model: "vision-model", webSearch: true, messages: [{ role: "user", content: "Find recent news" }] }));
    expect(p.messages.map((m) => m.type)).toEqual(["accepted", "delta", "done"]);
    expect(p.messages.at(-1)).not.toHaveProperty("chat");
    expect((await history.getChat(chat.id)).messages.at(-1)).toMatchObject({ content: "Hello", status: "complete" });
  });
  it.each(["abort", "disconnect", "permission removal"])("saves a partial response when %s occurs", async (action) => {
    service.mockImplementationOnce(({ signal, onDelta }) => new Promise((_, reject) => {
      onDelta("Partial"); signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    const p = port(); const chat = await start(p);
    await vi.waitFor(() => expect(p.messages.some((m) => m.type === "delta")).toBe(true));
    if (action === "abort") p.onMessage.emit({ type: "abort" });
    else if (action === "permission removal") chrome.permissions.onRemoved.emit();
    else p.onDisconnect.emit();
    await vi.waitFor(async () => expect((await history.getChat(chat.id)).messages.at(-1)).toMatchObject({ content: "Partial", status: "stopped" }));
  });
  it("keeps provider errors with the user message for retry", async () => {
    service.mockRejectedValueOnce(new Error("Model unavailable"));
    const p = port(); const chat = await start(p);
    await vi.waitFor(() => expect(p.messages.at(-1)).toMatchObject({ type: "error", error: "Model unavailable" }));
    expect((await history.getChat(chat.id)).messages).toMatchObject([{ role: "user" }, { role: "assistant", status: "error", error: "Model unavailable" }]);
  });
  it.each(["", "Partial reply"])("continues after a failed turn without sending error text to the provider (partial: %s)", async (content) => {
    service.mockImplementationOnce(async ({ onDelta }) => {
      if (content) onDelta(content);
      throw new Error("Model unavailable");
    });
    const first = port(); const chat = await start(first);
    await vi.waitFor(() => expect(first.messages.at(-1)?.type).toBe("error"));
    const saved = await history.getChat(chat.id);
    saved.messages.push({ role: "user", content: "Try a different question" });
    await history.saveChat(saved);
    const next = port(); next.onMessage.emit({ type: "start", chatId: chat.id });
    await vi.waitFor(() => expect(next.messages.at(-1)?.type).toBe("done"));
    expect(service.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "Find recent news" },
      ...(content ? [{ role: "assistant", content }] : []),
      { role: "user", content: "Try a different question" },
    ]);
    const continued = await history.getChat(chat.id);
    expect(continued.messages[1]).toMatchObject({ status: "error", content, error: "Model unavailable" });
    expect(continued.messages.at(-1)).toMatchObject({ status: "complete", content: "Hello" });
  });
  it("signals a stopped turn with an error port message after abort", async () => {
    service.mockImplementationOnce(({ signal, onDelta }) => new Promise((_, reject) => {
      onDelta("Partial"); signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    const p = port(); const chat = await start(p);
    await vi.waitFor(() => expect(p.messages.some((m) => m.type === "delta")).toBe(true));
    p.onMessage.emit({ type: "abort" });
    await vi.waitFor(() => expect(p.messages.at(-1)).toMatchObject({ type: "error", error: "Response stopped." }));
    expect((await history.getChat(chat.id)).messages.at(-1)).toMatchObject({ status: "stopped", content: "Partial" });
  });
  it("prevents two windows from generating in the same conversation", async () => {
    let release;
    service.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ model: "m", message: { role: "assistant", content: "ok" } }); }));
    const first = port(); const chat = await start(first);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = port(); second.onMessage.emit({ type: "start", chatId: chat.id });
    await vi.waitFor(() => expect(second.messages.at(-1)?.type).toBe("error"));
    expect(service).toHaveBeenCalledOnce(); release();
    await vi.waitFor(() => expect(first.messages.at(-1)?.type).toBe("done"));
  });
  it("preserves a manual name and pin when a later response is saved", async () => {
    const chat = history.newChat("openai", "vision-model");
    chat.messages.push({ role: "user", content: "Hello" });
    await history.saveChat(chat);
    await history.updateChatMetadata(chat.id, { title: "New chat", pinned: true });
    const p = port(); p.onMessage.emit({ type: "start", chatId: chat.id });
    await vi.waitFor(() => expect(p.messages.at(-1)?.type).toBe("done"));
    expect(await history.getChat(chat.id)).toMatchObject({ title: "New chat", titleEdited: true, pinned: true });
  });
});
