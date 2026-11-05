/** Explicit, extension-only transfer from the official PPQ compat endpoint. */
export function isPPQCompatEndpoint(endpoint) {
  if (typeof endpoint?.id !== "string" || !endpoint.id.startsWith("compat:")) return false;
  try {
    const url = new URL(endpoint.baseUrl);
    return url.origin === "https://api.ppq.ai" &&
      /^\/v1\/?$/.test(url.pathname) && !url.username && !url.password &&
      !url.search && !url.hash;
  } catch { return false; }
}

export function ppqTransferModel(model) {
  const parts = (typeof model === "string" && model.trim() ? model.trim() : "auto").split(":");
  return parts.filter((part, index) => index === 0 || part.toLowerCase() !== "online").join(":") || "auto";
}

/** Contains keys for optimistic comparison inside extension contexts only.
 * UI must display presence, never values; do not log or send this to a page. */
export function ppqTransferPreview(settings, endpointId) {
  const endpoint = settings.compatEndpoints.find((entry) => entry.id === endpointId);
  if (!isPPQCompatEndpoint(endpoint)) {
    throw new Error("This server is not the official PayPerQ API endpoint.");
  }
  const source = {
    ...endpoint,
    apiKey: settings.apiKeys[endpointId] || "",
    model: settings.defaultModels[endpointId] || "",
  };
  const target = {
    apiKey: settings.apiKeys.ppq || "",
    model: settings.defaultModels.ppq || "",
  };
  const model = ppqTransferModel(source.model);
  return {
    source, target, model,
    defaultProviderId: settings.defaultProviderId,
    removedOnlineSuffix: Boolean(source.model && source.model !== model),
    hasConflict: Boolean(
      (target.apiKey && target.apiKey !== source.apiKey) ||
      ((target.apiKey || target.model !== "auto") && target.model && target.model !== model)
    ),
  };
}
