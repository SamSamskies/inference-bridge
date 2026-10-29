/** Restrict local settings (including API keys) to trusted extension contexts. */

/** @type {Promise<boolean> | null} */
let accessReady = null;

/**
 * Call eagerly on background startup and await before every settings operation.
 * Unsupported browsers (currently Firefox) retain their default storage access.
 * If a supported call fails, this resolves false and later calls retry — the
 * same usable fallback as an unsupported browser, because a failed restriction
 * still leaves content scripts with default storage access.
 * @returns {Promise<boolean>} Whether the restriction is supported and applied.
 */
export function ensureTrustedStorageAccess() {
  const storage = chrome.storage.local;
  if (typeof storage.setAccessLevel !== "function") return Promise.resolve(false);
  if (!accessReady) {
    accessReady = Promise.resolve()
      .then(() => storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }))
      .then(() => true)
      .catch((error) => {
        accessReady = null;
        console.warn(
          "Could not restrict local storage access. Settings access will retry.",
          error,
        );
        return false;
      });
  }
  return accessReady;
}
