/** A small command menu: native popovers/invokers, with browser-specific fallbacks. */
export function createChatActionsMenu({ id, title, pinned, onAction }) {
  const trigger = document.createElement("button");
  trigger.id = `chat-options-${id}`;
  trigger.type = "button";
  trigger.className = "chat-actions";
  trigger.setAttribute("aria-label", `Chat options for ${title}`);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const dots = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  dots.setAttribute("viewBox", "0 0 24 24"); dots.setAttribute("aria-hidden", "true");
  for (const x of [5, 12, 19]) {
    const dot = document.createElementNS(dots.namespaceURI, "circle");
    dot.setAttribute("cx", String(x)); dot.setAttribute("cy", "12"); dot.setAttribute("r", "1.5");
    dots.append(dot);
  }
  trigger.append(dots);
  const menu = document.createElement("div");
  menu.id = `chat-menu-${id}`; menu.className = "chat-actions-popover"; menu.setAttribute("popover", "auto");
  trigger.setAttribute("commandfor", menu.id); trigger.setAttribute("command", "toggle-popover");
  const group = document.createElement("div");
  group.setAttribute("focusgroup", "menu nomemory");
  group.setAttribute("aria-labelledby", trigger.id);
  menu.append(group);
  const nativeGroup = "focusGroup" in HTMLElement.prototype;
  const nativeInvoker = "commandForElement" in HTMLButtonElement.prototype;
  const anchored = globalThis.CSS?.supports?.("position-area: block-end") === true;
  if (!nativeGroup) group.setAttribute("role", "menu");
  // Earlier invokers/source options do not establish an implicit anchor.
  if (anchored && !(globalThis.ToggleEvent && "source" in ToggleEvent.prototype)) {
    trigger.style.setProperty("anchor-name", `--${menu.id}`);
    menu.style.setProperty("position-anchor", `--${menu.id}`);
  }
  let pointerOpen = false;
  let enterAt = null;
  const isOpen = () => menu.matches(":popover-open");
  const items = () => [...group.querySelectorAll("button:not(:disabled)")];
  const restore = (fromPointer = false) => { if (trigger.isConnected) trigger.focus({ preventScroll: true, focusVisible: !fromPointer }); };
  const close = ({ restoreFocus = true, fromPointer = false } = {}) => {
    if (!isOpen()) return;
    if (restoreFocus) restore(fromPointer);
    menu.hidePopover();
  };
  const position = () => {
    if (anchored || !isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const top = rect.bottom + 6 + bounds.height <= height - 8 ? rect.bottom + 6 : rect.top - bounds.height - 6;
    menu.style.setProperty("--menu-left", `${Math.max(8, Math.min(rect.right - bounds.width, width - bounds.width - 8))}px`);
    menu.style.setProperty("--menu-top", `${Math.max(8, Math.min(top, height - bounds.height - 8))}px`);
  };
  const outsideFocus = (event) => {
    if (event.target !== trigger && !menu.contains(event.target)) close({ restoreFocus: false });
  };
  const onScroll = (event) => { if (!menu.contains(event.target)) close({ restoreFocus: false }); };
  const opened = () => {
    document.addEventListener("focusin", outsideFocus);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", onScroll, true);
  };
  const closed = () => {
    document.removeEventListener("focusin", outsideFocus);
    window.removeEventListener("resize", position);
    document.removeEventListener("scroll", onScroll, true);
  };
  menu.addEventListener("toggle", (event) => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) { closed(); return; }
    position(); opened();
    if (enterAt !== null) {
      const buttons = items(); buttons[enterAt === "last" ? buttons.length - 1 : 0]?.focus();
    } else restore(true);
    enterAt = null;
  });
  trigger.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); pointerOpen = true;
  });
  trigger.addEventListener("click", (event) => {
    if (!pointerOpen) enterAt ??= "first";
    pointerOpen = false;
    if (nativeInvoker) return;
    event.preventDefault();
    if (isOpen()) close(); else menu.showPopover({ source: trigger });
  });
  trigger.addEventListener("keydown", (event) => {
    pointerOpen = false;
    if (event.key === "Tab" && isOpen()) { close(); return; }
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault(); event.stopPropagation(); close();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); enterAt = event.key === "ArrowUp" ? "last" : "first";
      if (!isOpen()) trigger.click();
      else { const buttons = items(); buttons[enterAt === "last" ? buttons.length - 1 : 0]?.focus(); enterAt = null; }
    }
  });
  group.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (nativeGroup && !["Home", "End"].includes(event.key)) return;
    const buttons = items(); const index = buttons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); event.stopImmediatePropagation(); buttons[next]?.focus();
  }, true);
  for (const [action, label] of [["rename", "Rename"], ["pin", pinned ? "Unpin" : "Pin"], ["delete", "Delete"]]) {
    if (action === "delete") group.append(document.createElement("hr"));
    const item = document.createElement("button"); item.type = "button"; item.textContent = label;
    item.dataset.action = action;
    if (action === "delete") item.className = "danger";
    if (!nativeGroup) { item.setAttribute("role", "menuitem"); item.tabIndex = -1; }
    item.addEventListener("pointermove", () => item.focus({ preventScroll: true, focusVisible: false }));
    item.addEventListener("click", (event) => {
      const fromPointer = event.detail > 0;
      close({ fromPointer });
      onAction(action, { fromPointer });
    });
    group.append(item);
  }
  return { trigger, menu, dispose() { closed(); if (isOpen()) menu.hidePopover(); } };
}
