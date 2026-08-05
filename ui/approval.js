import {
  isModelValid,
  populateModelInput,
  populateModelSelect,
  usesModelAutosuggest,
} from "./model-input.js";

const params = new URLSearchParams(location.search);
const requestId = params.get("requestId");

const originEl = document.getElementById("origin");
const providerSelect = document.getElementById("provider");
const ollamaHint = document.getElementById("ollamaHint");
const modelSelect = document.getElementById("modelSelect");
const modelInputRow = document.getElementById("modelInputRow");
const modelInput = document.getElementById("modelInput");
const clearModelButton = document.getElementById("clearModel");
const modelList = document.getElementById("modelList");
const modelHint = document.getElementById("modelHint");
const previewEl = document.getElementById("preview");
const errorEl = document.getElementById("error");
const rememberInput = document.getElementById("remember");
const rememberHint = document.getElementById("rememberHint");
const allowBtn = document.getElementById("allow");
const denyBtn = document.getElementById("deny");

/** @type {Array<{ id: string, label: string, defaultModel: string }>} */
let providers = [];

/** Whether the current provider has a usable model selection. */
let modelsReady = false;

/** Models currently backing the model control (for validation). */
/** @type {Array<{ id: string, label?: string }>} */
let currentModels = [];

/** Bumped on each model load so a slower earlier fetch cannot repaint. */
let modelsLoadId = 0;

// Keep Allow disabled until loadModelsForProvider finishes (HTML also starts disabled).
allowBtn.disabled = true;

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

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
  allowBtn.disabled = true;
  denyBtn.disabled = true;
  rememberInput.disabled = true;
}

function setModelHint(message) {
  if (!message) {
    modelHint.hidden = true;
    modelHint.textContent = "";
    return;
  }
  modelHint.hidden = false;
  modelHint.textContent = message;
}

