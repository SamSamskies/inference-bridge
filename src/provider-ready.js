/**
 * Whether Allow can proceed for this provider in the approval popup.
 * Unready providers stay selectable so the setup hint can explain why.
 *
 * @param {{
 *   id: string,
 *   requiresApiKey?: boolean,
 *   optionalApiKey?: boolean,
 *   hasApiKey?: boolean,
 * }} provider
 * @param {{
 *   ollamaAvailable?: boolean,
 *   onDeviceAvailable?: boolean,
 * }} [status]
 * @returns {boolean}
 */
export function isApprovalProviderReady(provider, status = {}) {
  if (provider.id === "ollama") {
    return Boolean(status.ollamaAvailable);
  }
  if (provider.id === "on-device") {
    return Boolean(status.onDeviceAvailable);
  }
  // Compat endpoints may work without a key; required-key BYOK needs one saved.
  // Missing hasApiKey means settings were unread — do not block Allow (stream still enforces).
  if (provider.requiresApiKey && !provider.optionalApiKey) {
    return provider.hasApiKey !== false;
  }
  return true;
}

/** @deprecated Use isApprovalProviderReady */
export const isApprovalProviderChoosable = isApprovalProviderReady;

/**
 * Setup hint for the currently selected provider, or "" when ready.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   requiresApiKey?: boolean,
 *   optionalApiKey?: boolean,
 *   hasApiKey?: boolean,
 * }} provider
 * @param {{
 *   ollamaAvailable?: boolean,
 *   ollamaMessage?: string,
 *   onDeviceAvailable?: boolean,
 *   onDeviceMessage?: string,
 * }} [status]
 * @returns {string}
 */
export function approvalProviderSetupHint(provider, status = {}) {
  if (provider.id === "ollama" && !status.ollamaAvailable) {
    return (
      status.ollamaMessage ||
      "Ollama is unavailable at http://localhost:11434."
    );
  }
  if (provider.id === "on-device" && !status.onDeviceAvailable) {
    return (
      status.onDeviceMessage ||
      "Install the on-device model in Options before allowing this site."
    );
  }
  if (
    provider.requiresApiKey &&
    !provider.optionalApiKey &&
    provider.hasApiKey === false
  ) {
    return `${provider.label} needs an API key — add one in Options to enable it.`;
  }
  return "";
}
