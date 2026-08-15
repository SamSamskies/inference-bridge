import {
  getSettings,
  saveSettings,
  saveCompatEndpoints,
  listAllowedOrigins,
  listBlockedOrigins,
  revokeOrigin,
  setOriginProviderModel,
  unblockOrigin,
  isPlausibleModelForProvider,
} from "../src/storage.js";
import {
  normalizeCompatBaseUrl,
  requestHostPermissionForBaseUrl,
} from "../src/host-permissions.js";
import { ensureLoopbackOriginBypassForBaseUrl } from "../src/loopback-origin-bypass.js";
import {
  isModelValid,
  populateModelInput,
  populateModelSelect,
  usesModelAutosuggest,
} from "./model-input.js";
import {
  ON_DEVICE_MODEL_ID,
  ON_DEVICE_PROVIDER_ID,
  installLanguageModel,
  probeLanguageModelAvailability,
} from "../src/prompt-api-core.js";

const providerSelect = document.getElementById("provider");
const apiKeyField = document.getElementById("apiKeyField");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyInput = document.getElementById("apiKey");
const toggleApiKeyButton = document.getElementById("toggleApiKey");
const ollamaStatusRow = document.getElementById("ollamaStatusRow");
const ollamaHint = document.getElementById("ollamaHint");
const checkOllamaButton = document.getElementById("checkOllama");
const onDevicePanel = document.getElementById("onDevicePanel");
const onDeviceHint = document.getElementById("onDeviceHint");
const onDeviceInstallButton = document.getElementById("onDeviceInstall");
const onDeviceCancelButton = document.getElementById("onDeviceCancel");
const onDeviceProgress = document.getElementById("onDeviceProgress");
const onDeviceInstallDialog = document.getElementById("onDeviceInstallDialog");
const modelField = document.getElementById("modelField");
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
const compatEndpointsEl = document.getElementById("compatEndpoints");
const compatEndpointsEmpty = document.getElementById("compatEndpointsEmpty");
const compatNameInput = document.getElementById("compatName");
const compatBaseUrlInput = document.getElementById("compatBaseUrl");
const compatApiKeyInput = document.getElementById("compatApiKey");
const compatSaveButton = document.getElementById("compatSave");
const compatCancelButton = document.getElementById("compatCancel");
const compatStatusEl = document.getElementById("compatStatus");

/** @type {Array<{ id: string, label: string, requiresApiKey: boolean, optionalApiKey?: boolean, defaultModel: string, models?: Array<{ id: string, label?: string }> }>} */
let providers = [];

/** @type {Array<{ id: string, name: string, baseUrl: string }>} */
let compatEndpoints = [];

/** Endpoint id being edited, or "" when adding. */
let compatEditingId = "";

/** @type {Map<string, { models: Array<{ id: string, label?: string }>, error?: string }>} */
const modelCache = new Map();

/**
 * In-memory drafts for every key-capable provider. Survives provider
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

/**
 * @type {{
 *   availability: import("../src/prompt-api-core.js").OnDeviceAvailability,
 *   message: string,
 * }}
 */
let onDeviceStatus = {
  availability: "missing",
  message: "",
};

/** @type {AbortController | null} */
let onDeviceInstallController = null;

/**
 * Poll timer while Prompt API reports "downloading" but this Options tab did
 * not start Install (no AbortController / progress). Cleared when availability
 * leaves that state or the on-device panel is hidden.
 * @type {number}
 */
let onDeviceDownloadPollTimer = 0;

/** Clears success feedback after a short delay; errors stay until replaced. */
let statusClearTimer = 0;

function stopOnDeviceDownloadPoll() {
  if (onDeviceDownloadPollTimer) {
    clearTimeout(onDeviceDownloadPollTimer);
    onDeviceDownloadPollTimer = 0;
  }
}

/**
 * Re-probe availability until the browser leaves "downloading". Only used for
 * downloads started elsewhere (or after Options was closed mid-install).
 */
function scheduleOnDeviceDownloadPoll() {
  if (onDeviceDownloadPollTimer) return;
  onDeviceDownloadPollTimer = window.setTimeout(async () => {
    onDeviceDownloadPollTimer = 0;
    await refreshOnDeviceStatus();
    updateOnDevicePanel();
  }, 2000);
}

