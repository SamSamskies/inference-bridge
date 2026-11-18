/**
 * Origin permission prompts (Allow once / Always allow / Deny / Never allow).
 */

import {
  getSettings,
  saveApprovalChoice,
  getOriginGrant,
  getOriginLastUsed,
  isOriginBlocked,
  blockOrigin,
  normalizeProviderId,
  isPlausibleModelForProvider,
  isCompatProviderId,
  hasStoredApiKey,
  getOriginOperationGrant,
  getOriginOperationLastUsed,
  isExperimentalOperation,
} from "./storage.js";
import { normalizeSiteChatReasoningEffort } from "./chat-options.js";
import { coversDecisionMedia, assertDecisionMediaSupported } from "./decision-media.js";
import { DECISION_LIMITS, decisionQuestionLimitMessage } from "./providers/decision-limits.js";
import { getDefaultProvider, getProviderAsync, resolveModelCapabilities, resolveProviderModels } from "./providers/registry.js";
import {
  hasBuiltInHostPermission,
  hasHostPermissionForBaseUrl,
  revokedHostAccessMessage,
} from "./host-permissions.js";
import { isFirefoxBuild, isSafariBuild } from "./runtime-browser.js";
import {
  blocksAllowForImages,
  isImageGrantCovered,
  messagesHaveImageParts,
  requestWantsImageOutput,
} from "./image-parts.js";
import {
  blocksAllowForRequestTools,
  fingerprintTools,
  fingerprintTrailingToolCalls,
  isMessageHistoryExtension,
  isToolEpisodeContinuation,
  isToolGrantCovered,
  startsWithMessageHistory,
} from "./tool-approval.js";

/** @typedef {import("./providers/types.js").Tool} Tool */
/** @typedef {import("./providers/types.js").ChatMessage} ChatMessage */
/** @typedef {import("./providers/types.js").ToolChoice} ToolChoice */

/**
 * @typedef {{
 *   requestId: string,
 *   origin: string,
 *   messages: ChatMessage[],
 *   providerId: string,
 *   model: string,
 *   tools?: Tool[],
 *   toolChoice?: ToolChoice,
 *   output?: { images?: boolean },
 *   method?: "chat",
 *   chatReasoningEffort?: import("./chat-options.js").SiteChatReasoningEffort,
 *   globalChatReasoningEffort?: import("./chat-options.js").ChatReasoningEffort,
 * } | {
 *   requestId: string,
 *   origin: string,
 *   method: "decide" | "transcribe" | "synthesize",
 *   providerId: string,
 *   model: string,
 *   voice?: string,
 *   mediaType?: string,
 *   byteLength?: number,
 *   text?: string,
 *   stateSummary?: string,
 *   questionSummaries?: Array<{ id: string, type: string }>,
 *   attachmentSummaries?: Array<{ index: number, mediaType: string, byteLength: number, width: number, height: number }>,
 *   imageMediaTypes?: string[],
 * }} ApprovalRequest
 */

/** @typedef {"allow_once" | "always" | "deny" | "never"} ApprovalDecision */

/** Episode TTL for short-lived SW-side tools approval (ms). */
export const TOOL_EPISODE_TTL_MS = 5 * 60 * 1000;
export const SAFARI_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * @typedef {{
 *   providerId: string,
 *   model: string,
 *   toolFingerprint: string,
 *   toolChoiceNone?: boolean,
 *   imageInput?: boolean,
 *   imageOutput?: boolean,
 * }} ToolEpisodeBinding
 */

/**
 * @type {Map<string, Array<ToolEpisodeBinding & {
 *   messagesPrefix: ChatMessage[],
 *   expiresAt: number,
 * }>>}
 */
const toolEpisodes = new Map();

/** Soft cap so parallel same-origin Allow-once flows cannot grow without bound. */
const MAX_TOOL_EPISODES_PER_ORIGIN = 16;

/** @type {Map<string, {
 *   request: ApprovalRequest,
 *   resolve: (result: { decision: ApprovalDecision, providerId: string, model: string, voice?: string, chatReasoningEffort?: import("./chat-options.js").SiteChatReasoningEffort, acknowledge?: (result: { ok: boolean, error?: string }) => void }) => void,
 *   windowId?: number,
 *   tabId?: number,
 *   timeout?: ReturnType<typeof setTimeout>,
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
 * Drop episodes whose approved prefix equals or is extended by `messages`
 * (deny of a re-prompted opening or continuation). Leaves unrelated parallel
 * same-origin episodes.
 * @param {string} origin
 * @param {ChatMessage[]} messages
 * @param {number} [now]
 */
