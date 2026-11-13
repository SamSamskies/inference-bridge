import { beforeEach, describe, expect, it, vi } from "vitest";
import { openChat } from "../src/open-chat.js";

beforeEach(() => {
  vi.stubGlobal("chrome", { sidePanel: { open: vi.fn(async () => {}) } });
  vi.stubGlobal("browser", undefined);
});
describe("chat entry point", () => {
  it("opens the global panel synchronously with a real browser window id", async () => {
    const result = openChat(42);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 });
    await result;
  });
  it("does not pass windows API sentinels to the side panel API", async () => {
    await expect(openChat(-2)).rejects.toThrow("not ready");
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
  });
  it("uses the Firefox sidebar when sidePanel is unavailable", async () => {
    chrome.sidePanel = undefined;
    vi.stubGlobal("browser", { sidebarAction: { open: vi.fn(async () => {}) } });
    await openChat();
    expect(browser.sidebarAction.open).toHaveBeenCalledOnce();
  });
});
