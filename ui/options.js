import {
  getSettings,
  saveSettings,
  listAllowedOrigins,
  listBlockedOrigins,
  revokeOrigin,
  setOriginProviderModel,
  unblockOrigin,
  isPlausibleModelForProvider,
} from "../src/storage.js";
import {
  isModelValid,
  populateModelInput,
  populateModelSelect,
  usesModelAutosuggest,
} from "./model-input.js";

const providerSelect = document.getElementById("provider");
const apiKeyField = document.getElementById("apiKeyField");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyInput = document.getElementById("apiKey");
const toggleApiKeyButton = document.getElementById("toggleApiKey");
const ollamaStatusRow = document.getElementById("ollamaStatusRow");
const ollamaHint = document.getElementById("ollamaHint");
const checkOllamaButton = document.getElementById("checkOllama");
const modelSelect = document.getElementById("modelSelect");
const modelInputRow = document.getElementById("modelInputRow");
const modelInput = document.getElementById("modelInput");
const clearModelButton = document.getElementById("clearModel");
const modelList = document.getElementById("modelList");
const modelHint = document.getElementById("modelHint");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");
const originsEl = document.getElementById("origins");
const originsEmpty = document.getElementById("originsEmpty");
const blockedEl = document.getElementById("blocked");
const blockedEmpty = document.getElementById("blockedEmpty");

/** @type {Array<{ id: string, label: string, requiresApiKey: boolean, defaultModel: string, models?: Array<{ id: string, label?: string }> }>} */
let providers = [];

/** @type {Map<string, { models: Array<{ id: string, label?: string }>, error?: string }>} */
const modelCache = new Map();

/**
 * In-memory drafts for every requiresApiKey provider. Survives provider
 * switches in the UI so typing an OpenAI key, flipping to OpenRouter, then
 * back does not lose the unsaved value. Persisted only on Save.
 * @type {Record<string, string>}
 */
let apiKeyDrafts = {};

/** Provider id currently bound to the visible API key input, if any. */
let apiKeyBoundProviderId = "";

/**
 * @type {{
 *   available: boolean,
 *   models: Array<{ id: string, label?: string }>,
 *   message: string,
 * }}
 */
let ollamaStatus = {
  available: false,
  models: [],
  message: "",
};

/** Clears success feedback after a short delay; errors stay until replaced. */
let statusClearTimer = 0;

function setStatus(message, kind) {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = 0;
  }
  statusEl.textContent = message;
  statusEl.className = `status status-end${kind ? ` ${kind}` : ""}`;
  if (kind === "ok" && message) {
    statusClearTimer = window.setTimeout(() => {
      statusClearTimer = 0;
      if (statusEl.classList.contains("ok")) {
        statusEl.textContent = "";
        statusEl.className = "status status-end";
      }
    }, 2500);
  }
}

/**
 * @param {unknown} models
 * @returns {Array<{ id: string, label?: string }>}
 */
function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  /** @type {Array<{ id: string, label?: string }>} */
  const out = [];
  for (const entry of models) {
    if (typeof entry === "string" && entry) {
      out.push({ id: entry });
      continue;
    }
    if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id) {
      out.push({
        id: entry.id,
        ...(typeof entry.label === "string" && entry.label
          ? { label: entry.label }
          : {}),
      });
    }
  }
  return out;
}

/**
 * Probe local Ollama. Unavailable or empty installs keep the option disabled.
 */
async function refreshOllamaStatus() {
  const response = await chrome.runtime.sendMessage({
    type: "list-models",
    providerId: "ollama",
  });

  if (!response?.ok) {
    ollamaStatus = {
      available: false,
      models: [],
      message:
        "Ollama is unavailable at http://localhost:11434, so this option is disabled. Install and start Ollama, then click Check again.",
    };
    modelCache.delete("ollama");
    return ollamaStatus;
  }

  const models = normalizeModels(response.models);
  if (models.length === 0) {
    ollamaStatus = {
      available: false,
      models: [],
      message:
        "Ollama is running but has no models installed, so this option is disabled. Run ollama pull gemma4, then click Check again.",
    };
    modelCache.delete("ollama");
    return ollamaStatus;
  }

  ollamaStatus = {
    available: true,
    models,
    message:
      "Ollama is available at http://localhost:11434. Models are listed from your local install.",
  };
  modelCache.delete("ollama");
  return ollamaStatus;
}

