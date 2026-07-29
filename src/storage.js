/**
 * Extension-local settings. API keys never leave this storage / service worker.
 */

/**
 * @typedef {{ allowedAt: number, providerId?: string, model?: string }} OriginGrant
 * @typedef {{ blockedAt: number }} OriginBlock
 */

const DEFAULTS = Object.freeze({
  /** @type {Record<string, string>} */
  apiKeys: {},
  defaultProviderId: "openai",
  /** Per-provider remembered models. Active model is defaultModels[defaultProviderId]. */
  /** @type {Readonly<Record<string, string>>} */
  defaultModels: Object.freeze({
    openai: "gpt-5.6-luna",
    openrouter: "openrouter/auto",
  }),
  /** @type {Record<string, OriginGrant>} */
  allowedOrigins: {},
  /** @type {Record<string, OriginBlock>} */
  blockedOrigins: {},
});

/**
 * OpenRouter catalog ids are always `org/model`. OpenAI's curated list has no
 * slash. Reject cross-contaminated prefs (e.g. gpt-5.6-luna stored under
 * openrouter after an older single-defaultModel save).
 * @param {string} providerId
 * @param {string} model
 * @returns {boolean}
 */
export function isPlausibleModelForProvider(providerId, model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  if (!trimmed) return false;
  if (providerId === "openrouter") return trimmed.includes("/");
  if (providerId === "openai") return !trimmed.includes("/");
  return true;
}

/**
 * Legacy grants / settings without a providerId are treated as OpenAI.
 * @param {string | undefined} providerId
 * @returns {string}
 */
