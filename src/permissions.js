/**
 * Origin permission prompts (Allow once / Always allow / Deny / Never allow).
 */

import {
  getSettings,
  grantOriginAlways,
  getOriginGrant,
  getOriginLastUsed,
  setOriginLastUsed,
  isOriginBlocked,
  blockOrigin,
  normalizeProviderId,
  isPlausibleModelForProvider,
  isCompatProviderId,
} from "./storage.js";
import { getDefaultProvider, getProviderAsync } from "./providers/registry.js";
import { hasHostPermissionForBaseUrl } from "./host-permissions.js";
import {
  fingerprintTools,
  isToolEpisodeContinuation,
  isToolFingerprintCovered,
} from "./tool-approval.js";

/** @typedef {import("./providers/types.js").Tool} Tool */
/** @typedef {import("./providers/types.js").ChatMessage} ChatMessage */

/**
 * @typedef {{
 *   requestId: string,
 *   origin: string,
 *   messages: ChatMessage[],
 *   providerId: string,
 *   model: string,
 *   tools?: Tool[],
 * }} ApprovalRequest
 */

/** @typedef {"allow_once" | "always" | "deny" | "never"} ApprovalDecision */

/** Episode TTL for short-lived SW-side tools approval (ms). */
export const TOOL_EPISODE_TTL_MS = 5 * 60 * 1000;

/**
 * @type {Map<string, {
 *   providerId: string,
 *   model: string,
 *   toolFingerprint: string,
 *   expiresAt: number,
 * }>}
 */
const toolEpisodes = new Map();

/** @type {Map<string, {
 *   request: ApprovalRequest,
 *   resolve: (result: { decision: ApprovalDecision, providerId: string, model: string }) => void,
 *   windowId?: number,
 * }>} */
const pendingApprovals = new Map();

/**
 * Test helper: clear in-memory tool episodes.
 */
export function clearToolEpisodes() {
  toolEpisodes.clear();
}

/**
 * @param {string} origin
 * @param {{ providerId: string, model: string, toolFingerprint: string }} episode
 * @param {number} [now]
 */
function rememberToolEpisode(origin, episode, now = Date.now()) {
  if (!episode.toolFingerprint) return;
  toolEpisodes.set(origin, {
    providerId: normalizeProviderId(episode.providerId),
    model: episode.model,
    toolFingerprint: episode.toolFingerprint,
    expiresAt: now + TOOL_EPISODE_TTL_MS,
  });
}

/**
 * @param {string} origin
 * @param {{
 *   toolFingerprint: string,
 *   messages: ChatMessage[],
 * }} args
 * @param {number} [now]
 * @returns {{ providerId: string, model: string, toolFingerprint: string } | null}
 */
function matchingToolEpisode(origin, args, now = Date.now()) {
  const episode = toolEpisodes.get(origin);
  if (!episode) return null;
  if (episode.expiresAt <= now) {
    toolEpisodes.delete(origin);
    return null;
  }
  if (!isToolFingerprintCovered(args.toolFingerprint, episode.toolFingerprint)) {
    return null;
  }
  if (!isToolEpisodeContinuation(args.messages)) {
    return null;
  }
  return {
    providerId: episode.providerId,
    model: episode.model,
    toolFingerprint: episode.toolFingerprint,
  };
}

/**
 * Compat endpoints need optional host access. Built-ins are always ok here.
 * @param {{ id?: string, baseUrl?: string } | null | undefined} provider
 * @returns {Promise<boolean>}
 */
async function hasCompatHostAccess(provider) {
  // Fail closed when the provider is missing (e.g. deleted compat endpoint
  // between grant read and resolve). Built-ins still short-circuit to true.
  if (!provider?.id) return false;
  if (!isCompatProviderId(provider.id)) return true;
  const baseUrl = provider.baseUrl;
  return (
    typeof baseUrl === "string" &&
    Boolean(baseUrl) &&
    (await hasHostPermissionForBaseUrl(baseUrl))
  );
}