/**
 * Stash the visible API key input into drafts before switching providers.
 */
function syncApiKeyDraftFromInput() {
  if (!apiKeyBoundProviderId) return;
  apiKeyDrafts[apiKeyBoundProviderId] = apiKeyInput.value;
}

/**
 * Show the API key field only for the selected provider when it needs one.
 * @param {string} providerId
 */
function updateApiKeyField(providerId) {
  syncApiKeyDraftFromInput();

  const provider = providers.find((p) => p.id === providerId);
  const needsKey = Boolean(provider?.requiresApiKey);
  apiKeyField.hidden = !needsKey;

  if (!needsKey || !provider) {
    apiKeyBoundProviderId = "";
    return;
  }

  apiKeyBoundProviderId = provider.id;
  apiKeyLabel.textContent = `${provider.label} API key`;
  apiKeyInput.placeholder =
    provider.id === "openrouter" ? "sk-or-..." : "sk-...";
  apiKeyInput.value = apiKeyDrafts[provider.id] || "";
  apiKeyInput.type = "password";
  toggleApiKeyButton.textContent = "Show";
  toggleApiKeyButton.setAttribute("aria-pressed", "false");
}

/**
 * @param {string} providerId
 */
function updateProviderChrome(providerId) {
  updateApiKeyField(providerId);

  // Only surface Ollama help + Check again when the option is disabled.
  const showOllamaStatus = !ollamaStatus.available;
  ollamaStatusRow.hidden = !showOllamaStatus;
  checkOllamaButton.hidden = !showOllamaStatus;
  if (showOllamaStatus) {
    ollamaHint.textContent =
      ollamaStatus.message ||
      "Ollama is unavailable at http://localhost:11434, so this option is disabled.";
  }
}

/**
 * @param {string} providerId
 * @returns {boolean}
 */
function allowUnknownFor(providerId) {
  return providerId !== "ollama";
}

/**
 * @param {string} providerId
 * @returns {Promise<{ models: Array<{ id: string, label?: string }>, error?: string }>}
 */
async function fetchModels(providerId) {
  if (providerId === "ollama") {
    if (!ollamaStatus.available) {
      return { models: [], error: ollamaStatus.message };
    }
    return { models: ollamaStatus.models };
  }

  const cached = modelCache.get(providerId);
  if (cached) return cached;

  const response = await chrome.runtime.sendMessage({
    type: "list-models",
    providerId,
  });

  if (!response?.ok) {
    const result = {
      models: /** @type {Array<{ id: string, label?: string }>} */ ([]),
      error: response?.error?.message || "Failed to list models",
    };
    modelCache.set(providerId, result);
    return result;
  }

  const result = {
    models: normalizeModels(response.models),
  };
  modelCache.set(providerId, result);
  return result;
}

/**
 * Populate the default-provider select. Keeps the stored selection even when
 * that provider is unavailable (e.g. Ollama down) so Save cannot silently
 * persist a UI fallback onto another provider. Unknown ids are listed as
 * "(unknown)" — same fail-closed pattern as origin grants.
 * @param {HTMLSelectElement} select
 * @param {string} selectedId
 * @returns {string} the provider id actually selected
 */
function populateProviderSelect(select, selectedId) {
  select.replaceChildren();
  const known = providers.some((p) => p.id === selectedId);

  if (!known && selectedId) {
    const unknownOpt = document.createElement("option");
    unknownOpt.value = selectedId;
    unknownOpt.textContent = `${selectedId} (unknown)`;
    unknownOpt.selected = true;
    select.append(unknownOpt);
  }

  const fallback =
    providers.find((p) => p.id === "openai")?.id || providers[0]?.id || "";
  // Empty selectedId (fresh install) falls back; a known/unknown id is kept
  // even when that provider is currently unavailable.
  const effectiveId = selectedId || fallback;

  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    const unavailable = provider.id === "ollama" && !ollamaStatus.available;
    // Keep the current selection choosable; block switching *to* Ollama when down.
    option.disabled = unavailable && effectiveId !== provider.id;
    option.textContent = unavailable
      ? `${provider.label} (unavailable)`
      : provider.label;
    if ((known || !selectedId) && provider.id === effectiveId) {
      option.selected = true;
    }
    select.append(option);
  }
  return effectiveId;
}