function forgetMatchingToolEpisodes(origin, messages, now = Date.now()) {
  const list = liveToolEpisodes(origin, now);
  if (list.length === 0) return;
  // Equal-prefix matters: denying a re-prompted opening must clear the
  // Allow-once episode so a forged tool continuation cannot auto-approve.
  const kept = list.filter(
    (episode) => !startsWithMessageHistory(messages, episode.messagesPrefix)
  );
  if (kept.length === 0) toolEpisodes.delete(origin);
  else if (kept.length !== list.length) toolEpisodes.set(origin, kept);
}

/**
 * chrome.storage.onChanged handler: drop episodes when Always-allow grants are
 * removed or their provider/model/tools/image binding changes in place
 * (e.g. Options revoke or edit).
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
  const prevGrant = /** @type {{ providerId?: unknown, model?: unknown, toolFingerprint?: unknown, toolChoiceNone?: unknown, imageInput?: unknown, imageOutput?: unknown }} */ (
    prev && typeof prev === "object" ? prev : {}
  );
  const nextGrant = /** @type {{ providerId?: unknown, model?: unknown, toolFingerprint?: unknown, toolChoiceNone?: unknown, imageInput?: unknown, imageOutput?: unknown }} */ (
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
    prevFp !== nextFp ||
    (prevGrant.toolChoiceNone === true) !== (nextGrant.toolChoiceNone === true) ||
    (prevGrant.imageInput === true) !== (nextGrant.imageInput === true) ||
    (prevGrant.imageOutput === true) !== (nextGrant.imageOutput === true)
  );
}

/**
 * Image scope approved by a grant/episode and/or this request.
 * @param {{ imageInput?: boolean, imageOutput?: boolean } | null | undefined} grant
 * @param {ChatMessage[]} messages
 * @param {unknown} [output]
 */
function imageApprovalFields(grant, messages, output) {
  return {
    ...(grant?.imageInput === true || messagesHaveImageParts(messages)
      ? { imageInput: true }
      : {}),
    ...(grant?.imageOutput === true || requestWantsImageOutput(output)
      ? { imageOutput: true }
      : {}),
  };
}

/**
 * @param {string} origin
 * @param {number} now
 * @returns {Array<ToolEpisodeBinding & {
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
 * @param {ToolEpisodeBinding & { messages: ChatMessage[] }} episode
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
  if (episode.toolChoiceNone === true) {
    next.toolChoiceNone = true;
  }
  if (episode.imageInput === true) next.imageInput = true;
  if (episode.imageOutput === true) next.imageOutput = true;

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
    const prev = list[replaceAt];
    // Keep previously approved image scope when a later turn omits it
    // (same idea as preserving toolFingerprint on omitted-tools follow-ups).
    if (prev.imageInput === true) next.imageInput = true;
    if (prev.imageOutput === true) next.imageOutput = true;
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
 *   toolChoice?: ToolChoice,
 * }} args
 * @param {number} [now]
 * @returns {ToolEpisodeBinding | null}
 */
