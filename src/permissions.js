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
  fingerprintTrailingToolCalls,
  isMessageHistoryExtension,
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
 * @type {Map<string, Array<{
 *   providerId: string,
 *   model: string,
 *   toolFingerprint: string,
 *   messagesPrefix: ChatMessage[],
 *   expiresAt: number,
 * }>>}
 */
const toolEpisodes = new Map();

/** Soft cap so parallel same-origin Allow-once flows cannot grow without bound. */
const MAX_TOOL_EPISODES_PER_ORIGIN = 16;

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
 * Drop the short-lived tools episodes for an origin (e.g. Options revoke).
 * @param {string} origin
 */
export function forgetToolEpisode(origin) {
  toolEpisodes.delete(origin);
}

/**
 * Drop episodes whose approved prefix is extended by `messages` (deny of a
 * re-prompted continuation). Leaves unrelated parallel same-origin episodes.
 * @param {string} origin
 * @param {ChatMessage[]} messages
 * @param {number} [now]
 */
function forgetMatchingToolEpisodes(origin, messages, now = Date.now()) {
  const list = liveToolEpisodes(origin, now);
  if (list.length === 0) return;
  const kept = list.filter(
    (episode) => !isMessageHistoryExtension(messages, episode.messagesPrefix)
  );
  if (kept.length === 0) toolEpisodes.delete(origin);
  else if (kept.length !== list.length) toolEpisodes.set(origin, kept);
}

/**
 * chrome.storage.onChanged handler: drop episodes when Always-allow grants are
 * removed or their provider/model/tools binding changes in place (e.g. Options).
 * @param {object} changes
 * @param {string} areaName
 */
export function onAllowedOriginsStorageChanged(changes, areaName) {
  if (areaName !== "local" || !changes?.allowedOrigins) return;
  const oldOrigins = changes.allowedOrigins.oldValue;
  const newOrigins = changes.allowedOrigins.newValue;
  if (!oldOrigins || typeof oldOrigins !== "object") return;
  const next =
    newOrigins && typeof newOrigins === "object" ? newOrigins : {};
  for (const origin of Object.keys(oldOrigins)) {
    if (!(origin in next) || grantRoutingChanged(oldOrigins[origin], next[origin])) {
      forgetToolEpisode(origin);
    }
  }
}

/**
 * @param {unknown} prev
 * @param {unknown} next
 * @returns {boolean}
 */
function grantRoutingChanged(prev, next) {
  if (!next || typeof next !== "object") return true;
  const prevGrant = /** @type {{ providerId?: unknown, model?: unknown, toolFingerprint?: unknown }} */ (
    prev && typeof prev === "object" ? prev : {}
  );
  const nextGrant = /** @type {{ providerId?: unknown, model?: unknown, toolFingerprint?: unknown }} */ (
    next
  );
  const prevModel =
    typeof prevGrant.model === "string" ? prevGrant.model.trim() : "";
  const nextModel =
    typeof nextGrant.model === "string" ? nextGrant.model.trim() : "";
  const prevFp =
    typeof prevGrant.toolFingerprint === "string"
      ? prevGrant.toolFingerprint
      : "";
  const nextFp =
    typeof nextGrant.toolFingerprint === "string"
      ? nextGrant.toolFingerprint
      : "";
  return (
    normalizeProviderId(prevGrant.providerId) !==
      normalizeProviderId(nextGrant.providerId) ||
    prevModel !== nextModel ||
    prevFp !== nextFp
  );
}

/**
 * @param {string} origin
 * @param {number} now
 * @returns {Array<{
 *   providerId: string,
 *   model: string,
 *   toolFingerprint: string,
 *   messagesPrefix: ChatMessage[],
 *   expiresAt: number,
 * }>}
 */
function liveToolEpisodes(origin, now) {
  const list = toolEpisodes.get(origin);
  if (!list || list.length === 0) return [];
  const live = list.filter((episode) => episode.expiresAt > now);
  if (live.length === 0) {
    toolEpisodes.delete(origin);
    return [];
  }
  if (live.length !== list.length) toolEpisodes.set(origin, live);
  return live;
}

/**
 * @param {string} origin
 * @param {{
 *   providerId: string,
 *   model: string,
 *   toolFingerprint: string,
 *   messages: ChatMessage[],
 * }} episode
 * @param {number} [now]
 */
