import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";

let mock;
let ensureTrustedStorageAccess;

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  chrome.storage.local.setAccessLevel = vi.fn(async function () {
    expect(this).toBe(chrome.storage.local);
  });
  ({ ensureTrustedStorageAccess } = await import("../src/storage-access.js"));
});

describe("trusted local storage access", () => {
  it("restricts local storage once per context, sharing concurrent initialization", async () => {
    await expect(Promise.all([
      ensureTrustedStorageAccess(), ensureTrustedStorageAccess(),
    ])).resolves.toEqual([true, true]);
    await expect(ensureTrustedStorageAccess()).resolves.toBe(true);
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("leaves unsupported browsers usable without claiming a restriction", async () => {
    delete chrome.storage.local.setAccessLevel;
    await expect(ensureTrustedStorageAccess()).resolves.toBe(false);
    const storage = await import("../src/storage.js");
    await storage.saveSettings({ apiKeys: { openai: "dummy-key" } });
    expect((await storage.getSettings()).apiKeys.openai).toBe("dummy-key");
  });

  it("blocks reads and writes until the browser confirms the restriction", async () => {
    let release;
    chrome.storage.local.setAccessLevel.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const get = vi.spyOn(chrome.storage.local, "get");
    const set = vi.spyOn(chrome.storage.local, "set");
    const storage = await import("../src/storage.js");
    const read = storage.getSettings();
    const write = storage.saveSettings({ apiKeys: { openai: "dummy-key" } });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    release();
    await Promise.all([read, write]);
    expect(get).toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
    expect(mock.store.get("apiKeys")).toEqual({ openai: "dummy-key" });
  });

  it.each(["reject", "throw"])("fails closed on a supported API %s and retries", async (mode) => {
    const failure = new Error("Access restriction failed");
    chrome.storage.local.setAccessLevel.mockImplementationOnce(() => {
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    });
    const get = vi.spyOn(chrome.storage.local, "get");
    const set = vi.spyOn(chrome.storage.local, "set");
    const storage = await import("../src/storage.js");
    const results = await Promise.allSettled([
      storage.getSettings(),
      storage.saveSettings({ apiKeys: { openai: "dummy-key" } }),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    await storage.saveSettings({ apiKeys: { openai: "dummy-key" } });
    expect((await storage.getSettings()).apiKeys.openai).toBe("dummy-key");
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledTimes(2);
  });

  it("reapplies the restriction in a fresh context after restart", async () => {
    await ensureTrustedStorageAccess();
    vi.resetModules();
    const restarted = await import("../src/storage-access.js");
    await restarted.ensureTrustedStorageAccess();
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledTimes(2);
  });

  it("eagerly restricts storage on background startup without waiting for settings use", async () => {
    const event = () => ({ addListener: vi.fn() });
    chrome.runtime.onConnect = event();
    chrome.runtime.onMessage = event();
    chrome.permissions = { onRemoved: event() };
    chrome.windows.onRemoved = event();
    chrome.tabs = { onRemoved: event(), onUpdated: event() };
    chrome.action = { onClicked: event() };
    const get = vi.spyOn(chrome.storage.local, "get");
    const set = vi.spyOn(chrome.storage.local, "set");
    await import("../background/service-worker.js");
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(chrome.runtime.onConnect.addListener).toHaveBeenCalled();
  });
});