export function normalizeProviderId(providerId) {
  return typeof providerId === "string" && providerId.trim()
    ? providerId.trim()
    : DEFAULTS.defaultProviderId;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) {
      out[key] = entry.trim();
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeApiKeys(value) {
  return normalizeStringMap(value);
}

/**
 * @returns {Promise<{
 *   apiKeys: Record<string, string>,
 *   defaultProviderId: string,
 *   defaultModel: string,
 *   defaultModels: Record<string, string>,
 *   allowedOrigins: Record<string, OriginGrant>,
 *   blockedOrigins: Record<string, OriginBlock>
 * }>}
 */
export async function getSettings() {
  // Always read legacy keys even though they are no longer in DEFAULTS, so
  // upgrades can migrate them (openaiApiKey → apiKeys, defaultModel → defaultModels).
  const stored = await chrome.storage.local.get([
    ...Object.keys(DEFAULTS),
    "blockedOrigins",
    "openaiApiKey",
    "defaultModel",
  ]);
  const allowedOrigins =
    stored.allowedOrigins && typeof stored.allowedOrigins === "object"
      ? /** @type {Record<string, OriginGrant>} */ ({ ...stored.allowedOrigins })
      : {};
  const blockedOrigins =
    stored.blockedOrigins && typeof stored.blockedOrigins === "object"
      ? /** @type {Record<string, OriginBlock>} */ ({ ...stored.blockedOrigins })
      : {};

  // Drop opaque / file principals if a prior build stored grants under them.
  // Those keys are not stable site identities and must never authorize broadly.
  let scrubbed = false;
  for (const key of Object.keys(allowedOrigins)) {
    if (key === "null" || key === "file://" || key.startsWith("file:")) {
      delete allowedOrigins[key];
      scrubbed = true;
    }
  }
  for (const key of Object.keys(blockedOrigins)) {
    if (key === "null" || key === "file://" || key.startsWith("file:")) {
      delete blockedOrigins[key];
      scrubbed = true;
    }
  }

  const apiKeys = normalizeApiKeys(stored.apiKeys);
  const legacyOpenAiKey =
    typeof stored.openaiApiKey === "string" ? stored.openaiApiKey.trim() : "";
  // Migrate once: fold the flat openaiApiKey into the map when openai is unset.
  if (legacyOpenAiKey && !apiKeys.openai) {
    apiKeys.openai = legacyOpenAiKey;
    scrubbed = true;
  }
  const hasLegacyApiKey = Object.prototype.hasOwnProperty.call(stored, "openaiApiKey");
  if (hasLegacyApiKey) {
    scrubbed = true;
  }

  const defaultProviderId = normalizeProviderId(
    typeof stored.defaultProviderId === "string" ? stored.defaultProviderId : undefined
  );
  /** @type {Record<string, string>} */
  let defaultModels = normalizeStringMap(stored.defaultModels);
  const legacyDefaultModel =
    typeof stored.defaultModel === "string" && stored.defaultModel.trim()
      ? stored.defaultModel.trim()
      : "";
  // Fold the legacy flat defaultModel into the per-provider map when missing,
  // but only when the model looks like it belongs to that provider.
  if (
    legacyDefaultModel &&
    !defaultModels[defaultProviderId] &&
    isPlausibleModelForProvider(defaultProviderId, legacyDefaultModel)
  ) {
    defaultModels[defaultProviderId] = legacyDefaultModel;
    scrubbed = true;
  }
  const hasLegacyDefaultModel = Object.prototype.hasOwnProperty.call(
    stored,
    "defaultModel"
  );
  if (hasLegacyDefaultModel) {
    scrubbed = true;
  }

  // Drop cross-provider contamination (e.g. an OpenAI slug under openrouter).
  for (const [providerId, model] of Object.entries(defaultModels)) {
    if (!isPlausibleModelForProvider(providerId, model)) {
      delete defaultModels[providerId];
      scrubbed = true;
    }
  }

  // Fresh install / empty map: use baked-in defaults without forcing a storage
  // write until the user saves.
  if (Object.keys(defaultModels).length === 0) {
    defaultModels = { ...DEFAULTS.defaultModels };
  }

  const defaultModel =
    defaultModels[defaultProviderId] ||
    DEFAULTS.defaultModels[defaultProviderId] ||
    DEFAULTS.defaultModels.openai ||
    "";

  if (scrubbed) {
    /** @type {Record<string, unknown>} */
    const patch = {
      allowedOrigins,
      blockedOrigins,
      apiKeys,
      defaultModels,
    };
    await chrome.storage.local.set(patch);
    /** @type {string[]} */
    const toRemove = [];
    if (hasLegacyApiKey) toRemove.push("openaiApiKey");
    if (hasLegacyDefaultModel) toRemove.push("defaultModel");
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  }

  return {
    apiKeys,
    defaultProviderId,
    defaultModel,
    defaultModels,
    allowedOrigins,
    blockedOrigins,
  };
}

/**
 * Opaque `"null"` is not a persistable site identity.
 * @param {string} origin
 * @returns {boolean}
 */
function isPersistableOriginKey(origin) {
  return typeof origin === "string" && origin.length > 0 && origin !== "null";
}

/**
 * @param {Partial<{
 *   apiKeys: Record<string, string>,
 *   defaultProviderId: string,
 *   defaultModel: string,
 *   defaultModels: Record<string, string>
 * }>} patch
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  /** @type {Record<string, unknown>} */
  const next = {};

  if (patch.apiKeys && typeof patch.apiKeys === "object") {
    /** @type {Record<string, string>} */
    const merged = { ...current.apiKeys };
    for (const [providerId, key] of Object.entries(patch.apiKeys)) {
      if (typeof key !== "string") continue;
      const trimmed = key.trim();
      if (trimmed) {
        merged[providerId] = trimmed;
      } else {
        delete merged[providerId];
      }
    }
    next.apiKeys = merged;
  }

  const nextProviderId =
    typeof patch.defaultProviderId === "string" && patch.defaultProviderId.trim()
      ? patch.defaultProviderId.trim()
      : current.defaultProviderId;

  /** @type {Record<string, string>} */
  let nextDefaultModels = { ...current.defaultModels };
  let modelsTouched = false;

  if (patch.defaultModels && typeof patch.defaultModels === "object") {
    modelsTouched = true;
    for (const [providerId, model] of Object.entries(patch.defaultModels)) {
      if (typeof model !== "string") continue;
      const trimmed = model.trim();
      if (!trimmed) {
        delete nextDefaultModels[providerId];
      } else if (isPlausibleModelForProvider(providerId, trimmed)) {
        nextDefaultModels[providerId] = trimmed;
      }
      // Implausible non-empty values are ignored so a bad write cannot wipe a
      // previously saved model while the caller still believes save succeeded.
    }
  }

  // Convenience: patch.defaultModel writes the active provider's map entry.
  if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
    const trimmed = patch.defaultModel.trim();
    modelsTouched = true;
    if (isPlausibleModelForProvider(nextProviderId, trimmed)) {
      nextDefaultModels[nextProviderId] = trimmed;
    }
    // else: ignore — do not delete the existing entry
  }

  if (typeof patch.defaultProviderId === "string" && patch.defaultProviderId.trim()) {
    next.defaultProviderId = nextProviderId;
  }

  if (modelsTouched || next.defaultProviderId) {
    next.defaultModels = nextDefaultModels;
  }

  if (Object.keys(next).length > 0) {
    await chrome.storage.local.set(next);
    // Drop any leftover flat defaultModel key — the map is the source of truth.
    await chrome.storage.local.remove("defaultModel");
  }
}