/**
 * Ensure the origin may proceed. Opens an approval popup when needed.
 * @param {{
 *   requestId: string,
 *   origin: string,
 *   messages: ChatMessage[],
 *   preferredProviderId?: string,
 *   preferredModel?: string,
 *   tools?: Tool[],
 * }} args
 * @returns {Promise<{
 *   allowed: boolean,
 *   providerId: string,
 *   model: string,
 *   once: boolean,
 *   code?: string,
 *   message?: string,
 * }>}
 */
export async function ensurePermission(args) {
  const settings = await getSettings();
  const lastUsed = await getOriginLastUsed(args.origin);
  const defaultProvider =
    (await getProviderAsync(settings.defaultProviderId)) || getDefaultProvider();
  // Prefill order: explicit preferred → last approval choice for this origin →
  // global defaults → registry default. Last-used never skips the prompt.
  const providerId = normalizeProviderId(
    args.preferredProviderId ||
      lastUsed?.providerId ||
      settings.defaultProviderId ||
      defaultProvider.id
  );
  const provider = (await getProviderAsync(providerId)) || defaultProvider;
  // Prefer the per-provider remembered default from defaultModels.
  const remembered =
    typeof settings.defaultModels?.[provider.id] === "string"
      ? settings.defaultModels[provider.id]
      : "";
  const settingsModelForProvider = isPlausibleModelForProvider(
    provider.id,
    remembered
  )
    ? remembered
    : "";
  const lastUsedModel =
    lastUsed &&
    normalizeProviderId(lastUsed.providerId) === provider.id &&
    typeof lastUsed.model === "string" &&
    lastUsed.model.trim()
      ? lastUsed.model.trim()
      : "";
  const preferredModel =
    typeof args.preferredModel === "string" &&
    isPlausibleModelForProvider(provider.id, args.preferredModel)
      ? args.preferredModel.trim()
      : "";
  const globalDefaultModel =
    preferredModel ||
    lastUsedModel ||
    settingsModelForProvider ||
    provider.defaultModel ||
    "";

  const tools = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : undefined;
  const toolFingerprint = tools ? fingerprintTools(tools) : "";

  if (await isOriginBlocked(args.origin)) {
    return {
      allowed: false,
      providerId: provider.id,
      model: globalDefaultModel,
      once: false,
    };
  }

  // Prompt prefill starts from global defaults; a revoked-compat re-prompt
  // below overrides these with the stored grant so Always allow cannot
  // silently switch the origin to a different provider.
  let promptProviderId = provider.id;
  let promptModel = globalDefaultModel;

  const existing = await getOriginGrant(args.origin);
  if (existing) {
    const grantProviderId = normalizeProviderId(existing.providerId);
    // Fall back to the grant provider's default — not settings.defaultModel,
    // which may belong to a different provider.
    const grantProvider = await getProviderAsync(grantProviderId);
    const grantFallbackModel = grantProvider?.defaultModel || "";
    const grantModel = existing.model || grantFallbackModel;

    if (await hasCompatHostAccess(grantProvider)) {
      if (!toolFingerprint) {
        // Plain chat: honor Always-allow as before.
        return {
          allowed: true,
          providerId: grantProviderId,
          model: grantModel,
          once: false,
        };
      }

      // Tools: Always-allow only skips the prompt when the grant already covers
      // this tool set. Plain-chat grants (no toolFingerprint) still re-prompt.
      if (
        typeof existing.toolFingerprint === "string" &&
        isToolFingerprintCovered(toolFingerprint, existing.toolFingerprint)
      ) {
        rememberToolEpisode(args.origin, {
          providerId: grantProviderId,
          model: grantModel,
          toolFingerprint: existing.toolFingerprint,
        });
        return {
          allowed: true,
          providerId: grantProviderId,
          model: grantModel,
          once: false,
        };
      }
    }

    promptProviderId = grantProviderId;
    promptModel = grantModel;
  }

  // Short-lived SW episode: allow multi-turn function-tool follow-ups without
  // a second popup (same origin / covered fingerprint / continuing messages).
  // Provider/model come from the episode that was approved — not grant prefill.
  if (toolFingerprint) {
    const episode = matchingToolEpisode(args.origin, {
      toolFingerprint,
      messages: args.messages,
    });
    if (episode) {
      rememberToolEpisode(args.origin, {
        providerId: episode.providerId,
        model: episode.model,
        toolFingerprint: episode.toolFingerprint,
      });
      return {
        allowed: true,
        providerId: episode.providerId,
        model: episode.model,
        once: true,
      };
    }
  }

  const decision = await promptUser({
    requestId: args.requestId,
    origin: args.origin,
    messages: args.messages,
    providerId: promptProviderId,
    model: promptModel,
    ...(tools ? { tools } : {}),
  });

  const chosenProviderId = normalizeProviderId(
    decision.providerId || promptProviderId
  );
  // Do not fall back to the pre-prompt provider: hasCompatHostAccess would
  // then check the wrong object while we still return chosenProviderId
  // (e.g. a deleted compat:* selection passing via a built-in fallback).
  const chosenProvider = await getProviderAsync(chosenProviderId);
  // Honor the approval UI's model choice. The dialog already validates with
  // isModelValid (any non-blank slug for OpenAI/OpenRouter); re-checking
  // isPlausibleModelForProvider here would silently replace free-typed
  // OpenRouter slugs that lack a "/" with the provider default.
  // If the user picked a different provider in the approval UI, do not fall
  // back to promptModel (it was resolved for the prompt's provider).
  const decisionModel =
    typeof decision.model === "string" && decision.model.trim()
      ? decision.model.trim()
      : "";
  const chosenModel =
    decisionModel ||
    (chosenProviderId === promptProviderId ? promptModel : "") ||
    chosenProvider?.defaultModel ||
    "";

  switch (decision.decision) {
    case "allow_once":
    case "always": {
      // Same host gate as persistent grants: approving a compat provider
      // without optional host access would only fail later in ensureReady.
      // Do not report these as permission_denied — Allow already succeeded.
      if (!chosenProvider) {
        return {
          allowed: false,
          providerId: chosenProviderId,
          model: chosenModel,
          once: false,
          code: "unavailable",
          message: `Unknown provider "${chosenProviderId}". Open the Inference Bridge options and update this site's grant.`,
        };
      }
      if (!(await hasCompatHostAccess(chosenProvider))) {
        const label = chosenProvider.label || chosenProviderId;
        return {
          allowed: false,
          providerId: chosenProviderId,
          model: chosenModel,
          once: false,
          code: "unavailable",
          message: `Host permission not granted for ${label}. Re-save the endpoint in extension Options to allow access.`,
        };
      }
      if (decision.decision === "always") {
        await grantOriginAlways(args.origin, {
          providerId: chosenProviderId,
          model: chosenModel,
          ...(toolFingerprint ? { toolFingerprint } : {}),
        });
      }
      if (toolFingerprint) {
        rememberToolEpisode(args.origin, {
          providerId: chosenProviderId,
          model: chosenModel,
          toolFingerprint,
        });
      }
      await setOriginLastUsed(args.origin, {
        providerId: chosenProviderId,
        model: chosenModel,
      });
      return {
        allowed: true,
        providerId: chosenProviderId,
        model: chosenModel,
        once: decision.decision === "allow_once",
      };
    }
    case "never":
      await blockOrigin(args.origin);
      return {
        allowed: false,
        providerId: chosenProviderId,
        model: chosenModel,
        once: false,
      };
    case "deny":
      return {
        allowed: false,
        providerId: chosenProviderId,
        model: chosenModel,
        once: false,
      };
    default:
      // Fail closed on unknown decisions.
      return {
        allowed: false,
        providerId: chosenProviderId,
        model: chosenModel,
        once: false,
      };
  }
}

