import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createWebLocksMock } from "./helpers/web-locks-mock.js";

vi.mock("../src/chat-service.js", () => ({ streamConfiguredChat: vi.fn() }));
let history, connectChat, service;
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
  ({ connectChat } = await import("../background/chat.js"));
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
    await vi.waitFor(() => expect(p.messages.at(-1)?.type).toBe("done"));
    expect((await history.getChat(chat.id)).messages).toMatchObject([{ role: "user" }, { role: "assistant", status: "error", error: "Model unavailable" }]);
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