function setStatus(message, kind) {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = 0;
  }
  statusEl.textContent = message;
  statusEl.className = `status status-end${kind ? ` ${kind}` : ""}`;
  if (kind === "ok" && message) {
    // Keep install/save success visible longer — fast downloads finish before
    // users notice the progress bar, so the status line is the main cue.
    const clearAfterMs = /installed and ready/i.test(message) ? 8000 : 2500;
    statusClearTimer = window.setTimeout(() => {
      statusClearTimer = 0;
      if (statusEl.classList.contains("ok")) {
        statusEl.textContent = "";
        statusEl.className = "status status-end";
      }
    }, clearAfterMs);
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
 * @returns {boolean}
 */
function isOnDeviceOffered() {
  return (
    onDeviceStatus.availability !== "missing" &&
    onDeviceStatus.availability !== "unavailable"
  );
}

/**
 * Ready for default provider / origin grants.
 * @returns {boolean}
 */
function isOnDeviceReady() {
  return onDeviceStatus.availability === "available";
}

/**
 * Probe Prompt API for Options. Chat/approval use the offscreen host, so Ready
 * requires that path. In-page LanguageModel still drives Install UX
 * (downloadable / downloading) because create() needs a user gesture here.
 */
async function refreshOnDeviceStatus() {
  const local = await probeLanguageModelAvailability();

  /** @type {import("../src/prompt-api-core.js").OnDeviceAvailability} */
  let remote = "missing";
  let remoteError = "";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "on-device-status",
    });
    remote =
      typeof response?.availability === "string"
        ? response.availability
        : "missing";
    remoteError = response?.error || "";
  } catch {
    remote = "missing";
    remoteError = "";
  }

  // Inference path — only offscreen "available" means Ready for default / grants.
  if (remote === "available") {
    onDeviceStatus = { availability: "available", message: "" };
    return onDeviceStatus;
  }

  // In-page ready but offscreen is not: never claim Ready.
  if (local === "available") {
    onDeviceStatus = {
      availability:
        remote === "downloadable" || remote === "downloading"
          ? remote
          : "unavailable",
      message:
        remoteError ||
        "On-device AI is installed, but the extension host is not ready.",
    };
    return onDeviceStatus;
  }

  // Prefer in-page for Install / download progress when the API exists here.
  if (local !== "missing") {
    onDeviceStatus = { availability: local, message: "" };
    return onDeviceStatus;
  }

  onDeviceStatus = { availability: remote, message: remoteError };
  return onDeviceStatus;
}

/**
 * Official Chrome help for turning On-device AI off (deletes local model files).
 * Prompt API has no LanguageModel.delete() — Chrome owns the weights.
 */
const ON_DEVICE_MANAGE_HELP_URL =
  "https://support.google.com/chrome/answer/16961953";

/** Chrome page that shows which on-device model the browser selected. */
const ON_DEVICE_INTERNALS_URL = "chrome://on-device-internals";

/**
 * @param {string} text
 * @param {{ manageLink?: boolean, internalsLink?: boolean }} [opts]
 */
function setOnDeviceHint(text, opts = {}) {
  onDeviceHint.replaceChildren();
  onDeviceHint.append(document.createTextNode(text));

  if (opts.internalsLink) {
    onDeviceHint.append(document.createTextNode(" (see "));
    const internalsLink = document.createElement("a");
    internalsLink.href = ON_DEVICE_INTERNALS_URL;
    internalsLink.textContent = "chrome://on-device-internals";
    // chrome:// URLs cannot navigate from <a href>; open via tabs API.
    internalsLink.addEventListener("click", (event) => {
      event.preventDefault();
      void chrome.tabs.create({ url: ON_DEVICE_INTERNALS_URL });
    });
    onDeviceHint.append(internalsLink);
    onDeviceHint.append(document.createTextNode(")."));
  }

  if (!opts.manageLink) return;

  onDeviceHint.append(document.createTextNode(" "));
  const link = document.createElement("a");
  link.href = ON_DEVICE_MANAGE_HELP_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent =
    "To free disk space, turn off On-device AI in Chrome Settings → System";
  onDeviceHint.append(link);
  onDeviceHint.append(document.createTextNode("."));
}

/**
 * Paint Install / progress for the on-device provider.
 */
