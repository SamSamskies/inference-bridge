/**
 * Shared model picker helpers for Options and the approval dialog.
 *
 * Short catalogs (OpenAI curated list, local Ollama tags, discovered
 * OpenAI-compatible models) use a <select>. Large live catalogs (OpenRouter)
 * use <input list> + <datalist> so users can type to filter by slug or label.
 * Compat endpoints fall back to free-text only when /v1/models returns nothing.
 */

/**
 * @typedef {{ id: string, label?: string }} ModelInfo
 */

/**
 * @param {string} providerId
 * @param {ModelInfo[] | undefined} [models] Catalog used for compat:* mode
 * @returns {boolean}
 */
export function usesModelAutosuggest(providerId, models) {
  if (providerId === "openrouter") return true;
  // Named OpenAI-compatible servers: select when models listed; free-text when
  // listing failed/empty so users can still type a model id.
  if (typeof providerId === "string" && providerId.startsWith("compat:")) {
    return !Array.isArray(models) || models.length === 0;
  }
  return false;
}

/**
 * Whether a model value is acceptable for the current provider.
 * Blank is always rejected. When allowUnknown is false (Ollama), the value
 * must match a listed id exactly. When true (OpenAI / OpenRouter), any
 * non-blank value is accepted so curated catalogs and live catalogs that go
 * stale do not block a known-good slug.
 *
 * @param {string} value
 * @param {ModelInfo[]} models
 * @param {{ allowUnknown?: boolean }} [opts]
 * @returns {boolean}
 */
export function isModelValid(value, models, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return false;
  if (models.some((m) => m.id === trimmed)) return true;
  return allowUnknown;
}

/**
 * Option text for a model: prefer human label, fall back to id.
 * @param {ModelInfo} model
 * @returns {string}
 */
function modelOptionText(model) {
  if (model.label && model.label !== model.id) {
    return `${model.label} (${model.id})`;
  }
  return model.id;
}

/**
 * Populate a <select> with ModelInfo entries.
 * @param {HTMLSelectElement} select
 * @param {ModelInfo[]} models
 * @param {string | undefined} selected
 * @param {{ allowUnknown?: boolean }} [opts]
 */
export function populateModelSelect(select, models, selected, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false;
  select.replaceChildren();

  const seen = new Set();
  for (const model of models) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = modelOptionText(model);
    select.append(option);
  }

  const trimmed = typeof selected === "string" ? selected.trim() : "";
  if (trimmed && (seen.has(trimmed) || allowUnknown)) {
    if (!seen.has(trimmed)) {
      const option = document.createElement("option");
      option.value = trimmed;
      option.textContent = trimmed;
      select.append(option);
      seen.add(trimmed);
    }
  }

  if (trimmed && seen.has(trimmed)) {
    select.value = trimmed;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

/**
 * Populate an input + datalist pair with ModelInfo entries.
 * @param {HTMLInputElement} input
 * @param {HTMLDataListElement} datalist
 * @param {ModelInfo[]} models
 * @param {string | undefined} selected
 * @param {{ allowUnknown?: boolean }} [opts]
 */
export function populateModelInput(input, datalist, models, selected, opts = {}) {
  const allowUnknown = opts.allowUnknown !== false;
  datalist.replaceChildren();

  const seen = new Set();
  for (const model of models) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const option = document.createElement("option");
    option.value = model.id;
    if (model.label && model.label !== model.id) {
      option.label = model.label;
    }
    datalist.append(option);
  }

  const trimmed = typeof selected === "string" ? selected.trim() : "";
  if (trimmed) {
    const known = seen.has(trimmed);
    if (known || allowUnknown) {
      // Keep a saved unknown model visible (OpenRouter free-typed slug, etc.).
      if (!known) {
        const option = document.createElement("option");
        option.value = trimmed;
        datalist.append(option);
      }
      input.value = trimmed;
      return;
    }
  }

  // No usable selection — clear so callers can detect emptiness.
  input.value = "";
}
