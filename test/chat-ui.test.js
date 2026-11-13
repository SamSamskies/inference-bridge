// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createWebLocksMock } from "./helpers/web-locks-mock.js";

let history, port, finish;
const $ = (id) => document.getElementById(id);
function event() { const fns = []; return { addListener: (fn) => fns.push(fn), emit: (...args) => fns.forEach((fn) => fn(...args)) }; }
async function type(text) { $("prompt").value = text; $("prompt").dispatchEvent(new Event("input")); }
async function submit() { $("composer").dispatchEvent(new Event("submit", { cancelable: true })); await vi.waitFor(() => expect(port).toBeDefined()); }
beforeEach(async () => {
  vi.resetModules(); port = undefined; finish = undefined;
  document.documentElement.innerHTML = readFileSync("ui/chat.html", "utf8");
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  vi.stubGlobal("indexedDB", new IDBFactory());
  Object.defineProperty(navigator, "locks", { configurable: true, value: createWebLocksMock() });
  history = await import("../src/chat-history.js");
  vi.stubGlobal("chrome", { storage: { onChanged: event() }, runtime: {
    sendMessage: vi.fn(async (m) => m.type === "list-providers" ? { providers: [{ id: "openai", label: "OpenAI", requiresApiKey: true, hasApiKey: true, defaultModel: "saved-model", hostedTools: ["web_search"] }] }
      : m.type === "chat-config" ? { defaultProviderId: "openai" } : { ok: true, models: [{ id: "saved-model" }] }),
    openOptionsPage: vi.fn(),
    connect: () => {
      port = { onMessage: event(), onDisconnect: event(), disconnect: vi.fn(), postMessage: vi.fn(async (m) => {
        if (m.type !== "start") return;
        const chat = await history.getChat(m.chatId);
        const assistant = { role: "assistant", content: "", status: "streaming" };
        chat.messages.push(assistant); await history.saveChat(chat);
        port.onMessage.emit({ type: "delta", content: "Streamed **answer**" });
        finish = async () => {
          assistant.content = "Streamed **answer**"; assistant.status = "complete"; chat.updatedAt++;
          await history.saveChat(chat); port.onMessage.emit({ type: "done", chatId: chat.id });
        };
      }) }; return port;
    },
  } });
  await import("../ui/chat.js");
  await vi.waitFor(() => expect($("model").disabled).toBe(false));
});

describe("chat interface", () => {
  it("saves a user message before generation and reloads the completed response", async () => {
    await type("Hello world"); $("webSearch").click(); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const saved = await history.listChats();
    expect(saved[0].title).toBe("Hello world");
    expect((await history.getChat(saved[0].id)).webSearch).toBe(true);
    await finish();
    await vi.waitFor(() => expect($("messages").querySelector("strong")?.textContent).toBe("answer"));
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    expect($("prompt").value).toBe("");
  });
  it("can browse history during a stream and return to the live conversation", async () => {
    await type("First chat"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    $("newChat").click();
    expect($("empty").hidden).toBe(false);
    $("toggleHistory").click();
    await vi.waitFor(() => expect($("chatList").children.length).toBe(1));
    $("chatList").querySelector(".chat-title").click();
    await vi.waitFor(() => expect($("stop").hidden).toBe(false));
    expect($("messages").querySelectorAll("article")).toHaveLength(2);
    await finish();
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
  });
  it("restores the last saved conversation after reopening the page", async () => {
    await type("Keep this chat"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await finish();
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    const id = await history.getChatPreference("activeChatId");
    expect((await history.getChat(id)).messages.at(-1).content).toBe("Streamed **answer**");
    $("newChat").click();
    $("toggleHistory").click();
    await vi.waitFor(() => expect($("chatList").querySelector(".chat-title")).not.toBeNull());
    $("chatList").querySelector(".chat-title").click();
    await vi.waitFor(() => expect($("messages").textContent).toContain("Keep this chat"));
    expect($("messages").textContent).toContain("Streamed answer");
  });
  it("resets the delete confirmation so Escape cannot reuse a previous Delete result", () => {
    $("confirmDelete").returnValue = "delete";
    $("clearHistory").click();
    expect($("confirmDelete").returnValue).toBe("");
    $("confirmDelete").close();
    expect($("empty").hidden).toBe(false);
  });
  it("refreshes configured providers without silently rerouting an existing chat", async () => {
    await type("Keep my route"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await finish();
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    chrome.runtime.sendMessage.mockImplementation(async (m) => m.type === "list-providers"
      ? { providers: [{ id: "compat:new", label: "New local provider", defaultModel: "local-model", hostedTools: [] }] }
      : { ok: true, models: [{ id: "saved-model" }] });
    chrome.storage.onChanged.emit({ apiKeys: {} }, "local");
    await vi.waitFor(() => expect($("provider").textContent).toContain("New local provider"));
    expect($("provider").value).toBe("openai");
    expect($("provider").textContent).toContain("unavailable");
    await type("Continue");
    expect($("send").disabled).toBe(true);
    expect($("configuration").hidden).toBe(false);
  });
  it("does not recreate a conversation deleted from another panel", async () => {
    await type("Delete elsewhere"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await finish();
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    const id = await history.getChatPreference("activeChatId");
    await history.deleteChat(id);
    await type("Another turn");
    $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect($("error").textContent).toContain("deleted in another panel"));
    expect(await history.getChat(id)).toBeUndefined();
  });
});