function matchingToolEpisode(origin, args, now = Date.now()) {
  const list = liveToolEpisodes(origin, now);
  if (list.length === 0) return null;
  if (!isToolEpisodeContinuation(args.messages)) return null;

  // Follow-ups may omit `tools`. Bind via trailing toolCalls fingerprint so
  // an empty request cannot reuse another flow's Allow-once episode.
  const requestFp =
    args.toolFingerprint || fingerprintTrailingToolCalls(args.messages);
  if (!requestFp) return null;

  // Prefer the longest matching prefix when parallel episodes exist on one origin.
  // If several share that length but disagree on provider/model (two tabs
  // Allow-once on the same opener), refuse to guess — re-prompt instead.
  let bestPrefixLen = -1;
  /** @type {ToolEpisodeBinding[]} */
  const tied = [];
  for (const episode of list) {
    // Same-origin callers can fabricate assistant toolCalls + tool results.
    // Require a strict extension of the approved message history so an
    // unrelated thread cannot reuse this Allow-once episode.
    if (!isMessageHistoryExtension(args.messages, episode.messagesPrefix)) {
      continue;
    }
    if (
      !isToolGrantCovered(
        requestFp,
        episode.toolFingerprint,
        args.toolChoice,
        episode.toolChoiceNone === true
      )
    ) {
      continue;
    }
    const prefixLen = episode.messagesPrefix.length;
    const candidate = {
      providerId: episode.providerId,
      model: episode.model,
      toolFingerprint: episode.toolFingerprint,
      ...(episode.toolChoiceNone === true ? { toolChoiceNone: true } : {}),
      ...(episode.imageInput === true ? { imageInput: true } : {}),
      ...(episode.imageOutput === true ? { imageOutput: true } : {}),
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

  /** @type {Map<string, ToolEpisodeBinding>} */
  const byBinding = new Map();
  for (const candidate of tied) {
    byBinding.set(`${candidate.providerId}\0${candidate.model}`, candidate);
  }
  if (byBinding.size !== 1) return null;
  return byBinding.values().next().value;
}

/**
 * Optional host access required before Always-allow / Allow-once can proceed.
 * Compat endpoints need a user-granted origin pattern; Firefox built-ins need
 * their install-time host (revocable in about:addons).
 * @param {{ id?: string, baseUrl?: string } | null | undefined} provider
 * @returns {Promise<boolean>}
 */
async function hasProviderHostAccess(provider) {
  // Fail closed when the provider is missing (e.g. deleted compat endpoint
  // between grant read and resolve).
  if (!provider?.id) return false;
  if (!(await hasBuiltInHostPermission(provider.id))) return false;
  if (!isCompatProviderId(provider.id)) return true;
  const baseUrl = provider.baseUrl;
  return (
    typeof baseUrl === "string" &&
    Boolean(baseUrl) &&
    (await hasHostPermissionForBaseUrl(baseUrl))
  );
}

/**
 * Always-allow / Allow-once may skip the popup only when streaming would not
 * immediately fail for the same reason the approval UI disables Allow.
 * @param {{
 *   id?: string,
 *   baseUrl?: string,
 *   supportsFunctionTools?: boolean,
 *   hostedTools?: readonly string[],
 * } | null | undefined} provider
 * @param {Tool[] | undefined} tools
 * @param {Record<string, string>} apiKeys
 * @param {ToolChoice | undefined} [toolChoice]
 */
async function canSkipApprovalPrompt(provider, tools, apiKeys, toolChoice) {
  if (!(await hasProviderHostAccess(provider))) return false;
  const raw = provider?.id ? apiKeys[provider.id] : undefined;
  return !blocksAllowForRequestTools(
    {
      id: provider?.id,
      supportsFunctionTools: provider?.supportsFunctionTools,
      hostedTools: provider?.hostedTools,
      hasApiKey: hasStoredApiKey(raw),
    },
    tools,
    toolChoice
  );
}

/**
 * Always-allow may skip only when the grant already covers image input/output
 * and the bound provider/model's adapter permits them.
 * @param {import("./providers/types.js").Provider | null | undefined} provider
 * @param {string} model
 * @param {{ imageInput?: boolean, imageOutput?: boolean } | null | undefined} grant
 * @param {ChatMessage[]} messages
 * @param {unknown} [output]
 * @param {{ apiKey?: string, signal?: AbortSignal }} [config]
 */
async function imagesAllowAutoApprove(provider, model, grant, messages, output, config) {
  const imageInput = messagesHaveImageParts(messages);
  const imageOutput = requestWantsImageOutput(output);
  if (!isImageGrantCovered(grant, { imageInput, imageOutput })) return false;
  if (!imageInput && !imageOutput) return true;
  const capabilities = await resolveModelCapabilities(provider, { model, ...config });
  return !blocksAllowForImages(capabilities, { imageInput, imageOutput });
}

/**
 * Experimental operation permissions are separate from chat/tool episodes.
 * Existing allowedOrigins entries can never satisfy this function.
 * @param {{
 *   signal?: AbortSignal,
 *   sourceTab?: { id?: number, windowId?: number },
 *   requestId: string,
 *   origin: string,
 *   method: "decide" | "transcribe" | "synthesize",
 *   preferredProviderId?: string,
 *   preferredModel?: string,
 *   preferredVoice?: string,
 *   mediaType?: string,
 *   byteLength?: number,
 *   text?: string,
 *   stateSummary?: string,
 *   questionSummaries?: Array<{ id: string, type: string }>,
 *   attachmentSummaries?: Array<{ index: number, mediaType: string, byteLength: number, width: number, height: number }>,
 *   imageMediaTypes?: string[],
 * }} args
 */
export async function ensureOperationPermission(args) {
  if (!isExperimentalOperation(args.method)) {
    return {
      allowed: false,
      providerId: "",
      model: "",
      once: false,
      code: "invalid_request",
      message: "Unknown experimental operation.",
    };
  }

  const settings = await getSettings();
  const lastUsed = await getOriginOperationLastUsed(args.origin, args.method);
  const defaults = settings.operationDefaults[args.method];
  const existing = await getOriginOperationGrant(args.origin, args.method);
  const providerId =
    (args.method === "decide" && existing?.providerId) ||
    (typeof args.preferredProviderId === "string" &&
      args.preferredProviderId.trim()) ||
    existing?.providerId ||
    lastUsed?.providerId ||
    defaults?.providerId ||
    "";
  const sameProvider = (route) => route?.providerId === providerId;
  const model =
    (args.method === "decide" && sameProvider(existing) && existing.model) ||
    (typeof args.preferredModel === "string" && args.preferredModel.trim()) ||
    (sameProvider(existing) && existing.model) ||
    (sameProvider(lastUsed) && lastUsed.model) ||
    (sameProvider(defaults) && defaults.model) ||
    "";
  const voice =
    args.method === "synthesize"
      ? (typeof args.preferredVoice === "string" &&
          args.preferredVoice.trim()) ||
        (sameProvider(existing) && existing.voice) ||
        (sameProvider(lastUsed) && lastUsed.voice) ||
        (sameProvider(defaults) && defaults.voice) ||
        ""
      : "";

  if (await isOriginBlocked(args.origin)) {
    return {
      allowed: false,
      providerId,
      model,
      ...(voice ? { voice } : {}),
      once: false,
    };
  }
  if (existing?.providerId && existing.model && (args.method !== "decide" || coversDecisionMedia(existing, args.imageMediaTypes))) {
    if (args.method === "decide") {
      // Saved grants must honor the same provider question limit as manual approval.
      const provider = await getProviderAsync(existing.providerId);
      const limitMessage = decisionQuestionLimitMessage(
        provider?.label || existing.providerId,
        provider?.decisions?.maxQuestions ?? DECISION_LIMITS[existing.providerId]?.maxQuestions,
        args.questionSummaries?.length ?? 0
      );
      if (limitMessage) return {
        allowed: false, providerId: existing.providerId, model: existing.model,
        once: false, code: "invalid_request", message: limitMessage,
      };
    }
    return {
      allowed: true,
      providerId: existing.providerId,
      model: existing.model,
      ...(args.method === "synthesize" && existing.voice
        ? { voice: existing.voice }
        : {}),
      once: false,
    };
  }
  if (!providerId || !model || (args.method === "synthesize" && !voice)) {
    return {
      allowed: false,
      providerId,
      model,
      ...(voice ? { voice } : {}),
      once: false,
      code: "unavailable",
      message: `No ${args.method} provider route is configured.`,
    };
  }

  const decision = await promptUser({
    requestId: args.requestId,
    origin: args.origin,
    method: args.method,
    providerId,
    model,
    ...(voice ? { voice } : {}),
    ...(args.mediaType ? { mediaType: args.mediaType } : {}),
    ...(Number.isSafeInteger(args.byteLength)
      ? { byteLength: args.byteLength }
      : {}),
    ...(typeof args.text === "string" ? { text: args.text } : {}),
    ...(args.method === "decide"
      ? { stateSummary: args.stateSummary, questionSummaries: args.questionSummaries, ...(args.attachmentSummaries?.length ? { attachmentSummaries: args.attachmentSummaries, imageMediaTypes: args.imageMediaTypes } : {}) }
      : {}),
  }, args);
  return finishApproval(decision, async () => {
    const chosenProviderId =
      typeof decision.providerId === "string"
        ? decision.providerId.trim()
        : "";
    const chosenModel =
      typeof decision.model === "string" ? decision.model.trim() : "";
    const chosenVoice =
      args.method === "synthesize" && typeof decision.voice === "string"
        ? decision.voice.trim()
        : "";

    switch (decision.decision) {
      case "allow_once":
      case "always": {
        if (
          !chosenProviderId ||
          !chosenModel ||
          (args.method === "synthesize" && !chosenVoice)
        ) {
          return {
            allowed: false,
            providerId: chosenProviderId,
            model: chosenModel,
            ...(chosenVoice ? { voice: chosenVoice } : {}),
            once: false,
            code: "unavailable",
            message: `The selected ${args.method} route is incomplete.`,
          };
        }
        // Never persist a route whose known question limit is exceeded.
        if (args.method === "decide") {
          const provider = await getProviderAsync(chosenProviderId);
          if (args.attachmentSummaries?.length) {
            try {
              if (!provider?.decisions) throw Object.assign(new Error("The selected route does not support decisions."), { code: "unavailable" });
              assertDecisionMediaSupported(provider, args.attachmentSummaries);
              const models = await resolveProviderModels(provider, { method: "decide", apiKey: settings.apiKeys[chosenProviderId] });
              if (!models.some((model) => model.id === chosenModel)) throw Object.assign(new Error("Choose a model from the decision catalog."), { code: "unavailable" });
              assertDecisionMediaSupported(provider, args.attachmentSummaries, models.find((model) => model.id === chosenModel) || {});
            } catch (error) {
              return { allowed: false, providerId: chosenProviderId, model: chosenModel, once: false, code: error.code || "unavailable", message: error.message || "Native decision media is unavailable." };
            }
          }
          const limitMessage = decisionQuestionLimitMessage(
            provider?.label || chosenProviderId,
            provider?.decisions?.maxQuestions ?? DECISION_LIMITS[chosenProviderId]?.maxQuestions,
            args.questionSummaries?.length ?? 0
          );
          if (limitMessage) return {
            allowed: false, providerId: chosenProviderId, model: chosenModel,
            once: false, code: "invalid_request", message: limitMessage,
          };
        }
        const route = {
          providerId: chosenProviderId,
          model: chosenModel,
          ...(chosenVoice ? { voice: chosenVoice } : {}),
        };
        await saveApprovalChoice(args.origin, {
          ...route,
          operation: args.method,
          ...(args.method === "decide" && args.imageMediaTypes?.length ? {
            imageMediaTypes: [...new Set([
              ...(existing?.providerId === chosenProviderId && existing.model === chosenModel ? existing.imageMediaTypes || [] : []),
              ...args.imageMediaTypes,
            ])].sort(),
          } : {}),
          always: decision.decision === "always",
        });
        return {
          allowed: true,
          ...route,
          once: decision.decision === "allow_once",
        };
      }
      case "never":
        await blockOrigin(args.origin);
        return {
          allowed: false,
          providerId: chosenProviderId,
          model: chosenModel,
          ...(chosenVoice ? { voice: chosenVoice } : {}),
          once: false,
        };
      case "deny":
      default:
        return {
          allowed: false,
          providerId: chosenProviderId,
          model: chosenModel,
          ...(chosenVoice ? { voice: chosenVoice } : {}),
          once: false,
        };
    }
  });
}

// Backwards-compatible internal name for speech callers.
export const ensureSpeechPermission = ensureOperationPermission;

/**
 * Ensure the origin may proceed. Opens an approval popup when needed.
 * @param {{
 *   signal?: AbortSignal,
 *   sourceTab?: { id?: number, windowId?: number },
 *   requestId: string,
 *   origin: string,
 *   messages: ChatMessage[],
 *   preferredProviderId?: string,
 *   preferredModel?: string,
 *   tools?: Tool[],
 *   toolChoice?: ToolChoice,
 *   output?: { images?: boolean },
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
  // A saved provider may be absent in this browser (notably Chrome's
  // On-device provider on Firefox/Safari). Never substitute the remote default.
  const selectedProvider = await getProviderAsync(providerId);
  if (!selectedProvider && (isFirefoxBuild() || isSafariBuild())) {
    return {
      allowed: false,
      providerId,
      model: "",
      once: false,
      code: "unavailable",
      message: `Provider "${providerId}" is unavailable in this browser. Choose an available provider in Inference Bridge Options.`,
    };
  }
  const provider = selectedProvider || defaultProvider;
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
    lastUsed.model.trim() &&
    isPlausibleModelForProvider(provider.id, lastUsed.model)
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
    if (!grantProvider && (isFirefoxBuild() || isSafariBuild())) {
      return {
        allowed: false,
        providerId: grantProviderId,
        model: existing.model || "",
        once: false,
        code: "unavailable",
        message: `Saved provider "${grantProviderId}" is unavailable in this browser. Update this site's grant in Inference Bridge Options.`,
      };
    }
    const grantFallbackModel = grantProvider?.defaultModel || "";
    const grantModel = existing.model || grantFallbackModel;

    if (
      (await canSkipApprovalPrompt(
        grantProvider,
        tools,
        settings.apiKeys,
        args.toolChoice
      )) &&
      (await imagesAllowAutoApprove(
        grantProvider,
        grantModel,
        existing,
        args.messages,
        args.output,
        { apiKey: settings.apiKeys[grantProviderId], signal: args.signal }
      ))
    ) {
      if (!toolFingerprint) {
        // Tool follow-ups may omit `tools`. If an Allow-once episode still
        // matches, fall through so episode logic (below) keeps that
        // provider/model instead of this plain Always-allow grant.
        const episode = matchingToolEpisode(args.origin, {
          toolFingerprint,
          messages: args.messages,
          toolChoice: args.toolChoice,
        });
        if (!episode) {
          // Unmatched tool continuations must not ride Always-allow (plain or
          // tools) — that would approve forged histories without the episode
          // message-prefix check. Re-prompt instead.
          if (!isToolEpisodeContinuation(args.messages)) {
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
        // A toolChoice "none" grant must not cover a later request that can
        // invoke tools (including hosted web_search under default "auto").
        typeof existing.toolFingerprint === "string" &&
        isToolGrantCovered(
          toolFingerprint,
          existing.toolFingerprint,
          args.toolChoice,
          existing.toolChoiceNone === true
        )
      ) {
        rememberToolEpisode(args.origin, {
          providerId: grantProviderId,
          model: grantModel,
          toolFingerprint: existing.toolFingerprint,
          messages: args.messages,
          ...(existing.toolChoiceNone === true ? { toolChoiceNone: true } : {}),
          ...imageApprovalFields(existing, args.messages, args.output),
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
  // Follow-ups may omit `tools`; matching then uses trailing toolCalls so
  // empty request fp cannot reuse another flow's episode. Provider/model come
  // from the episode — not grant prefill.
  const episode = matchingToolEpisode(args.origin, {
    toolFingerprint,
    messages: args.messages,
    toolChoice: args.toolChoice,
  });
  if (episode) {
    const episodeProvider = await getProviderAsync(episode.providerId);
    // Same gates as Always-allow: revoked optional access, unsupported hosted
    // web_search, a missing Ollama web_search key, or image input/output the
    // episode (and provider/model) does not already cover must re-prompt.
    if (
      (await canSkipApprovalPrompt(
        episodeProvider,
        tools,
        settings.apiKeys,
        args.toolChoice
      )) &&
      (await imagesAllowAutoApprove(
        episodeProvider,
        episode.model,
        episode,
        args.messages,
        args.output,
        { apiKey: settings.apiKeys[episode.providerId], signal: args.signal }
      ))
    ) {
      rememberToolEpisode(args.origin, {
        providerId: episode.providerId,
        model: episode.model,
        toolFingerprint: episode.toolFingerprint,
        messages: args.messages,
        ...(episode.toolChoiceNone === true ? { toolChoiceNone: true } : {}),
        ...imageApprovalFields(episode, args.messages, args.output),
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
    chatReasoningEffort: settings.originChatReasoningEfforts[args.origin] || "global",
    globalChatReasoningEffort: settings.chatReasoningEffort,
    ...(tools ? { tools } : {}),
    ...(args.toolChoice !== undefined ? { toolChoice: args.toolChoice } : {}),
    ...(args.output ? { output: args.output } : {}),
  }, args);

  return finishApproval(decision, async () => {
    const chosenProviderId = normalizeProviderId(
      decision.providerId || promptProviderId
    );
    // Do not fall back to the pre-prompt provider: hasProviderHostAccess would
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
        // Same host gate as persistent grants: approving without optional host
        // access (compat origin or Firefox built-in) would only fail later when
        // streaming. Do not report these as permission_denied — Allow already
        // succeeded — and never write Always-allow while host access is missing.
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
        if (!(await hasProviderHostAccess(chosenProvider))) {
          const label = chosenProvider.label || chosenProviderId;
          const message = isCompatProviderId(chosenProviderId)
            ? `Host permission not granted for ${label}. Re-save the endpoint in extension Options to allow access.`
            : revokedHostAccessMessage(label);
          return {
            allowed: false,
            providerId: chosenProviderId,
            model: chosenModel,
            once: false,
            code: "unavailable",
            message,
          };
        }
        await saveApprovalChoice(args.origin, {
          always: decision.decision === "always",
          providerId: chosenProviderId,
          model: chosenModel,
          ...(decision.chatReasoningEffort !== undefined
            ? { chatReasoningEffort: decision.chatReasoningEffort } : {}),
          ...(toolFingerprint ? { toolFingerprint } : {}),
          ...(toolFingerprint && args.toolChoice === "none"
            ? { toolChoiceNone: true } : {}),
          ...(messagesHaveImageParts(args.messages) ? { imageInput: true } : {}),
          ...(requestWantsImageOutput(args.output) ? { imageOutput: true } : {}),
        });
        if (decision.decision === "always") {
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
            ...(args.toolChoice === "none" ? { toolChoiceNone: true } : {}),
            ...imageApprovalFields(null, args.messages, args.output),
          });
        }
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
  });
}

/**
 * @param {string} requestId
 */
export function approvalPageUrl(requestId) {
  const url = new URL(chrome.runtime.getURL("ui/approval.html"));
  url.searchParams.set("requestId", requestId);
  return url.href;
}

/**
 * @param {string} requestId
 */
function takePendingApproval(requestId) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return;
  pendingApprovals.delete(requestId);
  clearTimeout(entry.timeout);
  return entry;
}

/** @param {number} tabId */
function closeApprovalTab(tabId) {
  void chrome.tabs.remove(tabId).catch(() => {
    // The user may already have closed the tab.
  });
}

/**
 * @param {ApprovalRequest} request
 * @param {{ signal?: AbortSignal, sourceTab?: { id?: number, windowId?: number } }} context
 * @returns {Promise<{ decision: ApprovalDecision, providerId: string, model: string, voice?: string, chatReasoningEffort?: import("./chat-options.js").SiteChatReasoningEffort, acknowledge?: (result: { ok: boolean, error?: string }) => void }>}
 */
function promptUser(request, { signal, sourceTab }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const url = approvalPageUrl(request.requestId);
    const entry = { request, resolve, tabId: undefined, windowId: undefined, timeout: undefined };
    pendingApprovals.set(request.requestId, entry);

    function fail(message, code = "unavailable") {
      if (pendingApprovals.get(request.requestId) !== entry) return;
      takePendingApproval(request.requestId);
      if (entry.tabId != null) closeApprovalTab(entry.tabId);
      reject(Object.assign(new Error(message), { name: "InferenceError", code }));
    }

    if (isSafariBuild()) {
      entry.timeout = setTimeout(() => {
        fail("Approval timed out. Retry the request from the website.", "aborted");
      }, SAFARI_APPROVAL_TIMEOUT_MS);
      void Promise.resolve().then(async () => {
        if (pendingApprovals.get(request.requestId) !== entry) return;
        const tab = await chrome.tabs.create({
          url,
          active: true,
          ...(sourceTab?.id != null ? { openerTabId: sourceTab.id } : {}),
          ...(sourceTab?.windowId != null ? { windowId: sourceTab.windowId } : {}),
        });
        if (tab?.id == null || tab.id < 0) {
          throw new Error("Safari did not return an approval tab.");
        }
        if (pendingApprovals.get(request.requestId) !== entry) {
          // The requesting page may have cancelled while Safari opened the tab.
          closeApprovalTab(tab.id);
          return;
        }
        entry.tabId = tab.id;
        // A tab can be closed before create() returns and before onRemoved
        // can associate the tab with the pending approval.
        try {
          await chrome.tabs.get(tab.id);
        } catch {
          handleApprovalTabClosed(tab.id);
        }
      }).catch(() => fail("Could not open the Safari approval tab. Retry the request from the website."));
      return;
    }

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
        if (pendingApprovals.get(request.requestId) !== entry) return;
        if (chrome.runtime.lastError || !win?.id) {
          fail(chrome.runtime.lastError?.message || "Failed to open approval window");
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
 * @param {{ decision: ApprovalDecision, providerId?: string, model: string, voice?: string, chatReasoningEffort?: import("./chat-options.js").SiteChatReasoningEffort }} result
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function resolveApproval(requestId, result) {
  const entry = takePendingApproval(requestId);
  if (!entry) return { ok: false };

  let acknowledge;
  const completion = new Promise((resolve) => { acknowledge = resolve; });
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
    acknowledge,
    providerId: normalizeProviderId(rawProviderId),
    model: typeof result.model === "string" ? result.model : entry.request.model,
    ...((entry.request.method === undefined || entry.request.method === "chat") &&
      result.chatReasoningEffort !== undefined &&
      normalizeSiteChatReasoningEffort(result.chatReasoningEffort) === result.chatReasoningEffort
      ? { chatReasoningEffort: result.chatReasoningEffort }
      : {}),
    ...(typeof result.voice === "string"
      ? { voice: result.voice }
      : "voice" in entry.request && typeof entry.request.voice === "string"
        ? { voice: entry.request.voice }
        : {}),
  });

  // Let the approval page close itself after sendMessage succeeds.
  // Closing the surface here can race with the page and obscure the decision.
  return completion;
}

/**
 * Complete validation and persistence before the approval UI closes. A failed
 * write rejects the page request and tells the popup to show the same error.
 * Cancel/window-close decisions do not have an acknowledgement callback.
 */
async function finishApproval(decision, apply) {
  try {
    const result = await apply();
    decision.acknowledge?.({ ok: true });
    return result;
  } catch (error) {
    decision.acknowledge?.({
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the permission decision.",
    });
    throw error;
  }
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
    if (entry.windowId === windowId) denyPendingApproval(requestId);
  }
}