function updateOllamaHint(_providerId) {
  if (!ollamaStatus.available) {
    ollamaHint.hidden = false;
    ollamaHint.textContent = ollamaStatus.message;
    return;
  }
  ollamaHint.hidden = true;
  ollamaHint.textContent = "";
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
 */
function setModelControlMode(providerId) {
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
function readModelValue(providerId) {
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
function populateModelControl(providerId, models, selected, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false;
  const disabled = Boolean(opts.disabled);
  setModelControlMode(providerId);

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

function updateAllowEnabled() {
  if (errorEl.hidden === false && errorEl.textContent) {
    // Hard page error already disables controls.
    return;
  }
  const providerId = providerSelect.value;
  const valid = isModelValid(readModelValue(providerId), currentModels, {
    allowUnknown: allowUnknownFor(providerId),
  });
  allowBtn.disabled = !modelsReady || !valid;
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
        "Ollama is unavailable at http://localhost:11434, so this option is disabled. Install and start Ollama (and pull a model) to enable it.",
    };
    return ollamaStatus;
  }

  const models = normalizeModels(response.models);
  if (models.length === 0) {
    ollamaStatus = {
      available: false,
      models: [],
      message:
        "Ollama is running but has no models installed, so this option is disabled. Run ollama pull gemma4, then try again.",
    };
    return ollamaStatus;
  }

  ollamaStatus = {
    available: true,
    models,
    message: "Using local Ollama at http://localhost:11434.",
  };
  return ollamaStatus;
}

/**
 * Map a stored/preferred provider id onto one that exists in the select and is
 * currently choosable. Unknown ids (and unavailable Ollama) must not be
 * returned as-is: the browser would select the first option while callers keep
 * the stale id, and loadModelsForProvider would then bail on the mismatch.
 * @param {string} selectedId
 * @returns {string}
 */
function resolveSelectableProviderId(selectedId) {
  /** @param {{ id: string }} p */
  const isChoosable = (p) => p.id !== "ollama" || ollamaStatus.available;
  const fallback =
    providers.find((p) => p.id === "openai" && isChoosable(p))?.id ||
    providers.find(isChoosable)?.id ||
    "";
  const known = providers.some((p) => p.id === selectedId);
  let effectiveId = known ? selectedId : fallback;
  if (!providers.some((p) => p.id === effectiveId && isChoosable(p))) {
    effectiveId = fallback;
  }
  return effectiveId;
}

/**
 * @param {string} selectedId
 * @returns {string}
 */
function fillProviders(selectedId) {
  providerSelect.replaceChildren();
  const effectiveId = resolveSelectableProviderId(selectedId);

  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    const unavailable = provider.id === "ollama" && !ollamaStatus.available;
    option.disabled = unavailable;
    option.textContent = unavailable
      ? `${provider.label} (unavailable)`
      : provider.label;
    if (provider.id === effectiveId) option.selected = true;
    providerSelect.append(option);
  }
  return effectiveId;
}

/**
 * @param {string} providerId
 * @param {string | undefined} preferredModel
 */
async function loadModelsForProvider(providerId, preferredModel) {
  const loadId = ++modelsLoadId;
  modelsReady = false;
  currentModels = [];
  updateAllowEnabled();
  updateOllamaHint(providerId);
  setModelHint("Loading models…");
  populateModelControl(providerId, [], preferredModel, {
    allowUnknown: true,
    disabled: true,
  });

  /**
   * @returns {boolean}
   */
  function isCurrentLoad() {
    return loadId === modelsLoadId && providerSelect.value === providerId;
  }

  if (providerId === "ollama") {
    if (!isCurrentLoad()) return;
    if (!ollamaStatus.available) {
      setModelHint("");
      currentModels = [];
      populateModelControl(providerId, [], undefined, { disabled: true });
      modelsReady = false;
      updateAllowEnabled();
      return;
    }
    currentModels = ollamaStatus.models;
    populateModelControl(providerId, ollamaStatus.models, preferredModel, {
      allowUnknown: false,
      disabled: ollamaStatus.models.length === 0,
    });
    setModelHint("");
    modelsReady = ollamaStatus.models.length > 0;
    updateAllowEnabled();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "list-models",
    providerId,
  });

  // Ignore stale responses after the user switches providers mid-flight.
  if (!isCurrentLoad()) return;

  if (!response?.ok) {
    setModelHint(response?.error?.message || "Failed to list models.");
    currentModels = [];
    // OpenAI / OpenRouter still accept free-typed slugs when the catalog
    // request fails — same as an empty successful catalog.
    const allowUnknown = allowUnknownFor(providerId);
    populateModelControl(providerId, [], preferredModel, {
      allowUnknown,
      disabled: !allowUnknown,
    });
    modelsReady = allowUnknown;
    updateAllowEnabled();
    return;
  }

  const models = normalizeModels(response.models);
  currentModels = models;
  const allowUnknown = allowUnknownFor(providerId);
  populateModelControl(providerId, models, preferredModel, {
    allowUnknown,
    disabled: models.length === 0 && !allowUnknown,
  });

  if (models.length === 0) {
    setModelHint("No models available for this provider.");
    modelsReady = allowUnknown;
  } else {
    setModelHint("");
    modelsReady = true;
  }
  updateAllowEnabled();
}

const PREVIEW_TRUNCATE = 280;

/**
 * @param {string} content
 * @param {{ truncate?: boolean }} [opts]
 */
function formatPreviewContent(content, { truncate = true } = {}) {
  if (truncate && content.length > PREVIEW_TRUNCATE) {
    return `${content.slice(0, PREVIEW_TRUNCATE)}…`;
  }
  return content;
}

/**
 * @param {{ role: string, content: string }} message
 * @param {{ truncate?: boolean }} [opts]
 */
function createPreviewMessage(message, opts) {
  const el = document.createElement("div");
  el.className = "preview-msg";

  const role = document.createElement("div");
  role.className = "preview-role";
  role.textContent = message.role;

  const body = document.createElement("div");
  body.className = "preview-content";
  body.textContent = formatPreviewContent(message.content, opts);

  el.append(role, body);
  return el;
}

/**
 * Collapse system messages by default so the preview highlights the user turn.
 * @param {Array<{ role: string, content: string }>} messages
 */
