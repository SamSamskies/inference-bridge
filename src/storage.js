/**
 * Extension-local settings. All browser contexts must use this entry point.
 * API keys never leave extension storage / extension contexts.
 */

import * as local from "./storage-local.js";
import { ensureTrustedStorageAccess } from "./storage-access.js";

export {
  isCompatProviderId,
  isPlausibleModelForProvider,
  normalizeProviderId,
  hasStoredApiKey,
  isSpeechOperation,
  isExperimentalOperation,
  normalizeCompatEndpoints,
} from "./storage-local.js";

/**
 * One origin-scoped browser lock coordinates Options pages, approval handling
 * and the background worker, even when each loads a separate module instance.
 * Reads also acquire it because getSettings() can migrate/scrub stored maps.
 *
 * Keep the whole read/modify/write operation inside the callback. Internal
 * helpers call each other in storage-local.js without reacquiring the lock.
 * The browser releases it on success, rejection or context destruction; there
 * is no persistent lock record or worker-local queue to recover after restart.
 * Missing Web Locks must reject rather than silently perform an unsafe write.
 *
 * @template {unknown[]} Args
 * @template Result
 * @param {(...args: Args) => Promise<Result>} operation
 * @returns {(...args: Args) => Promise<Result>}
 */
function locked(operation) {
  return async (...args) => {
    await ensureTrustedStorageAccess();
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      throw new Error("Settings access requires the Web Locks API.");
    }
    return locks.request("inference-bridge:settings", () => operation(...args));
  };
}

export const saveApprovalChoice = locked(local.saveApprovalChoice);
export const getSettings = locked(local.getSettings);
export const saveSettings = locked(local.saveSettings);
export const setOriginChatReasoningEffort = locked(local.setOriginChatReasoningEffort);
export const saveCompatEndpoints = locked(local.saveCompatEndpoints);
export const getOriginGrant = locked(local.getOriginGrant);
export const isOriginBlocked = locked(local.isOriginBlocked);
export const grantOriginAlways = locked(local.grantOriginAlways);
export const getOriginOperationGrant = locked(local.getOriginOperationGrant);
export const grantOriginOperationAlways = locked(local.grantOriginOperationAlways);
export const getOriginOperationLastUsed = locked(local.getOriginOperationLastUsed);
export const setOriginOperationLastUsed = locked(local.setOriginOperationLastUsed);
export const revokeOriginOperation = locked(local.revokeOriginOperation);
export const setOriginOperationRoute = locked(local.setOriginOperationRoute);
export const blockOrigin = locked(local.blockOrigin);
export const getOriginLastUsed = locked(local.getOriginLastUsed);
export const setOriginLastUsed = locked(local.setOriginLastUsed);
export const unblockOrigin = locked(local.unblockOrigin);
export const setOriginProviderModel = locked(local.setOriginProviderModel);
export const setOriginModel = locked(local.setOriginModel);
export const revokeOrigin = locked(local.revokeOrigin);
export const revokeAllOriginAccess = locked(local.revokeAllOriginAccess);
export const clearOriginToolsScope = locked(local.clearOriginToolsScope);
export const clearOriginImageScope = locked(local.clearOriginImageScope);
export const listAllowedOrigins = locked(local.listAllowedOrigins);
export const listOriginOperationGrants = locked(local.listOriginOperationGrants);
export const listBlockedOrigins = locked(local.listBlockedOrigins);