/**
 * @param {string} origin
 * @returns {Promise<OriginGrant | null>}
 */
export async function getOriginGrant(origin) {
  if (!isPersistableOriginKey(origin)) return null;
  const { allowedOrigins } = await getSettings();
  return allowedOrigins[origin] ?? null;
}

/**
 * @param {string} origin
 * @returns {Promise<boolean>}
 */
export async function isOriginBlocked(origin) {
  if (!isPersistableOriginKey(origin)) return false;
  const { blockedOrigins } = await getSettings();
  return Boolean(blockedOrigins[origin]);
}

/**
 * @param {string} origin
 * @param {{ providerId: string, model: string }} options
 */
export async function grantOriginAlways(origin, { providerId, model }) {
  if (!isPersistableOriginKey(origin)) return;
  const { allowedOrigins, blockedOrigins } = await getSettings();
  delete blockedOrigins[origin];
  allowedOrigins[origin] = {
    allowedAt: Date.now(),
    providerId: normalizeProviderId(providerId),
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
  };
  await chrome.storage.local.set({ allowedOrigins, blockedOrigins });
}

/**
 * Persist a never-allow decision for an origin.
 * @param {string} origin
 */
export async function blockOrigin(origin) {
  if (!isPersistableOriginKey(origin)) return;
  const { allowedOrigins, blockedOrigins } = await getSettings();
  delete allowedOrigins[origin];
  blockedOrigins[origin] = { blockedAt: Date.now() };
  await chrome.storage.local.set({ allowedOrigins, blockedOrigins });
}

/**
 * @param {string} origin
 */
export async function unblockOrigin(origin) {
  if (!isPersistableOriginKey(origin)) return;
  const { blockedOrigins } = await getSettings();
  delete blockedOrigins[origin];
  await chrome.storage.local.set({ blockedOrigins });
}

/**
 * Update the saved provider/model for an existing always-allow grant.
 * @param {string} origin
 * @param {{ providerId: string, model: string }} options
 * @returns {Promise<boolean>} false if the origin is not granted
 */
export async function setOriginProviderModel(origin, { providerId, model }) {
  if (!isPersistableOriginKey(origin)) return false;
  const { allowedOrigins } = await getSettings();
  const grant = allowedOrigins[origin];
  if (!grant) return false;
  const nextModel = typeof model === "string" ? model.trim() : "";
  if (!nextModel) return false;
  allowedOrigins[origin] = {
    ...grant,
    providerId: normalizeProviderId(providerId),
    model: nextModel,
  };
  await chrome.storage.local.set({ allowedOrigins });
  return true;
}

/**
 * @deprecated Prefer setOriginProviderModel — kept for call-site migration.
 * @param {string} origin
 * @param {string} model
 * @returns {Promise<boolean>}
 */
export async function setOriginModel(origin, model) {
  if (!isPersistableOriginKey(origin)) return false;
  const { allowedOrigins } = await getSettings();
  const grant = allowedOrigins[origin];
  if (!grant) return false;
  return setOriginProviderModel(origin, {
    providerId: normalizeProviderId(grant.providerId),
    model,
  });
}

/**
 * @param {string} origin
 */
export async function revokeOrigin(origin) {
  if (!isPersistableOriginKey(origin)) return;
  const { allowedOrigins } = await getSettings();
  delete allowedOrigins[origin];
  await chrome.storage.local.set({ allowedOrigins });
}

/**
 * @returns {Promise<Array<{ origin: string, providerId: string, model?: string, allowedAt: number }>>}
 */
export async function listAllowedOrigins() {
  const { allowedOrigins } = await getSettings();
  return Object.entries(allowedOrigins)
    .map(([origin, grant]) => ({
      origin,
      providerId: normalizeProviderId(grant?.providerId),
      model: grant?.model,
      allowedAt: grant?.allowedAt ?? 0,
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/**
 * @returns {Promise<Array<{ origin: string, blockedAt: number }>>}
 */
export async function listBlockedOrigins() {
  const { blockedOrigins } = await getSettings();
  return Object.entries(blockedOrigins)
    .map(([origin, block]) => ({
      origin,
      blockedAt: block?.blockedAt ?? 0,
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}