function renderPreview(messages) {
  previewEl.replaceChildren();

  const context = [];
  const visible = [];
  for (const message of messages) {
    if (message.role === "system") {
      context.push(message);
    } else {
      visible.push(message);
    }
  }

  // Only collapse when there is something else to show; otherwise leave system open.
  const collapseContext = context.length > 0 && visible.length > 0;

  if (context.length === 0) {
    for (const message of visible) {
      previewEl.append(createPreviewMessage(message));
    }
    return;
  }

  if (!collapseContext) {
    for (const message of context) {
      previewEl.append(createPreviewMessage(message, { truncate: false }));
    }
    return;
  }

  // Put the disclosure above the user turn so it stays visible in the
  // constrained approval popup without scrolling past the message.
  const details = document.createElement("details");
  details.className = "preview-context";

  const summary = document.createElement("summary");
  const n = context.length;
  summary.textContent = `Context (${n} hidden part${n === 1 ? "" : "s"}) — expand to see system instructions`;

  const body = document.createElement("div");
  body.className = "preview-context-body";
  for (const message of context) {
    body.append(createPreviewMessage(message, { truncate: false }));
  }

  details.append(summary, body);
  previewEl.append(details);

  for (const message of visible) {
    previewEl.append(createPreviewMessage(message));
  }
}

function updateRememberHint() {
  rememberHint.textContent = rememberInput.checked
    ? "Allow always, or never allow this site again."
    : "Allow once, or deny only this request.";
}

/**
 * @param {"allow" | "deny"} action
 */
async function decide(action) {
  // Read before disabling — some browsers can odd-path disabled controls.
  const remember = Boolean(rememberInput.checked);
  const providerId = providerSelect.value;
  const model = readModelValue(providerId);

  if (action === "allow") {
    if (
      !isModelValid(model, currentModels, {
        allowUnknown: allowUnknownFor(providerId),
      })
    ) {
      setModelHint("Choose a valid model before allowing.");
      updateAllowEnabled();
      return;
    }
  }

  allowBtn.disabled = true;
  denyBtn.disabled = true;
  rememberInput.disabled = true;

  /** @type {"allow_once" | "always" | "deny" | "never"} */
  const decision =
    action === "allow"
      ? remember
        ? "always"
        : "allow_once"
      : remember
        ? "never"
        : "deny";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "resolve-approval",
      requestId,
      decision,
      providerId,
      model,
    });
    if (!response?.ok) {
      showError("This permission request is no longer active.");
      return;
    }
    window.close();
  } catch (err) {
    showError(err instanceof Error ? err.message : "Failed to send decision");
  }
}

async function load() {
  if (!requestId) {
    showError("Missing request id.");
    return;
  }

  const providersResponse = await chrome.runtime.sendMessage({
    type: "list-providers",
  });
  providers = Array.isArray(providersResponse?.providers)
    ? providersResponse.providers
    : [];
  if (providers.length === 0) {
    showError("No inference providers are available.");
    return;
  }

  await refreshOllamaStatus();

  const response = await chrome.runtime.sendMessage({
    type: "get-approval",
    requestId,
  });
  const request = response?.request;
  if (!request) {
    showError("This permission request expired or was cancelled.");
    return;
  }

  originEl.textContent = request.origin;
  const requestedId =
    typeof request.providerId === "string" &&
    providers.some((p) => p.id === request.providerId)
      ? request.providerId
      : providers[0].id;
  const providerId = fillProviders(requestedId);
  renderPreview(request.messages || []);
  updateRememberHint();
  // Prefer the pending request's model (global default, last-used, or preferred)
  // even when it is a free-typed slug that fails the stricter plausibility check.
  const requestModel =
    typeof request.model === "string" && request.model.trim()
      ? request.model.trim()
      : "";
  const preferredModel =
    providerId === requestedId && requestModel
      ? requestModel
      : providers.find((p) => p.id === providerId)?.defaultModel || undefined;
  await loadModelsForProvider(providerId, preferredModel);
}

providerSelect.addEventListener("change", () => {
  const provider = providers.find((p) => p.id === providerSelect.value);
  void loadModelsForProvider(
    providerSelect.value,
    provider?.defaultModel || undefined
  );
});

modelSelect.addEventListener("change", () => {
  updateAllowEnabled();
});
modelInput.addEventListener("input", () => {
  updateClearModelButton();
  updateAllowEnabled();
});
clearModelButton.addEventListener("click", () => {
  modelInput.value = "";
  updateClearModelButton();
  updateAllowEnabled();
  modelInput.focus();
});

rememberInput.addEventListener("change", updateRememberHint);
allowBtn.addEventListener("click", () => decide("allow"));
denyBtn.addEventListener("click", () => decide("deny"));

void load();
