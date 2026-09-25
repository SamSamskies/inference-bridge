/**
 * Optional host-permission helpers for user-configured OpenAI-compatible
 * endpoints. Firefox match patterns are host-scoped because ports are invalid
 * there; fetch URLs still retain and enforce the configured port.
 */

import { isLoopbackHostname } from "./loopback-origin-bypass.js";
import { isFirefoxBuild } from "./runtime-browser.js";

const FIREFOX_BUILTIN_HOSTS = Object.freeze({
  openai: "https://api.openai.com/*",
  anthropic: "https://api.anthropic.com/*",
  openrouter: "https://openrouter.ai/*",
  ollama: "http://localhost/*",
  "ollama-web-search": "https://ollama.com/*",
});

/** Firefox users can revoke install-time host grants in about:addons. */
export async function hasBuiltInHostPermission(providerId) {
  if (!isFirefoxBuild()) return true;
  const pattern = FIREFOX_BUILTIN_HOSTS[providerId];
  if (!pattern) return true;
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

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
 * @param {{ firefox?: boolean }} [options]
 * @returns {string | null}
 */
export function originPatternFromBaseUrl(baseUrl, options = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const firefox = options.firefox ?? isFirefoxBuild();
  if (firefox && url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return null;
  }
  return `${url.protocol}//${firefox ? url.hostname : url.host}/*`;
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