/** Bumped on each default-model load so a slower earlier fetch cannot repaint. */
let defaultModelsLoadId = 0;

/** Models currently backing the default model input (for validation). */
/** @type {Array<{ id: string, label?: string }>} */
let defaultModels = [];

/**
 * Show select for short catalogs; searchable input for OpenRouter.
 * @param {string} providerId
 */
function setDefaultModelControlMode(providerId) {
  const autosuggest = usesModelAutosuggest(providerId);
  modelSelect.hidden = autosuggest;
  modelInputRow.hidden = !autosuggest;
  updateClearModelButton();
}

function updateClearModelButton() {
  const visible =
    !modelInputRow.hidden &&
    !modelInput.disabled &&
    modelInput.value.trim().length > 0;
  clearModelButton.hidden = !visible;
}

/**
 * @param {string} providerId
 * @returns {string}
 */
function readDefaultModelValue(providerId) {
  if (usesModelAutosuggest(providerId)) {
    return modelInput.value.trim();
  }
  return modelSelect.value;
}

/**
 * @param {string} providerId
 * @param {Array<{ id: string, label?: string }>} models
 * @param {string | undefined} selected
 * @param {{ allowUnknown?: boolean, disabled?: boolean }} [opts]
 */
function populateDefaultModelControl(providerId, models, selected, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false;
  const disabled = Boolean(opts.disabled);
  setDefaultModelControlMode(providerId);

  if (usesModelAutosuggest(providerId)) {
    populateModelInput(modelInput, modelList, models, selected, { allowUnknown });
    modelInput.disabled = disabled;
    modelSelect.disabled = true;
    updateClearModelButton();
    return;
  }

  populateModelSelect(modelSelect, models, selected, { allowUnknown });
  modelSelect.disabled = disabled;
  modelInput.disabled = true;
  updateClearModelButton();
}

/**
 * @param {string} providerId
 * @param {string | undefined} preferredModel
 */
async function refreshDefaultModels(providerId, preferredModel) {
  const loadId = ++defaultModelsLoadId;
  modelHint.hidden = true;
  modelHint.textContent = "";
  populateDefaultModelControl(providerId, [], preferredModel, {
    allowUnknown: true,
    disabled: true,
  });

  const { models, error } = await fetchModels(providerId);
  // Ignore stale responses after the user switches providers mid-flight.
  if (loadId !== defaultModelsLoadId || providerSelect.value !== providerId) {
    return;
  }

  // Keep the saved Ollama model visible (read-only) while Ollama is down so
  // the UI reflects the persisted default rather than an empty remapped catalog.
  if (providerId === "ollama" && !ollamaStatus.available) {
    defaultModels = preferredModel ? [{ id: preferredModel }] : [];
    populateDefaultModelControl(
      providerId,
      preferredModel ? [{ id: preferredModel }] : [],
      preferredModel,
      { allowUnknown: true, disabled: true }
    );
    return;
  }

  defaultModels = models;
  const allowUnknown = allowUnknownFor(providerId);
  populateDefaultModelControl(providerId, models, preferredModel, {
    allowUnknown,
    disabled: models.length === 0 && !allowUnknown,
  });

  if (error && providerId !== "ollama") {
    modelHint.hidden = false;
    modelHint.textContent = error;
  } else if (models.length === 0 && providerId !== "ollama") {
    modelHint.hidden = false;
    modelHint.textContent = "No models available for this provider.";
  } else if (
    preferredModel &&
    allowUnknown &&
    !models.some((m) => m.id === preferredModel) &&
    readDefaultModelValue(providerId) === preferredModel
  ) {
    modelHint.hidden = false;
    modelHint.textContent =
      "Saved model is not in the current catalog; it will still be used.";
  }
}

/** Last saved default provider — used to restore Ollama after Check again. */
let savedDefaultProviderId = "openai";

