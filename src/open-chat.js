import { isSafariBuild } from "./runtime-browser.js";

/** Invoke directly from a click; awaiting unrelated work loses Chrome's gesture. */
export function openChat(windowId) {
  if (isSafariBuild()) {
    return chrome.tabs.create({ url: chrome.runtime.getURL("ui/chat.html"), active: true });
  }
  if (chrome.sidePanel?.open) {
    if (!Number.isInteger(windowId) || windowId < 0) return Promise.reject(new Error("Chat window is not ready. Try again."));
    return chrome.sidePanel.open({ windowId });
  }
  const sidebar = globalThis.browser?.sidebarAction || chrome.sidebarAction;
  if (sidebar?.open) return sidebar.open();
  return Promise.reject(new Error("Chat requires Chrome 116+ or Firefox with sidebar support."));
}
