/** Restrict local settings (including API keys) to trusted extension contexts. */

/** @type {Promise<boolean> | null} */
let accessReady = null;

/**
 * Call eagerly on background startup and await before every settings operation.
 * Unsupported browsers (currently Firefox) retain their default storage access.
 * A supported API failure rejects; later calls retry rather than silently using
 * storage whose content-script restriction has not been confirmed.
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
        throw error;
      });
  }
  return accessReady;
}
