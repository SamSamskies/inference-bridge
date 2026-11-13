import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBDatabase } from "fake-indexeddb";
import { createWebLocksMock } from "./helpers/web-locks-mock.js";

let history;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { locks: createWebLocksMock() });
  history = await import("../src/chat-history.js");
});

describe("local chat history", () => {
  it("persists text and images across module reloads while keeping summaries small", async () => {
    const chat = history.newChat("openai", "vision-model");
    chat.messages.push({ role: "user", content: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }] });
    await history.saveChat(chat);
    vi.resetModules();
    const reopened = await import("../src/chat-history.js");
    expect(await reopened.getChat(chat.id)).toEqual(chat);
    expect((await reopened.listChats())[0]).not.toHaveProperty("messages");
  });
  it("updates ordering and deletes images with their conversation", async () => {
    const a = history.newChat(), b = history.newChat();
    a.updatedAt = 1; b.updatedAt = 2;
    await history.saveChat(a); await history.saveChat(b);
    expect((await history.listChats()).map((c) => c.id)).toEqual([b.id, a.id]);
    a.updatedAt = 3; await history.saveChat(a);
    expect((await history.listChats()).map((c) => c.id)).toEqual([a.id, b.id]);
    await history.deleteChat(a.id);
    expect(await history.getChat(a.id)).toBeUndefined();
    expect(await history.listChats()).toHaveLength(1);
    await history.setChatPreference("activeChatId", b.id);
    await history.clearChats();
    expect(await history.listChats()).toEqual([]);
    expect(await history.getChat(b.id)).toBeUndefined();
    expect(await history.getChatPreference("activeChatId")).toBeUndefined();
  });
  it("reports storage failures instead of claiming the conversation was saved", async () => {
    await history.listChats();
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    await expect(history.saveChat(history.newChat())).rejects.toThrow("Quota exceeded");
    spy.mockRestore();
    expect(await history.listChats()).toEqual([]);
  });
  it("blocks deletion while a stream holds the conversation lock", async () => {
    let release;
    const hold = history.withChatLock("active", () => new Promise((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(history.withChatLock("active", () => {})).rejects.toThrow("generating");
    await expect(history.withClearHistoryLock(history.clearChats)).rejects.toThrow("Stop active");
    await history.withChatLock("other", () => history.saveChat(history.newChat()));
    release(); await hold;
    await history.withClearHistoryLock(history.clearChats);
    expect(await history.listChats()).toEqual([]);
  });
  it("derives compact titles without including image data", () => {
    expect(history.chatTitle("  a\n b  ")).toBe("a b");
    expect(history.chatTitle([{ type: "image", data: "secret" }])).toBe("Image chat");
    expect(history.chatTitle("x".repeat(100))).toHaveLength(80);
  });
  it("persists names and pins, ordering pinned chats before newer unpinned ones", async () => {
    const older = history.newChat("openai", "vision-model"), newer = history.newChat();
    older.updatedAt = 1; newer.updatedAt = 2;
    older.messages = [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }] }];
    await history.saveChat(older); await history.saveChat(newer);
    const result = await history.updateChatMetadata(older.id, { title: "  My project  ", pinned: true });
    expect(result.previousUpdatedAt).toBe(1);
    expect(result.chat).toMatchObject({ title: "My project", titleEdited: true, pinned: true, messages: older.messages, providerId: "openai", model: "vision-model" });
    // A later ordinary conversation never overtakes a pinned one.
    newer.updatedAt = result.chat.updatedAt + 10; await history.saveChat(newer);
    vi.resetModules(); const reopened = await import("../src/chat-history.js");
    expect((await reopened.listChats()).map((chat) => chat.id)).toEqual([older.id, newer.id]);
    expect(await reopened.getChat(older.id)).toMatchObject({ title: "My project", pinned: true });
    await reopened.updateChatMetadata(older.id, { pinned: false });
    expect((await reopened.listChats()).every((chat) => !chat.pinned)).toBe(true);
  });
  it("rejects invalid names and metadata edits during generation without losing content", async () => {
    const chat = history.newChat(); await history.saveChat(chat);
    for (const title of [" ", "x".repeat(81)]) await expect(history.updateChatMetadata(chat.id, { title })).rejects.toThrow("chat name");
    expect(await history.getChat(chat.id)).toEqual(chat);
    let release;
    const hold = history.withChatLock(chat.id, () => new Promise((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(history.updateChatMetadata(chat.id, { pinned: true })).rejects.toThrow("generating");
    release(); await hold;
    await history.deleteChat(chat.id);
    await expect(history.updateChatMetadata(chat.id, { title: "Restored" })).rejects.toThrow("deleted");
    expect(await history.getChat(chat.id)).toBeUndefined();
  });
});
