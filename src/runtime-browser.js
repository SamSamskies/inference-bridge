/** Browser-specific behavior is keyed to the installed manifest, not a UA string. */
export function isFirefoxBuild() {
  return Boolean(
    typeof chrome !== "undefined" &&
      chrome.runtime?.getManifest?.().browser_specific_settings?.gecko
  );
}
