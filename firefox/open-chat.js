/** Firefox builds use the native sidebar; Chrome keeps its Side Panel module. */
export function openChat() {
  return browser.sidebarAction.open();
}