/**
 * @param {ApprovalRequest} request
 * @returns {Promise<{ decision: ApprovalDecision, providerId: string, model: string }>}
 */
function promptUser(request) {
  return new Promise((resolve, reject) => {
    pendingApprovals.set(request.requestId, { request, resolve });

    const url = chrome.runtime.getURL(
      `ui/approval.html?requestId=${encodeURIComponent(request.requestId)}`
    );

    const width = 480;
    const height = 820;

    chrome.windows.create(
      {
        url,
        type: "popup",
        width,
        height,
        focused: true,
      },
      (win) => {
        const entry = pendingApprovals.get(request.requestId);
        if (!entry) return;
        if (chrome.runtime.lastError || !win?.id) {
          pendingApprovals.delete(request.requestId);
          const error = new Error(
            chrome.runtime.lastError?.message || "Failed to open approval window"
          );
          error.name = "InferenceError";
          /** @type {any} */ (error).code = "unavailable";
          reject(error);
          return;
        }

        // Assign before any await/callback so onRemoved can match this entry.
        entry.windowId = win.id;

        // Some Chrome builds ignore or clamp the initial create size; force it.
        chrome.windows.update(win.id, { width, height }, () => {
          void chrome.runtime.lastError;
        });

        // If the user closed the popup before windowId was stored, onRemoved
        // missed this entry — settle as deny once we learn the window is gone.
        chrome.windows.get(win.id, (existing) => {
          if (chrome.runtime.lastError || !existing) {
            cancelApproval(request.requestId);
          }
        });
      }
    );
  });
}