/** Per-provider model drafts — survives switching before Save, persisted as defaultModels. */
/** @type {Record<string, string>} */
let modelDrafts = {};

/** Provider id currently shown in the default model control. */
let modelBoundProviderId = "";

/**
 * Stash the visible model control into drafts before switching providers.
 */
function syncModelDraftFromControl() {
  if (!modelBoundProviderId) return;
  const value = readDefaultModelValue(modelBoundProviderId);
  if (value && isPlausibleModelForProvider(modelBoundProviderId, value)) {
    modelDrafts[modelBoundProviderId] = value;
  } else if (value) {
    // Drop a cross-contaminated value instead of persisting it.
    delete modelDrafts[modelBoundProviderId];
  }
}

/**
 * @param {string} providerId
 * @returns {string | undefined}
 */
function preferredDefaultModel(providerId) {
  const draft = modelDrafts[providerId];
  if (draft && isPlausibleModelForProvider(providerId, draft)) return draft;
  return providers.find((p) => p.id === providerId)?.defaultModel || undefined;
}

toggleApiKeyButton.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleApiKeyButton.textContent = showing ? "Show" : "Hide";
  toggleApiKeyButton.setAttribute("aria-pressed", showing ? "false" : "true");
});

providerSelect.addEventListener("change", async () => {
  syncModelDraftFromControl();
  const providerId = providerSelect.value;
  modelBoundProviderId = providerId;
  updateProviderChrome(providerId);
  await refreshDefaultModels(providerId, preferredDefaultModel(providerId));
});

modelInput.addEventListener("input", () => {
  updateClearModelButton();
  const providerId = providerSelect.value;
  if (!usesModelAutosuggest(providerId)) return;
  if (!allowUnknownFor(providerId)) {
    const valid = isModelValid(modelInput.value, defaultModels, {
      allowUnknown: false,
    });
    if (modelInput.value.trim() && !valid) {
      modelHint.hidden = false;
      modelHint.textContent = "Choose a model from the installed Ollama tags.";
    } else if (!modelHint.textContent.startsWith("Ollama is")) {
      modelHint.hidden = true;
      modelHint.textContent = "";
    }
  }
});

clearModelButton.addEventListener("click", () => {
  modelInput.value = "";
  if (modelBoundProviderId) {
    delete modelDrafts[modelBoundProviderId];
  }
  updateClearModelButton();
  modelInput.focus();
  modelInput.dispatchEvent(new Event("input"));
});

checkOllamaButton.addEventListener("click", async () => {
  checkOllamaButton.disabled = true;
  checkOllamaButton.textContent = "Checking…";
  try {
    syncModelDraftFromControl();
    const wantedOllama = savedDefaultProviderId === "ollama";
    await refreshOllamaStatus();
    // Restore saved Ollama when it becomes available; otherwise keep the
    // current UI selection (including unavailable Ollama) — never remap to
    // OpenAI, which would make Save overwrite the stored default.
    const nextId = populateProviderSelect(
      providerSelect,
      wantedOllama && ollamaStatus.available ? "ollama" : providerSelect.value
    );
    modelBoundProviderId = nextId;
    updateProviderChrome(nextId);
    await refreshDefaultModels(nextId, preferredDefaultModel(nextId));
    await renderOrigins();
    setStatus(
      ollamaStatus.available ? "Ollama is available." : "Ollama is still unavailable.",
      ollamaStatus.available ? "ok" : "err"
    );
  } finally {
    checkOllamaButton.disabled = false;
    checkOllamaButton.textContent = "Check again";
  }
});

