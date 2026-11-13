// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPopoverMock } from "./helpers/popover-mock.js";
import { createChatActionsMenu } from "../ui/chat-actions-menu.js";

let options, action;
beforeEach(() => {
  document.body.replaceChildren(); installPopoverMock();
  action = vi.fn();
  options = createChatActionsMenu({ id: "test", title: "Project", pinned: false, onAction: action });
  document.body.append(options.trigger, options.menu);
});
afterEach(() => { options.dispose(); vi.restoreAllMocks(); });
const key = (element, value) => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
describe("chat actions menu", () => {
  it("opens by keyboard and supports arrows, Home/End, and Escape with focus restoration", async () => {
    options.trigger.focus(); key(options.trigger, "ArrowDown");
    await vi.waitFor(() => expect(document.activeElement.textContent).toBe("Rename"));
    key(document.activeElement, "ArrowDown"); expect(document.activeElement.textContent).toBe("Pin");
    key(document.activeElement, "End"); expect(document.activeElement.textContent).toBe("Delete");
    key(document.activeElement, "Home"); expect(document.activeElement.textContent).toBe("Rename");
    key(document.activeElement, "Escape");
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(options.trigger);
  });
  it("activates a command, closes the menu, and retains the trigger's accessible name", async () => {
    options.trigger.click();
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("true"));
    options.menu.querySelector('[data-action="pin"]').click();
    expect(action).toHaveBeenCalledWith("pin", { fromPointer: false });
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("false"));
    expect(options.trigger.getAttribute("aria-label")).toBe("Chat options for Project");
  });
  it("Tab leaves the menu and focusing another control dismisses it", async () => {
    options.trigger.click();
    await vi.waitFor(() => expect(document.activeElement.textContent).toBe("Rename"));
    key(document.activeElement, "Tab");
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("false"));
    options.trigger.click();
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("true"));
    const other = document.createElement("button"); document.body.append(other); other.focus();
    await vi.waitFor(() => expect(options.trigger.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(other);
  });
  it("keeps the coordinate fallback inside a narrow viewport and above a low trigger", async () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 300 });
    vi.spyOn(options.trigger, "getBoundingClientRect").mockReturnValue({ left: 280, right: 312, top: 260, bottom: 296, width: 32, height: 36 });
    vi.spyOn(options.menu, "getBoundingClientRect").mockReturnValue({ left: 0, right: 160, top: 0, bottom: 140, width: 160, height: 140 });
    options.trigger.click();
    await vi.waitFor(() => expect(options.menu.style.getPropertyValue("--menu-top")).not.toBe(""));
    const left = parseFloat(options.menu.style.getPropertyValue("--menu-left"));
    const top = parseFloat(options.menu.style.getPropertyValue("--menu-top"));
    expect(left).toBeGreaterThanOrEqual(8); expect(left + 160).toBeLessThanOrEqual(312);
    expect(top).toBeGreaterThanOrEqual(8); expect(top + 140).toBeLessThan(260);
  });
});
