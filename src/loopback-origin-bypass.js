/**
 * Strip Origin/Referer on loopback inference servers that reject
 * chrome-extension:// origins (LM Studio, llama.cpp, local proxies, etc.).
 * Never use this for remote HTTPS APIs.
 */

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string" || !hostname) return false;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Deterministic DNR rule id for a loopback host:port.
 * Avoids colliding with Ollama's reserved 11434 / 11435.
 * @param {string} hostname
 * @param {number} port
 * @returns {number}
 */
export function loopbackBypassRuleId(hostname, port) {
  const key = `${hostname.toLowerCase()}:${port}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Positive id in 20000..59999.
  let id = 20000 + (Math.abs(hash) % 40000);
  if (id === 11434 || id === 11435) id = 20001;
  return id;
}

/**
 * @param {string} hostname
 * @param {number} port
 * @returns {string}
 */
function urlFilterFor(hostname, port) {
  const host = hostname.replace(/^\[|\]$/g, "");
  // DNR matches the canonical bracketed IPv6 host ([::1]:port), not bare ::1.
  const authority = host.includes(":") ? `[${host}]` : host;
  return `||${authority}:${port}^`;
}

/**
 * Install (or re-assert) a DNR rule that strips Origin/Referer for one
 * loopback host:port. No-ops for non-loopback hosts.
 *
 * @param {string} hostname
 * @param {number} port
 * @returns {Promise<void>}
 */
export async function ensureLoopbackOriginBypass(hostname, port) {
  if (!isLoopbackHostname(hostname)) return;
  if (
    typeof chrome === "undefined" ||
    !chrome.declarativeNetRequest?.updateDynamicRules
  ) {
    return;
  }

  const portNum = Number(port);
  if (!Number.isFinite(portNum) || portNum <= 0) return;

  const ruleId = loopbackBypassRuleId(hostname, portNum);
  /** @type {chrome.declarativeNetRequest.Rule} */
  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "origin", operation: "remove" },
        { header: "referer", operation: "remove" },
      ],
    },
    condition: {
      urlFilter: urlFilterFor(hostname, portNum),
      resourceTypes: ["xmlhttprequest", "other"],
    },
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [rule],
  });
}

/**
 * Ensure Origin/Referer stripping for a normalized OpenAI-compat base URL when
 * it points at loopback.
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
export async function ensureLoopbackOriginBypassForBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (!isLoopbackHostname(url.hostname)) return;
  const port =
    url.port ||
    (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  const portNum = Number(port);
  if (!Number.isFinite(portNum) || portNum <= 0) return;
  await ensureLoopbackOriginBypass(url.hostname, portNum);
}