/** @param {number} tabId */
export function handleApprovalTabClosed(tabId) {
  for (const [requestId, entry] of pendingApprovals.entries()) {
    if (entry.tabId === tabId) denyPendingApproval(requestId);
  }
}

/**
 * True when url is still this request's approval document. Uses protocol +
 * host + pathname + optional requestId so interim WebKit URLs (missing query)
 * and reloads do not false-deny. Prefer host over origin: chrome-extension
 * URLs are opaque (`origin === "null"`) in some runtimes including Node tests.
 * Also used to trust get-approval / resolve-approval senders.
 * @param {string} urlString
 * @param {string} requestId
 */
export function isApprovalDocumentUrl(urlString, requestId) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const expected = new URL(approvalPageUrl(requestId));
  if (url.protocol !== expected.protocol || url.host !== expected.host) {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const expectedPath = expected.pathname.replace(/\/+$/, "") || "/";
  if (path !== expectedPath) return false;
  const reportedId = url.searchParams.get("requestId");
  if (reportedId != null && reportedId !== "" && reportedId !== requestId) {
    return false;
  }
  return true;
}

/**
 * Trust get-approval / resolve-approval only from this request's approval
 * document. Safari tabs also bind to the stored approval tabId so concurrent
 * interim URLs (no ?requestId=) cannot cross-read or cross-resolve.
 * @param {string} requestId
 * @param {{ url?: string, tab?: { id?: number } }} sender
 */