/**
 * Called by the approval page.
 * @param {string} requestId
 * @param {{ decision: ApprovalDecision, providerId?: string, model: string }} result
 * @returns {boolean}
 */
export function resolveApproval(requestId, result) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return false;
  pendingApprovals.delete(requestId);

  const decision =
    result?.decision === "allow_once" ||
    result?.decision === "always" ||
    result?.decision === "deny" ||
    result?.decision === "never"
      ? result.decision
      : "deny";

  // Blank providerId (e.g. Allow clicked before the select was filled) must
  // not go through normalizeProviderId — that maps "" to OpenAI.
  const rawProviderId =
    typeof result.providerId === "string" && result.providerId.trim()
      ? result.providerId
      : entry.request.providerId;

  entry.resolve({
    decision,
    providerId: normalizeProviderId(rawProviderId),
    model: typeof result.model === "string" ? result.model : entry.request.model,
  });

  // Let the approval page close itself after sendMessage succeeds.
  // Avoid windows.remove here — it can race with the page and obscure the decision.
  return true;
}

/**
 * @param {string} requestId
 * @returns {ApprovalRequest | null}
 */
export function getPendingApproval(requestId) {
  return pendingApprovals.get(requestId)?.request ?? null;
}

/**
 * Deny any approval tied to a closed window.
 * @param {number} windowId
 */
export function handleApprovalWindowClosed(windowId) {
  for (const [requestId, entry] of pendingApprovals.entries()) {
    if (entry.windowId === windowId) {
      pendingApprovals.delete(requestId);
      entry.resolve({
        decision: "deny",
        providerId: entry.request.providerId,
        model: entry.request.model,
      });
    }
  }
}

/**
 * Deny a pending approval (e.g. request aborted while prompting).
 * @param {string} requestId
 */
export function cancelApproval(requestId) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return;
  pendingApprovals.delete(requestId);
  entry.resolve({
    decision: "deny",
    providerId: entry.request.providerId,
    model: entry.request.model,
  });
  if (entry.windowId != null) {
    chrome.windows.remove(entry.windowId, () => {
      void chrome.runtime.lastError;
    });
  }
}