function updateOnDevicePanel() {
  const selected = providerSelect.value === ON_DEVICE_PROVIDER_ID;
  onDevicePanel.hidden = !selected || !isOnDeviceOffered();
  modelField.hidden = selected && isOnDeviceOffered();

  if (!selected || !isOnDeviceOffered()) {
    stopOnDeviceDownloadPoll();
    onDeviceInstallButton.hidden = true;
    onDeviceCancelButton.hidden = true;
    onDeviceProgress.hidden = true;
    saveButton.hidden = false;
    return;
  }

  const installing = Boolean(onDeviceInstallController);

  if (onDeviceStatus.availability === "available") {
    stopOnDeviceDownloadPoll();
    const isDefault = savedDefaultProviderId === ON_DEVICE_PROVIDER_ID;
    setOnDeviceHint(
      isDefault
        ? "Installed and ready to use. Runs Chrome's Gemini Nano on this device — Chrome chooses the exact build"
        : "Installed and ready. Click Save to make On-device your default. Runs Chrome's Gemini Nano on this device — Chrome chooses the exact build",
      { internalsLink: true, manageLink: true }
    );
    onDeviceInstallButton.hidden = true;
    onDeviceCancelButton.hidden = true;
    onDeviceProgress.hidden = true;
    saveButton.hidden = false;
    return;
  }

  // Only this page's Install can abort or auto-save the default. A browser-
  // reported "downloading" state (e.g. started elsewhere) has neither.
  if (installing) {
    stopOnDeviceDownloadPoll();
    setOnDeviceHint(
      "Downloading the on-device model… This can take a while and the file may be large. When it finishes, On-device is saved as your default."
    );
    onDeviceInstallButton.hidden = true;
    onDeviceCancelButton.hidden = false;
    onDeviceProgress.hidden = false;
    saveButton.hidden = true;
    return;
  }

  if (onDeviceStatus.availability === "downloading") {
    // Keep re-probing so Save appears when a download started elsewhere finishes
    // (or after Options was closed mid-install).
    scheduleOnDeviceDownloadPoll();
    setOnDeviceHint(
      "Downloading the on-device model… This can take a while and the file may be large. When it finishes, you can save On-device as your default."
    );
    onDeviceInstallButton.hidden = true;
    onDeviceCancelButton.hidden = true;
    onDeviceProgress.hidden = true;
    saveButton.hidden = true;
    return;
  }

  stopOnDeviceDownloadPoll();

  // downloadable — Install must call LanguageModel.create in this page so the
  // click keeps user activation; the SW/offscreen path cannot.
  const canInstallInPage =
    typeof globalThis.LanguageModel?.create === "function";
  if (!canInstallInPage) {
    setOnDeviceHint(
      "On-device model is downloadable, but Install needs the Prompt API in this Options page (for the required user gesture). It is not available here."
    );
    onDeviceInstallButton.hidden = true;
    onDeviceCancelButton.hidden = true;
    onDeviceProgress.hidden = true;
    saveButton.hidden = false;
    return;
  }

  setOnDeviceHint(
    "Browser-chosen on-device model. Install may download a large file and take a while, then saves On-device as your default. The browser picks which model",
    { internalsLink: true }
  );
  onDeviceInstallButton.hidden = false;
  onDeviceInstallButton.disabled = false;
  onDeviceCancelButton.hidden = true;
  onDeviceProgress.hidden = true;
  onDeviceProgress.value = 0;
  saveButton.hidden = true;
}

/**
 * Stash the visible API key input into drafts before switching providers.
 */
function syncApiKeyDraftFromInput() {
  if (!apiKeyBoundProviderId) return;
  apiKeyDrafts[apiKeyBoundProviderId] = apiKeyInput.value;
}

/**
 * Show the API key field for providers that require a key or accept an optional one.
 * @param {string} providerId
 */
function updateApiKeyField(providerId) {
  syncApiKeyDraftFromInput();

  const provider = providers.find((p) => p.id === providerId);
  const needsKey = Boolean(provider?.requiresApiKey || provider?.optionalApiKey);
  apiKeyField.hidden = !needsKey;

  if (!needsKey || !provider) {
    apiKeyBoundProviderId = "";
    return;
  }

  apiKeyBoundProviderId = provider.id;
  apiKeyLabel.textContent = provider.optionalApiKey
    ? `${provider.label} API key (optional)`
    : `${provider.label} API key`;
  apiKeyInput.placeholder =
    provider.id === "openrouter"
      ? "sk-or-..."
      : provider.id === "anthropic"
        ? "sk-ant-..."
        : provider.optionalApiKey
          ? "Leave blank if not required"
          : "sk-...";
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

  updateOnDevicePanel();
}