function rememberToolEpisode(origin, episode, now = Date.now()) {
  if (!episode.toolFingerprint) return;
  if (!Array.isArray(episode.messages) || episode.messages.length === 0) return;

  const next = {
    providerId: normalizeProviderId(episode.providerId),
    model: episode.model,
    toolFingerprint: episode.toolFingerprint,
    // Snapshot so later mutations of the caller's array cannot widen the prefix.
    messagesPrefix: episode.messages.map((m) => structuredClone(m)),
    expiresAt: now + TOOL_EPISODE_TTL_MS,
  };

  const list = liveToolEpisodes(origin, now);
  // Update only when this turn continues an existing episode. Exact-prefix
  // rematches must push a new entry so two tabs Allow-once on the same opening
  // message keep separate episodes (different provider/model) instead of
  // overwriting each other.
  // Prefer the longest matching prefix; on a tie, the episode with the same
  // provider/model so parallel same-opener tabs do not clobber each other.
  let replaceAt = -1;
  let bestPrefixLen = -1;
  let bestProviderMatch = false;
  for (let i = 0; i < list.length; i += 1) {
    const existing = list[i];
    if (!isMessageHistoryExtension(episode.messages, existing.messagesPrefix)) {
      continue;
    }
    const prefixLen = existing.messagesPrefix.length;
    const providerMatch =
      existing.providerId === next.providerId && existing.model === next.model;
    if (
      replaceAt < 0 ||
      prefixLen > bestPrefixLen ||
      (prefixLen === bestPrefixLen && providerMatch && !bestProviderMatch)
    ) {
      replaceAt = i;
      bestPrefixLen = prefixLen;
      bestProviderMatch = providerMatch;
    }
  }
  if (replaceAt >= 0) {
    list[replaceAt] = next;
  } else {
    list.push(next);
    while (list.length > MAX_TOOL_EPISODES_PER_ORIGIN) list.shift();
  }
  toolEpisodes.set(origin, list);
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
  const list = liveToolEpisodes(origin, now);
  if (list.length === 0) return null;
  if (!isToolEpisodeContinuation(args.messages)) return null;

  // Follow-ups may omit `tools`. Bind via trailing tool_calls fingerprint so
  // an empty request cannot reuse another flow's Allow-once episode.
  const requestFp =
    args.toolFingerprint || fingerprintTrailingToolCalls(args.messages);
  if (!requestFp) return null;

  // Prefer the longest matching prefix when parallel episodes exist on one origin.
  // If several share that length but disagree on provider/model (two tabs
  // Allow-once on the same opener), refuse to guess — re-prompt instead.
  let bestPrefixLen = -1;
  /** @type {Array<{ providerId: string, model: string, toolFingerprint: string }>} */
  const tied = [];
  for (const episode of list) {
    // Same-origin callers can fabricate assistant tool_calls + tool results.
    // Require a strict extension of the approved message history so an
    // unrelated thread cannot reuse this Allow-once episode.
    if (!isMessageHistoryExtension(args.messages, episode.messagesPrefix)) {
      continue;
    }
    if (!isToolFingerprintCovered(requestFp, episode.toolFingerprint)) {
      continue;
    }
    const prefixLen = episode.messagesPrefix.length;
    const candidate = {
      providerId: episode.providerId,
      model: episode.model,
      toolFingerprint: episode.toolFingerprint,
    };
    if (prefixLen > bestPrefixLen) {
      bestPrefixLen = prefixLen;
      tied.length = 0;
      tied.push(candidate);
    } else if (prefixLen === bestPrefixLen) {
      tied.push(candidate);
    }
  }
  if (tied.length === 0) return null;

  /** @type {Map<string, { providerId: string, model: string, toolFingerprint: string }>} */
  const byBinding = new Map();
  for (const candidate of tied) {
    byBinding.set(`${candidate.providerId}\0${candidate.model}`, candidate);
  }
  if (byBinding.size !== 1) return null;
  return byBinding.values().next().value;
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
        // Tool follow-ups may omit `tools`. If an Allow-once episode still
        // matches, fall through so episode logic (below) keeps that
        // provider/model instead of this plain Always-allow grant.
        const episode = matchingToolEpisode(args.origin, {
          toolFingerprint,
          messages: args.messages,
        });
        if (!episode) {
          // Tools Always-allow must not treat unmatched tool continuations as
          // plain chat — that would approve forged histories without the
          // episode message-prefix check. Re-prompt instead.
          const toolsGrantContinuation =
            typeof existing.toolFingerprint === "string" &&
            existing.toolFingerprint &&
            isToolEpisodeContinuation(args.messages);
          if (!toolsGrantContinuation) {
            return {
              allowed: true,
              providerId: grantProviderId,
              model: grantModel,
              once: false,
            };
          }
        }
      } else if (
        // Tools: Always-allow only skips the prompt when the grant already covers
        // this tool set. Plain-chat grants (no toolFingerprint) still re-prompt.
        typeof existing.toolFingerprint === "string" &&
        isToolFingerprintCovered(toolFingerprint, existing.toolFingerprint)
      ) {
        rememberToolEpisode(args.origin, {
          providerId: grantProviderId,
          model: grantModel,
          toolFingerprint: existing.toolFingerprint,
          messages: args.messages,
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
  // Follow-ups may omit `tools`; matching then uses trailing tool_calls so
  // empty request fp cannot reuse another flow's episode. Provider/model come
  // from the episode — not grant prefill.
  const episode = matchingToolEpisode(args.origin, {
    toolFingerprint,
    messages: args.messages,
  });
  if (episode) {
    const episodeProvider = await getProviderAsync(episode.providerId);
    // Same host gate as Always-allow: revoked optional access must re-prompt
    // rather than auto-approving and failing later in streaming.
    if (await hasCompatHostAccess(episodeProvider)) {
      rememberToolEpisode(args.origin, {
        providerId: episode.providerId,
        model: episode.model,
        toolFingerprint: episode.toolFingerprint,
        messages: args.messages,
      });
      return {
        allowed: true,
        providerId: episode.providerId,
        model: episode.model,
        once: true,
      };
    }
    promptProviderId = episode.providerId;
    promptModel = episode.model;
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
        // Always-allow may narrow the persistent grant; drop prior episodes so
        // broader in-memory fingerprints (e.g. parallel same-length openers)
        // cannot outlive the storage grant. Tools Always-allow re-seeds below.
        forgetToolEpisode(args.origin);
      }
      if (toolFingerprint) {
        rememberToolEpisode(args.origin, {
          providerId: chosenProviderId,
          model: chosenModel,
          toolFingerprint,
          messages: args.messages,
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
      forgetToolEpisode(args.origin);
      await blockOrigin(args.origin);
      return {
        allowed: false,
        providerId: chosenProviderId,
        model: chosenModel,
        once: false,
      };
    case "deny":
      // Drop only episodes this request could have matched so a denied
      // ambiguous/re-prompted continuation cannot later auto-approve once
      // sibling same-opener episodes diverge — without wiping unrelated
      // parallel Allow-once flows on the same origin.
      forgetMatchingToolEpisodes(args.origin, args.messages);
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
