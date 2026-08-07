/**
 * Optional host-permission helpers for user-configured OpenAI-compatible
 * endpoints (Option A: request exact origin on save).
 */

/**
 * Normalize a user-entered OpenAI-compatible base URL.
 * Trims, requires http(s), strips a trailing slash, and ensures the path ends
 * at a `/v1` segment. Pasted endpoint URLs like `/v1/models` or
 * `/v1/chat/completions` are truncated to the `/v1` base; origins without `/v1`
 * get `/v1` appended.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeCompatBaseUrl(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  let path = url.pathname.replace(/\/+$/, "");
  const v1Match = path.match(/^(.*?\/v1)(?:\/|$)/);
  if (v1Match) {
    path = v1Match[1];
  } else if (!path || path === "") {
    path = "/v1";
  } else {
    path = `${path}/v1`;
  }

  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Match pattern for chrome.permissions.request / contains.
 * @param {string} baseUrl
 * @returns {string | null}
 */
export function originPatternFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}/*`;
}

/**
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function hasHostPermissionForBaseUrl(baseUrl) {
  const pattern = originPatternFromBaseUrl(baseUrl);
  if (!pattern) return false;
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) {
    return false;
  }
  return chrome.permissions.contains({ origins: [pattern] });
}

/**
 * Must be called from a user gesture (e.g. Options save click).
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function requestHostPermissionForBaseUrl(baseUrl) {
  const pattern = originPatternFromBaseUrl(baseUrl);
  if (!pattern) return false;
  if (typeof chrome === "undefined" || !chrome.permissions?.request) {
    return false;
  }
  return chrome.permissions.request({ origins: [pattern] });
}