/**
 * @param {string} providerId
 * @returns {boolean}
 */
function allowUnknownFor(providerId) {
  return providerId !== "ollama" && providerId !== ON_DEVICE_PROVIDER_ID;
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
    // Do not cache failures — a transient API/network error should retry on
    // the next provider switch or refresh, same as Ollama's "Check again".
    return {
      models: /** @type {Array<{ id: string, label?: string }>} */ ([]),
      error: response?.error?.message || "Failed to list models",
    };
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
    // Hide on-device entirely when Prompt API is missing/unavailable, unless it
    // is already the saved default (keep visible + disabled like Ollama down).
    if (
      provider.id === ON_DEVICE_PROVIDER_ID &&
      !isOnDeviceOffered() &&
      effectiveId !== ON_DEVICE_PROVIDER_ID
    ) {
      continue;
    }

    const option = document.createElement("option");
    option.value = provider.id;
    const ollamaDown = provider.id === "ollama" && !ollamaStatus.available;
    const onDeviceGone =
      provider.id === ON_DEVICE_PROVIDER_ID && !isOnDeviceOffered();
    // Keep the current selection choosable; block switching *to* Ollama when down
    // or on-device when the API is missing. downloadable stays selectable for Install.
    option.disabled =
      (ollamaDown || onDeviceGone) && effectiveId !== provider.id;
    if (onDeviceGone) {
      option.textContent = `${provider.label} (unavailable)`;
    } else if (
      provider.id === ON_DEVICE_PROVIDER_ID &&
      !isOnDeviceReady()
    ) {
      option.textContent = `${provider.label} (install required)`;
    } else if (ollamaDown) {
      option.textContent = `${provider.label} (unavailable)`;
    } else {
      option.textContent = provider.label;
    }
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
 * Show select for short catalogs; searchable input for OpenRouter or empty compat catalogs.
 * @param {string} providerId
 * @param {Array<{ id: string, label?: string }>} [models]
 */
function setDefaultModelControlMode(providerId, models) {
  const autosuggest = usesModelAutosuggest(providerId, models);
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
  if (providerId === ON_DEVICE_PROVIDER_ID) return ON_DEVICE_MODEL_ID;
  if (usesModelAutosuggest(providerId, defaultModels)) {
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
  setDefaultModelControlMode(providerId, models);

  if (usesModelAutosuggest(providerId, models)) {
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

  if (providerId === ON_DEVICE_PROVIDER_ID) {
    defaultModels = [
      { id: ON_DEVICE_MODEL_ID, label: "Browser-chosen on-device model" },
    ];
    populateDefaultModelControl(providerId, defaultModels, ON_DEVICE_MODEL_ID, {
      allowUnknown: false,
      disabled: true,
    });
    updateOnDevicePanel();
    return;
  }

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
    modelHint.textContent = providerId.startsWith("compat:")
      ? "Could not list models from /v1/models. Type a model id manually."
      : "No models available for this provider.";
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
  if (providerId === ON_DEVICE_PROVIDER_ID) return ON_DEVICE_MODEL_ID;
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
  if (!usesModelAutosuggest(providerId, defaultModels)) return;
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

/**
 * Start the on-device download + default save. Call from a user-gesture handler
 * (dialog Install) so LanguageModel.create keeps activation. Do not delegate to
 * the service worker / offscreen host — that path cannot carry the gesture.
 */
async function beginOnDeviceInstall() {
  if (onDeviceInstallController) return;
  if (typeof globalThis.LanguageModel?.create !== "function") {
    setStatus(
      "Prompt API is not available in this page, so Install cannot run with the required user gesture.",
      "err"
    );
    return;
  }
  onDeviceInstallController = new AbortController();
  onDeviceProgress.value = 0;
  updateOnDevicePanel();
  setStatus("Installing on-device model…", "");
  try {
    await installLanguageModel({
      LanguageModel: globalThis.LanguageModel,
      signal: onDeviceInstallController.signal,
      onProgress: (loaded) => {
        onDeviceProgress.hidden = false;
        onDeviceProgress.value = Math.min(1, Math.max(0, loaded));
      },
    });
    await refreshOnDeviceStatus();
    const nextId = populateProviderSelect(providerSelect, ON_DEVICE_PROVIDER_ID);
    modelBoundProviderId = nextId;
    modelDrafts[ON_DEVICE_PROVIDER_ID] = ON_DEVICE_MODEL_ID;
    updateProviderChrome(nextId);
    await refreshDefaultModels(nextId, preferredDefaultModel(nextId));
    // Persist only when the offscreen inference path is Ready — not merely
    // because in-page LanguageModel.create succeeded.
    if (!isOnDeviceReady()) {
      setStatus(
        onDeviceStatus.message ||
          "Model installed, but the on-device host is not ready. Reload the extension, then Save.",
        "err"
      );
      return;
    }
    await persistDefaultSettings(ON_DEVICE_PROVIDER_ID, ON_DEVICE_MODEL_ID);
    onDeviceProgress.value = 1;
    setStatus(
      "Success — on-device model installed and ready to use. Saved as your default.",
      "ok"
    );
  } catch (err) {
    if (
      onDeviceInstallController?.signal.aborted ||
      (err && /** @type {any} */ (err).code === "aborted")
    ) {
      setStatus("Install canceled.", "");
    } else {
      setStatus(
        err instanceof Error ? err.message : "Install failed",
        "err"
      );
    }
    await refreshOnDeviceStatus();
    updateOnDevicePanel();
  } finally {
    onDeviceInstallController = null;
    updateOnDevicePanel();
  }
}

onDeviceInstallButton.addEventListener("click", () => {
  if (onDeviceInstallController) return;
  onDeviceInstallDialog.returnValue = "";
  onDeviceInstallDialog.showModal();
});

document
  .getElementById("onDeviceInstallConfirm")
  .addEventListener("click", () => {
    // Same gesture as dialog Install — do not await the dialog close first.
    void beginOnDeviceInstall();
  });

onDeviceCancelButton.addEventListener("click", () => {
  onDeviceInstallController?.abort();
});

/**
 * Commit callbacks for in-progress OpenRouter origin model inputs.
 * Text <input> only fires `change` after blur; flushing on page hide covers
 * closing the Options tab while the field is still focused.
 * @type {Array<() => void>}
 */
let originModelCommitters = [];

function flushOriginModelEdits() {
  for (const commit of originModelCommitters) {
    commit();
  }
}

window.addEventListener("pagehide", flushOriginModelEdits);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOriginModelEdits();
});

async function renderOrigins() {
  const grants = await listAllowedOrigins();
  originModelCommitters = [];
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
      if (providerId === ON_DEVICE_PROVIDER_ID) return ON_DEVICE_MODEL_ID;
      if (usesModelAutosuggest(providerId, originModels)) {
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
      const autosuggest = usesModelAutosuggest(providerId, models);
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

      if (providerId === ON_DEVICE_PROVIDER_ID) {
        originModels = [
          { id: ON_DEVICE_MODEL_ID, label: "Browser-chosen on-device model" },
        ];
        populateOriginModelControl(providerId, originModels, ON_DEVICE_MODEL_ID, {
          allowUnknown: false,
          disabled: true,
        });
        if (!isOnDeviceOffered()) {
          modelStatus.textContent =
            "On-device AI is not available in this browser.";
          return false;
        }
        if (!isOnDeviceReady()) {
          modelStatus.textContent =
            "Install the on-device model above before using it for this site.";
          return false;
        }
        modelStatus.textContent = "Browser-chosen on-device model.";
        return true;
      }

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

    /** Last provider/model written for this row — skip no-op rewrites. */
    let persistedProviderId = grant.providerId;
    let persistedModel = typeof grant.model === "string" ? grant.model.trim() : "";

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
      if (providerId === persistedProviderId && model === persistedModel) {
        return true;
      }
      const ok = await setOriginProviderModel(grant.origin, {
        providerId,
        model,
      });
      if (ok) {
        persistedProviderId = providerId;
        persistedModel = model;
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

        // Prefer the provider default (e.g. openrouter/auto). OpenRouter uses an
        // autosuggest input that stays blank when selected is omitted, unlike
        // <select> which auto-picks the first catalog entry.
        const preferredModel =
          providerId === ON_DEVICE_PROVIDER_ID
            ? ON_DEVICE_MODEL_ID
            : providers.find((p) => p.id === providerId)?.defaultModel ||
              undefined;
        const applied = await loadOriginModels(providerId, preferredModel);
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
    // Autosuggest <input>: `change` alone waits for blur, so also commit on
    // blur and when the Options page is hidden (see flushOriginModelEdits).
    const commitOriginModelInput = () => {
      void persistGrant();
    };
    originModelInput.addEventListener("change", commitOriginModelInput);
    originModelInput.addEventListener("blur", commitOriginModelInput);
    originModelCommitters.push(() => {
      // Blur already commits when focus moves within the page; only flush here
      // when the field is still focused (e.g. Options tab closed mid-edit).
      if (document.activeElement !== originModelInput) return;
      commitOriginModelInput();
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
    if (
      provider.id === ON_DEVICE_PROVIDER_ID &&
      !isOnDeviceOffered() &&
      selectedId !== ON_DEVICE_PROVIDER_ID
    ) {
      continue;
    }

    const option = document.createElement("option");
    option.value = provider.id;
    const ollamaDown = provider.id === "ollama" && !ollamaStatus.available;
    const onDeviceGone =
      provider.id === ON_DEVICE_PROVIDER_ID && !isOnDeviceOffered();
    const onDeviceNeedsInstall =
      provider.id === ON_DEVICE_PROVIDER_ID &&
      isOnDeviceOffered() &&
      !isOnDeviceReady();
    // Allow keeping the current grant visible; block switching *to* unready providers.
    option.disabled =
      ((ollamaDown || onDeviceGone || onDeviceNeedsInstall) &&
        selectedId !== provider.id) ||
      false;
    if (onDeviceGone) {
      option.textContent = `${provider.label} (unavailable)`;
    } else if (onDeviceNeedsInstall) {
      option.textContent = `${provider.label} (install required)`;
      // Still allow selecting current grant; block switching *to* until installed.
      option.disabled = selectedId !== ON_DEVICE_PROVIDER_ID;
    } else if (ollamaDown) {
      option.textContent = `${provider.label} (unavailable)`;
    } else {
      option.textContent = provider.label;
    }
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

/**
 * @param {string} message
 * @param {"ok" | "err" | ""} [kind]
 */
function setCompatStatus(message, kind = "") {
  compatStatusEl.textContent = message;
  compatStatusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function resetCompatForm() {
  compatEditingId = "";
  compatNameInput.value = "";
  compatBaseUrlInput.value = "";
  compatApiKeyInput.value = "";
  compatSaveButton.textContent = "Add server";
  compatCancelButton.hidden = true;
}

function renderCompatEndpoints() {
  compatEndpointsEl.replaceChildren();
  const hasEndpoints = compatEndpoints.length > 0;
  compatEndpointsEl.hidden = !hasEndpoints;
  compatEndpointsEmpty.hidden = hasEndpoints;

  for (const endpoint of compatEndpoints) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "origin-meta";

    const title = document.createElement("strong");
    title.textContent = endpoint.name;
    const url = document.createElement("code");
    url.textContent = endpoint.baseUrl;
    meta.append(title, url);

    const actions = document.createElement("div");
    actions.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      compatEditingId = endpoint.id;
      compatNameInput.value = endpoint.name;
      compatBaseUrlInput.value = endpoint.baseUrl;
      compatApiKeyInput.value = apiKeyDrafts[endpoint.id] || "";
      compatSaveButton.textContent = "Save changes";
      compatCancelButton.hidden = false;
      setCompatStatus("");
      compatNameInput.focus();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const next = compatEndpoints.filter((e) => e.id !== endpoint.id);
      await saveCompatEndpoints(next);
      delete apiKeyDrafts[endpoint.id];
      await saveSettings({ apiKeys: { [endpoint.id]: "" } });
      modelCache.delete(endpoint.id);
      if (compatEditingId === endpoint.id) resetCompatForm();
      const settings = await getSettings();
      compatEndpoints = settings.compatEndpoints;
      await loadProviders();
      savedDefaultProviderId = settings.defaultProviderId;
      const nextProvider = populateProviderSelect(
        providerSelect,
        settings.defaultProviderId
      );
      modelBoundProviderId = nextProvider;
      updateProviderChrome(nextProvider);
      await refreshDefaultModels(
        nextProvider,
        preferredDefaultModel(nextProvider)
      );
      await renderOrigins();
      renderCompatEndpoints();
      setCompatStatus(`Removed ${endpoint.name}.`, "ok");
      setStatus(`Removed ${endpoint.name}.`, "ok");
    });

    actions.append(editBtn, removeBtn);
    li.append(meta, actions);
    compatEndpointsEl.append(li);
  }
}

compatCancelButton.addEventListener("click", () => {
  resetCompatForm();
  setCompatStatus("");
});

compatSaveButton.addEventListener("click", async () => {
  compatSaveButton.disabled = true;
  try {
    const name = compatNameInput.value.trim();
    const baseUrl = normalizeCompatBaseUrl(compatBaseUrlInput.value);
    if (!name) {
      setCompatStatus("Enter a name for this server.", "err");
      return;
    }
    if (!baseUrl) {
      setCompatStatus(
        "Enter a valid http(s) URL (e.g. http://127.0.0.1:1234).",
        "err"
      );
      return;
    }

    const granted = await requestHostPermissionForBaseUrl(baseUrl);
    if (!granted) {
      setCompatStatus(
        "Host permission was not granted. Chrome must allow access to this origin before the endpoint can be saved.",
        "err"
      );
      return;
    }

    try {
      await ensureLoopbackOriginBypassForBaseUrl(baseUrl);
    } catch (err) {
      console.warn("Failed to install loopback Origin bypass", err);
    }

    const id = compatEditingId || `compat:${crypto.randomUUID()}`;
    const next = compatEndpoints.filter((e) => e.id !== id);
    next.push({ id, name, baseUrl });
    await saveCompatEndpoints(next);

    const key = compatApiKeyInput.value.trim();
    apiKeyDrafts[id] = key;
    await saveSettings({ apiKeys: { [id]: key } });

    modelCache.delete(id);
    const settings = await getSettings();
    compatEndpoints = settings.compatEndpoints;
    await loadProviders();
    renderCompatEndpoints();
    resetCompatForm();

    const currentProvider = populateProviderSelect(
      providerSelect,
      providerSelect.value || settings.defaultProviderId
    );
    modelBoundProviderId = currentProvider;
    updateProviderChrome(currentProvider);
    await refreshDefaultModels(
      currentProvider,
      preferredDefaultModel(currentProvider)
    );
    await renderOrigins();
    setCompatStatus(`Saved ${name}.`, "ok");
    setStatus(`Saved OpenAI-compatible server ${name}.`, "ok");
  } catch (err) {
    setCompatStatus(
      err instanceof Error ? err.message : "Failed to save server",
      "err"
    );
  } finally {
    compatSaveButton.disabled = false;
  }
});

async function load() {
  await loadProviders();
  await Promise.all([refreshOllamaStatus(), refreshOnDeviceStatus()]);
  const settings = await getSettings();
  compatEndpoints = settings.compatEndpoints;
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
  if (settings.defaultProviderId === ON_DEVICE_PROVIDER_ID) {
    modelDrafts[ON_DEVICE_PROVIDER_ID] = ON_DEVICE_MODEL_ID;
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
  renderCompatEndpoints();
  await renderOrigins();
  await renderBlocked();
}

/**
 * Persist default provider + model + API key drafts (shared by Save and Install).
 * @param {string} providerId
 * @param {string} model
 */
async function persistDefaultSettings(providerId, model) {
  syncApiKeyDraftFromInput();
  syncModelDraftFromControl();
  modelDrafts[providerId] = model;

  /** @type {Record<string, string>} */
  const apiKeys = {};
  for (const provider of providers) {
    if (!provider.requiresApiKey && !provider.optionalApiKey) continue;
    apiKeys[provider.id] = apiKeyDrafts[provider.id] || "";
  }

  const previousSettings = await getSettings();
  let refreshModelsAfterKeyChange = false;
  for (const provider of providers) {
    if (!provider.requiresApiKey && !provider.optionalApiKey) continue;
    const prev = (previousSettings.apiKeys[provider.id] || "").trim();
    const next = (apiKeys[provider.id] || "").trim();
    if (prev === next) continue;
    modelCache.delete(provider.id);
    if (provider.id === providerId) refreshModelsAfterKeyChange = true;
  }

  await saveSettings({
    apiKeys,
    defaultProviderId: providerId,
    defaultModel: model,
    defaultModels: modelDrafts,
  });
  savedDefaultProviderId = providerId;
  if (refreshModelsAfterKeyChange) {
    await refreshDefaultModels(providerId, model);
  }
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
    if (providerId === ON_DEVICE_PROVIDER_ID && !isOnDeviceReady()) {
      setStatus(
        "Install the on-device model before saving it as the default provider.",
        "err"
      );
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

    await persistDefaultSettings(providerId, model);
    setStatus("Saved.", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to save", "err");
  } finally {
    saveButton.disabled = false;
  }
});

void load();