export function isTrustedApprovalSender(requestId, sender) {
  if (typeof requestId !== "string" || typeof sender?.url !== "string") {
    return false;
  }
  if (!isApprovalDocumentUrl(sender.url, requestId)) return false;
  const entry = pendingApprovals.get(requestId);
  if (entry?.tabId != null && sender.tab?.id !== entry.tabId) return false;
  return true;
}

/**
 * Deny a Safari approval when its tab navigates away from the approval
 * document (back, address bar, link). Closing the tab is handled separately.
 * @param {number} tabId
 * @param {{ url?: string }} changeInfo
 */
export function handleApprovalTabNavigated(tabId, changeInfo) {
  if (typeof changeInfo?.url !== "string" || !changeInfo.url) return;
  for (const [requestId, entry] of pendingApprovals.entries()) {
    if (entry.tabId !== tabId) continue;
    if (isApprovalDocumentUrl(changeInfo.url, requestId)) continue;
    denyPendingApproval(requestId);
  }
}

/**
 * Deny a pending approval (e.g. request aborted while prompting).
 * @param {string} requestId
 */
export function cancelApproval(requestId) {
  const entry = denyPendingApproval(requestId);
  if (!entry) return;
  if (entry.tabId != null) closeApprovalTab(entry.tabId);
  if (entry.windowId != null) {
    chrome.windows.remove(entry.windowId, () => {
      void chrome.runtime.lastError;
    });
  }
}

/** @param {string} requestId */
function denyPendingApproval(requestId) {
  const entry = takePendingApproval(requestId);
  if (!entry) return;
  entry.resolve({
    decision: "deny",
    providerId: entry.request.providerId,
    model: entry.request.model,
  });
  return entry;
}
