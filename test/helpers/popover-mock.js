import { vi } from "vitest";

/** Minimal popover lifecycle for DOM tests; real browsers verify top-layer UI. */
export function installPopoverMock() {
  const open = new WeakSet();
  const original = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (selector) {
    return selector === ":popover-open" ? open.has(this) : original.call(this, selector);
  });
  const toggle = (element, newState) => {
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: newState });
    queueMicrotask(() => element.dispatchEvent(event));
  };
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value() {
    open.add(this); toggle(this, "open");
  } });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value() {
    open.delete(this); toggle(this, "closed");
  } });
}