async function renderOrigins() {
  const grants = await listAllowedOrigins();
  originsEl.replaceChildren();
  originsEmpty.hidden = grants.length > 0;

  for (const grant of grants) {
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "origin-meta";

    const code = document.createElement("code");
    code.textContent = grant.origin;
    meta.append(code);

    const providerLabel = document.createElement("label");
    providerLabel.className = "origin-model";
    const providerCaption = document.createElement("span");
    providerCaption.textContent = "Provider";
    const originProviderSelect = document.createElement("select");
    originProviderSelect.setAttribute(
      "aria-label",
      `Provider for ${grant.origin}`
    );
    // Keep an already-granted Ollama selection visible even if currently unavailable.
    // Unknown providerIds stay selected as "(unknown)" — never remapped to a
    // registered provider (that would silently overwrite the fail-closed grant).
    const { providerId: originProviderId, known: providerKnown } =
      populateOriginProviderSelect(originProviderSelect, grant.providerId);
    providerLabel.append(providerCaption, originProviderSelect);
    meta.append(providerLabel);

    const modelLabel = document.createElement("label");
    modelLabel.className = "origin-model";
    const modelCaption = document.createElement("span");
    modelCaption.textContent = "Model";
    const originModelSelect = document.createElement("select");
    originModelSelect.setAttribute("aria-label", `Model for ${grant.origin}`);
    const originModelInput = document.createElement("input");
    originModelInput.type = "text";
    originModelInput.autocomplete = "off";
    originModelInput.spellcheck = false;
    originModelInput.placeholder = "Type to search models…";
    originModelInput.hidden = true;
    const datalistId = `origin-models-${encodeURIComponent(grant.origin)}`;
    originModelInput.setAttribute("list", datalistId);
    originModelInput.setAttribute("aria-label", `Model for ${grant.origin}`);
    const originModelList = document.createElement("datalist");
    originModelList.id = datalistId;
    modelLabel.append(
      modelCaption,
      originModelSelect,
      originModelInput,
      originModelList
    );
    meta.append(modelLabel);

    const modelStatus = document.createElement("p");
    modelStatus.className = "hint origin-model-hint";
    meta.append(modelStatus);

    /** Bumped on each model load for this grant so slower fetches cannot repaint. */
    let originModelsLoadId = 0;
    /** @type {Array<{ id: string, label?: string }>} */
    let originModels = [];

    /**
     * @param {string} providerId
     * @returns {string}
     */
    function readOriginModelValue(providerId) {
      if (usesModelAutosuggest(providerId)) {
        return originModelInput.value.trim();
      }
      return originModelSelect.value;
    }

    /**
     * @param {string} providerId
     * @param {Array<{ id: string, label?: string }>} models
     * @param {string | undefined} selected
     * @param {{ allowUnknown?: boolean, disabled?: boolean }} [opts]
     */
    function populateOriginModelControl(providerId, models, selected, opts = {}) {
      const allowUnknown = opts.allowUnknown !== false;
      const disabled = Boolean(opts.disabled);
      const autosuggest = usesModelAutosuggest(providerId);
      originModelSelect.hidden = autosuggest;
      originModelInput.hidden = !autosuggest;

      if (autosuggest) {
        populateModelInput(originModelInput, originModelList, models, selected, {
          allowUnknown,
        });
        originModelInput.disabled = disabled;
        originModelSelect.disabled = true;
        return;
      }

      populateModelSelect(originModelSelect, models, selected, { allowUnknown });
      originModelSelect.disabled = disabled;
      originModelInput.disabled = true;
    }

    /**
     * @param {string} providerId
     * @param {string | undefined} selectedModel
     * @returns {Promise<boolean>} true when this load still matches the select
     */
    async function loadOriginModels(providerId, selectedModel) {
      const loadId = ++originModelsLoadId;
      populateOriginModelControl(providerId, [], selectedModel, {
        allowUnknown: true,
        disabled: true,
      });
      modelStatus.textContent = "Loading models…";
      const { models, error } = await fetchModels(providerId);
      // Ignore stale responses after the user switches providers mid-flight.
      if (
        loadId !== originModelsLoadId ||
        originProviderSelect.value !== providerId
      ) {
        return false;
      }

      // Keep the saved Ollama grant model visible (read-only) while Ollama is
      // down — same pattern as refreshDefaultModels / unknown-provider grants.
      if (providerId === "ollama" && !ollamaStatus.available) {
        originModels = selectedModel ? [{ id: selectedModel }] : [];
        populateOriginModelControl(
          providerId,
          selectedModel ? [{ id: selectedModel }] : [],
          selectedModel,
          { allowUnknown: true, disabled: true }
        );
        modelStatus.textContent =
          error ||
          "Ollama is unavailable. The saved model is shown read-only until it is running again.";
        return true;
      }

      originModels = models;
      const allowUnknown = allowUnknownFor(providerId);
      populateOriginModelControl(providerId, models, selectedModel, {
        allowUnknown,
        disabled: models.length === 0 && !allowUnknown,
      });
      if (error) {
        modelStatus.textContent = error;
      } else if (models.length === 0) {
        modelStatus.textContent = "No models available.";
      } else {
        modelStatus.textContent = "";
      }
      return true;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async function persistGrant() {
      const providerId = originProviderSelect.value;
      // Refuse to rewrite an unknown grant via the model control (or any path
      // that still has the stale id selected). Only an explicit switch to a
      // registered provider may update storage.
      if (!providers.some((p) => p.id === providerId)) {
        setStatus(
          `Choose a registered provider for ${grant.origin} before updating.`,
          "err"
        );
        return false;
      }
      const model = readOriginModelValue(providerId);
      if (
        !isModelValid(model, originModels, {
          allowUnknown: allowUnknownFor(providerId),
        })
      ) {
        setStatus(`Choose a valid model for ${grant.origin}`, "err");
        return false;
      }
      const ok = await setOriginProviderModel(grant.origin, {
        providerId,
        model,
      });
      if (ok) {
        setStatus(`Updated ${grant.origin}`, "ok");
        return true;
      }
      setStatus(`Could not update ${grant.origin}`, "err");
      await renderOrigins();
      return false;
    }

    originProviderSelect.addEventListener("change", async () => {
      originProviderSelect.disabled = true;
      const providerId = originProviderSelect.value;
      try {
        if (!providers.some((p) => p.id === providerId)) {
          // User re-selected the unknown placeholder; keep the grant untouched.
          return;
        }

        const applied = await loadOriginModels(providerId, undefined);
        if (!applied || originProviderSelect.value !== providerId) {
          return;
        }

        if (
          !isModelValid(readOriginModelValue(providerId), originModels, {
            allowUnknown: allowUnknownFor(providerId),
          })
        ) {
          // The select changes before dynamic model discovery completes.
          // Restore the persisted grant when the new provider cannot supply a
          // model so the UI never implies an unpersisted provider is active.
          await renderOrigins();
          setStatus(
            `Could not switch ${grant.origin}: no models are available.`,
            "err"
          );
          return;
        }

        const saved = await persistGrant();
        // Drop the "(unknown)" option after a successful recovery.
        if (saved && !providerKnown) {
          await renderOrigins();
        }
      } finally {
        originProviderSelect.disabled = false;
      }
    });

    originModelSelect.addEventListener("change", () => {
      void persistGrant();
    });
    originModelInput.addEventListener("change", () => {
      void persistGrant();
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger";
    button.textContent = "Revoke";
    button.addEventListener("click", async () => {
      await revokeOrigin(grant.origin);
      await renderOrigins();
      setStatus(`Revoked ${grant.origin}`, "ok");
    });

    li.append(meta, button);
    originsEl.append(li);

    if (!providerKnown) {
      // Show the saved model read-only; do not load another provider's catalog.
      originModels = grant.model ? [{ id: grant.model }] : [];
      populateOriginModelControl(
        grant.providerId,
        grant.model ? [{ id: grant.model }] : [],
        grant.model,
        { allowUnknown: true, disabled: true }
      );
      modelStatus.textContent = `Unknown provider "${grant.providerId}". Choose a registered provider to update this grant. Requests for this origin fail until then.`;
    } else {
      void loadOriginModels(originProviderId, grant.model);
    }
  }
}

/**
 * Populate a per-origin provider select. Same availability rules as
 * populateProviderSelect: keep a current Ollama grant selected even if
 * unavailable. Unknown provider ids are listed as "(unknown)" so Options
 * never silently remaps a fail-closed grant onto the first registered provider.
 * @param {HTMLSelectElement} select
 * @param {string} selectedId
 * @returns {{ providerId: string, known: boolean }}
 */
function populateOriginProviderSelect(select, selectedId) {
  select.replaceChildren();
  const known = providers.some((p) => p.id === selectedId);

  if (!known && selectedId) {
    const unknownOpt = document.createElement("option");
    unknownOpt.value = selectedId;
    unknownOpt.textContent = `${selectedId} (unknown)`;
    unknownOpt.selected = true;
    select.append(unknownOpt);
  }

  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    const unavailable = provider.id === "ollama" && !ollamaStatus.available;
    // Allow keeping the current grant visible; block switching *to* Ollama when down.
    option.disabled = unavailable && !(known && selectedId === "ollama");
    option.textContent = unavailable
      ? `${provider.label} (unavailable)`
      : provider.label;
    if (known && provider.id === selectedId) option.selected = true;
    select.append(option);
  }
  return { providerId: selectedId, known };
}

async function renderBlocked() {
  const blocks = await listBlockedOrigins();
  blockedEl.replaceChildren();
  blockedEmpty.hidden = blocks.length > 0;

  for (const block of blocks) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = block.origin;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Unblock";
    button.addEventListener("click", async () => {
      await unblockOrigin(block.origin);
      await renderBlocked();
      setStatus(`Unblocked ${block.origin}`, "ok");
    });

    li.append(code, button);
    blockedEl.append(li);
  }
}

async function loadProviders() {
  const response = await chrome.runtime.sendMessage({ type: "list-providers" });
  providers = Array.isArray(response?.providers) ? response.providers : [];
}

async function load() {
  await loadProviders();
  await refreshOllamaStatus();
  const settings = await getSettings();
  savedDefaultProviderId = settings.defaultProviderId;
  modelDrafts = { ...settings.defaultModels };
  for (const [providerId, model] of Object.entries(modelDrafts)) {
    if (!isPlausibleModelForProvider(providerId, model)) {
      delete modelDrafts[providerId];
    }
  }
  if (
    settings.defaultProviderId &&
    settings.defaultModel &&
    isPlausibleModelForProvider(settings.defaultProviderId, settings.defaultModel)
  ) {
    modelDrafts[settings.defaultProviderId] = settings.defaultModel;
  }
  apiKeyDrafts = { ...settings.apiKeys };
  apiKeyBoundProviderId = "";
  const effectiveProvider = populateProviderSelect(
    providerSelect,
    settings.defaultProviderId
  );
  modelBoundProviderId = effectiveProvider;
  updateProviderChrome(effectiveProvider);
  await refreshDefaultModels(effectiveProvider, preferredDefaultModel(effectiveProvider));
  await renderOrigins();
  await renderBlocked();
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  try {
    const providerId = providerSelect.value;
    const model = readDefaultModelValue(providerId);
    if (!providers.some((p) => p.id === providerId)) {
      setStatus("Choose a registered provider before saving.", "err");
      return;
    }
    if (providerId === "ollama" && !ollamaStatus.available) {
      setStatus("Ollama is unavailable. Choose another provider or click Check again.", "err");
      return;
    }
    if (
      !isModelValid(model, defaultModels, {
        allowUnknown: allowUnknownFor(providerId),
      })
    ) {
      setStatus("Choose a valid default model before saving.", "err");
      return;
    }
    if (!isPlausibleModelForProvider(providerId, model)) {
      setStatus(
        providerId === "openrouter"
          ? "OpenRouter models must look like org/model (include a /)."
          : providerId === "openai"
            ? "OpenAI model ids should not include a /."
            : "Choose a valid default model before saving.",
        "err"
      );
      return;
    }

    syncApiKeyDraftFromInput();
    syncModelDraftFromControl();
    modelDrafts[providerId] = model;

    // Persist drafts for every key-requiring provider so switching to Ollama
    // and saving does not wipe remote keys, while clearing the visible field
    // still clears that provider's stored key.
    /** @type {Record<string, string>} */
    const apiKeys = {};
    for (const provider of providers) {
      if (!provider.requiresApiKey) continue;
      apiKeys[provider.id] = apiKeyDrafts[provider.id] || "";
    }

    await saveSettings({
      apiKeys,
      defaultProviderId: providerId,
      defaultModel: model,
      defaultModels: modelDrafts,
    });
    savedDefaultProviderId = providerId;
    setStatus("Saved.", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to save", "err");
  } finally {
    saveButton.disabled = false;
  }
});

void load();
