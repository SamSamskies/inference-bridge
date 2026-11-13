// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createWebLocksMock } from "./helpers/web-locks-mock.js";
import { installPopoverMock } from "./helpers/popover-mock.js";
import { COMPAT_MODEL_AUTOSUGGEST_THRESHOLD } from "../ui/model-input.js";

let history, port, finish;
const $ = (id) => document.getElementById(id);
function event() { const fns = []; return { addListener: (fn) => fns.push(fn), emit: (...args) => fns.forEach((fn) => fn(...args)) }; }
async function type(text) { $("prompt").value = text; $("prompt").dispatchEvent(new Event("input")); }
async function submit() { $("composer").dispatchEvent(new Event("submit", { cancelable: true })); await vi.waitFor(() => expect(port).toBeDefined()); }
async function loadProviderCatalog(id, models, { fail = false, defaultModel = models[0]?.id || "" } = {}) {
  const choices = [{ id: "openai", label: "OpenAI", defaultModel: "saved-model", hostedTools: [] }];
  if (id !== "openai") choices.push({ id, label: id, defaultModel, hostedTools: [] });
  chrome.runtime.sendMessage.mockImplementation(async (message) => {
    if (message.type === "list-providers") return { providers: choices };
    if (message.providerId === id) return fail ? { ok: false, error: { message: "Discovery failed" } } : { ok: true, models, defaultModel };
    return { ok: true, models: [{ id: "saved-model" }], defaultModel: "saved-model" };
  });
  chrome.storage.onChanged.emit({ compatEndpoints: {} }, "local");
  await vi.waitFor(() => expect([...$("provider").options].some((option) => option.value === id)).toBe(true));
  await vi.waitFor(() => expect($("provider").disabled).toBe(false));
  $("provider").value = id; $("provider").dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect($("provider").disabled).toBe(false));
}
beforeEach(async () => {
  vi.resetModules(); port = undefined; finish = undefined;
  document.documentElement.innerHTML = readFileSync("ui/chat.html", "utf8");
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  installPopoverMock();
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chat interface", () => {
  it("lists unconfigured providers at startup and blocks sending until a configured provider is selected", async () => {
    const choices = [
      { id: "openai", label: "OpenAI", defaultModel: "model", requiresApiKey: true, hasApiKey: true },
      { id: "anthropic", label: "Anthropic", defaultModel: "model", requiresApiKey: true, hasApiKey: false },
    ];
    chrome.runtime.sendMessage.mockClear().mockImplementation(async (message) => message.type === "list-providers" ? { providers: choices }
      : message.type === "chat-config" ? { defaultProviderId: "anthropic" } : { ok: true, models: [{ id: "model" }] });
    document.documentElement.innerHTML = readFileSync("ui/chat.html", "utf8");
    vi.resetModules(); await import("../ui/chat.js");
    await vi.waitFor(() => expect($("provider").value).toBe("anthropic"));
    expect([...$("provider").options].map((option) => [option.value, option.disabled])).toEqual([["openai", false], ["anthropic", false]]);
    expect($("configuration").textContent).toContain("Add an API key for Anthropic");
    expect($("configuration").hidden).toBe(false);
    expect($("modelField").hidden).toBe(true);
    expect(chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === "list-models")).toBe(false);
    await type("A draft before setup"); expect($("send").disabled).toBe(true);
    $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect($("error").hidden).toBe(false));
    expect(port).toBeUndefined(); expect(await history.listChats()).toEqual([]);
    $("provider").value = "openai"; $("provider").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    expect($("configuration").hidden).toBe(true); expect($("send").disabled).toBe(false);
    expect($("modelField").hidden).toBe(false);
    expect($("error").hidden).toBe(true);
  });
  it("updates setup requirements when keys change and keeps key-optional servers usable", async () => {
    const cloud = { id: "anthropic", label: "Anthropic", defaultModel: "model", requiresApiKey: true, hasApiKey: false };
    const choices = [{ id: "openai", label: "OpenAI", defaultModel: "model", requiresApiKey: true, hasApiKey: true }, cloud,
      ...["ollama", "compat:server"].map((id) => ({ id, label: id, defaultModel: "model", requiresApiKey: false, optionalApiKey: true, hasApiKey: false }))];
    chrome.runtime.sendMessage.mockImplementation(async (message) => message.type === "list-providers" ? { providers: choices } : { ok: true, models: [{ id: "model" }] });
    chrome.storage.onChanged.emit({ apiKeys: {} }, "local");
    await vi.waitFor(() => expect($("provider").options).toHaveLength(4));
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    $("provider").value = "anthropic"; $("provider").dispatchEvent(new Event("change"));
    await type("Keep this draft"); expect($("send").disabled).toBe(true);
    cloud.hasApiKey = true; chrome.storage.onChanged.emit({ apiKeys: {} }, "local");
    await vi.waitFor(() => expect($("send").disabled).toBe(false));
    expect($("configuration").hidden).toBe(true); expect($("prompt").value).toBe("Keep this draft");
    expect($("modelField").hidden).toBe(false);
    cloud.hasApiKey = false; chrome.storage.onChanged.emit({ apiKeys: {} }, "local");
    await vi.waitFor(() => expect($("configuration").hidden).toBe(false));
    expect($("provider").value).toBe("anthropic"); expect($("send").disabled).toBe(true);
    expect($("modelField").hidden).toBe(true);
    expect([...$("provider").options].some((option) => option.value === "anthropic")).toBe(true);
    for (const id of ["ollama", "compat:server"]) {
      $("provider").value = id; $("provider").dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect($("provider").disabled).toBe(false));
      expect($("configuration").hidden).toBe(true); expect($("send").disabled).toBe(false);
      expect($("modelField").hidden).toBe(false);
    }
  });
  it("clears a failed provider's configuration notice when switching or recovering", async () => {
    await loadProviderCatalog("openrouter", [], { fail: true });
    expect($("configuration").hidden).toBe(false);
    expect($("modelStatus").textContent).toBe("Discovery failed");
    $("provider").value = "openai"; $("provider").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    expect($("configuration").hidden).toBe(true);
    expect($("modelStatus").textContent).toBe("");
    await type("Continue with a configured provider"); expect($("send").disabled).toBe(false);
    $("provider").value = "openrouter"; $("provider").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    expect($("configuration").hidden).toBe(false);
    // Settings changes can also repair the currently selected provider.
    await loadProviderCatalog("openrouter", [{ id: "working-model" }]);
    expect($("configuration").hidden).toBe(true);
    expect($("modelStatus").textContent).toBe("");
    expect($("send").disabled).toBe(false);
  });
  it("hides the on-device model field while preserving its route, including after reopening history", async () => {
    await loadProviderCatalog("on-device", [{ id: "on-device", label: "Browser-chosen model" }]);
    expect($("modelField").hidden).toBe(true); expect($("model").disabled).toBe(true);
    await type("Use the browser model"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await history.getChat((await history.listChats())[0].id)).model).toBe("on-device");
    await finish(); await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    $("newChat").click();
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    $("provider").value = "openai"; $("provider").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect($("model").disabled).toBe(false));
    expect($("modelField").hidden).toBe(false);
    $("toggleHistory").click();
    await vi.waitFor(() => expect($("chatList").querySelector(".chat-title")).not.toBeNull());
    $("chatList").querySelector(".chat-title").click();
    await vi.waitFor(() => expect($("provider").value).toBe("on-device"));
    await vi.waitFor(() => expect($("provider").disabled).toBe(false));
    expect($("modelField").hidden).toBe(true); expect($("model").value).toBe("on-device");
  });
  it("uses a native model select for small catalogs and sends its selected model", async () => {
    await loadProviderCatalog("openai", [{ id: "a", label: "Model A" }, { id: "b", label: "Model B" }]);
    expect($("model").tagName).toBe("SELECT"); expect($("model").hidden).toBe(false);
    expect($("modelInput").hidden).toBe(true); expect($("modelInput").disabled).toBe(true);
    expect($("modelInputRow").hidden).toBe(true); expect($("clearModel").hidden).toBe(true);
    expect([...$("model").options].map((option) => option.textContent)).toContain("Model B");
    // Unknown saved models remain selectable for providers that allow them.
    expect($("model").value).toBe("saved-model");
    $("model").value = "b"; $("model").dispatchEvent(new Event("change"));
    await type("Use this model"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await history.getChat((await history.listChats())[0].id)).model).toBe("b");
    await finish(); await vi.waitFor(() => expect($("stop").hidden).toBe(true));
  });
  it.each(["openrouter", "ppq"])("keeps %s searchable and sends a manually entered slug", async (id) => {
    await loadProviderCatalog(id, Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}` })));
    expect($("model").hidden).toBe(true); expect($("model").disabled).toBe(true);
    expect($("modelInput").hidden).toBe(false); expect($("modelLabel").htmlFor).toBe("modelInput");
    await type("Searchable model"); expect($("send").disabled).toBe(false);
    expect($("clearModel").hidden).toBe(false); $("clearModel").click();
    expect($("modelInput").value).toBe(""); expect(document.activeElement).toBe($("modelInput"));
    expect($("clearModel").hidden).toBe(true); expect($("send").disabled).toBe(true);
    expect(port).toBeUndefined(); expect(await history.listChats()).toEqual([]);
    $("modelInput").value = "custom/provider-model"; $("modelInput").dispatchEvent(new Event("input"));
    expect($("clearModel").hidden).toBe(false);
    await type("Searchable model"); await submit();
    expect($("clearModel").hidden).toBe(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await history.getChat((await history.listChats())[0].id)).model).toBe("custom/provider-model");
    await finish(); await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    if (id === "openrouter") {
      $("newChat").click();
      await vi.waitFor(() => expect($("provider").disabled).toBe(false));
      $("provider").value = "openai"; $("provider").dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect($("provider").disabled).toBe(false));
      expect($("model").hidden).toBe(false); expect($("model").value).toBe("saved-model");
      $("toggleHistory").click();
      await vi.waitFor(() => expect($("chatList").querySelector(".chat-title")).not.toBeNull());
      $("chatList").querySelector(".chat-title").click();
      await vi.waitFor(() => expect($("modelInput").value).toBe("custom/provider-model"));
      expect($("modelInput").hidden).toBe(false);
    }
  });
  it.each([0, COMPAT_MODEL_AUTOSUGGEST_THRESHOLD, COMPAT_MODEL_AUTOSUGGEST_THRESHOLD + 1])("matches the shared compatible-server picker for %s models", async (count) => {
    await loadProviderCatalog("compat:server", Array.from({ length: count }, (_, i) => ({ id: `model-${i}` })));
    const searchable = count === 0 || count > COMPAT_MODEL_AUTOSUGGEST_THRESHOLD;
    expect($("modelInput").hidden).toBe(!searchable);
    expect($("model").hidden).toBe(searchable);
    if (!count) {
      $("modelInput").value = "manually-configured-model"; $("modelInput").dispatchEvent(new Event("input"));
      await type("Manual fallback"); expect($("send").disabled).toBe(false);
    }
  });
  it.each([false, true])("blocks unavailable strict-provider models without offering manual input (failure: %s)", async (fail) => {
    await loadProviderCatalog("ollama", [], { fail, defaultModel: "removed-model" });
    expect($("model").hidden).toBe(false); expect($("model").disabled).toBe(true);
    expect($("modelInput").hidden).toBe(true);
    await type("Do not send"); expect($("send").disabled).toBe(true);
    $("composer").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect($("error").textContent).toContain("Choose an available provider and model"));
    expect(port).toBeUndefined(); expect(await history.listChats()).toEqual([]);
  });
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
  it("closes history on a backdrop click in the fallback and resets the toggle state", () => {
    $("toggleHistory").click();
    expect($("history").getAttribute("closedby")).toBe("any");
    vi.spyOn($("history"), "getBoundingClientRect").mockReturnValue({ left: 0, right: 280, top: 0, bottom: 700 });
    for (const type of ["pointerdown", "click"]) $("history").dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 320, clientY: 100 }));
    expect($("history").open).toBe(false);
    expect($("toggleHistory").getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps history open for padding/child clicks, cancelled pointers, and drags starting inside", () => {
    $("toggleHistory").click();
    vi.spyOn($("history"), "getBoundingClientRect").mockReturnValue({ left: 0, right: 280, top: 0, bottom: 700 });
    const dispatch = (target, type, x) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100 }));
    for (const type of ["pointerdown", "click"]) dispatch($("history"), type, 16);
    expect($("history").open).toBe(true);
    for (const type of ["pointerdown", "click"]) dispatch($("historySearch"), type, 320);
    expect($("history").open).toBe(true);
    dispatch($("historySearch"), "pointerdown", 16); dispatch($("history"), "click", 320);
    expect($("history").open).toBe(true);
    dispatch($("history"), "pointerdown", 320); dispatch($("history"), "pointercancel", 320); dispatch($("history"), "click", 320);
    expect($("history").open).toBe(true);
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
  it("renames, pins/unpins, and deletes a conversation through its options menu", async () => {
    await type("Original name"); await submit();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await finish();
    await vi.waitFor(() => expect($("stop").hidden).toBe(true));
    $("toggleHistory").click();
    await vi.waitFor(() => expect($("chatList").querySelector(".chat-actions")).not.toBeNull());
    const id = (await history.listChats())[0].id;
    $("chatList").querySelector(".chat-actions").click();
    await vi.waitFor(() => expect($("chatList").querySelector(".chat-actions").getAttribute("aria-expanded")).toBe("true"));
    $("chatList").querySelector('[data-action="rename"]').click();
    expect($("renameChat").open).toBe(true);
    $("chatName").value = "My project"; $("renameForm").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect($("renameChat").open).toBe(false));
    expect((await history.getChat(id)).title).toBe("My project");
    expect(document.activeElement).toBe($("chatList").querySelector(".chat-title"));
    for (const pinned of [true, false]) {
      $("chatList").querySelector(".chat-actions").click();
      await vi.waitFor(() => expect($("chatList").querySelector(".chat-actions").getAttribute("aria-expanded")).toBe("true"));
      expect($("chatList").querySelector('[data-action="pin"]').textContent).toBe(pinned ? "Pin" : "Unpin");
      $("chatList").querySelector('[data-action="pin"]').click();
      await vi.waitFor(async () => expect((await history.getChat(id)).pinned).toBe(pinned));
      await vi.waitFor(() => expect(Boolean($("chatList").querySelector(".chat-pin"))).toBe(pinned));
    }
    $("chatList").querySelector(".chat-actions").click();
    await vi.waitFor(() => expect($("chatList").querySelector(".chat-actions").getAttribute("aria-expanded")).toBe("true"));
    $("chatList").querySelector('[data-action="delete"]').click();
    expect($("confirmDelete").open).toBe(true);
    $("confirmDelete").returnValue = "delete"; $("confirmDelete").close();
    await vi.waitFor(async () => expect(await history.getChat(id)).toBeUndefined());
  });
});
