/**
 * Ollama rejects chrome-extension:// Origin headers with HTTP 403.
 * Strip Origin/Referer on local Ollama requests so chat works without
 * requiring users to set OLLAMA_ORIGINS.
 */

// Also remove the old automatic 127.0.0.1 rule. Custom loopback endpoints
// receive their own rule only when the user saves them in Options.
const OLLAMA_ORIGIN_BYPASS_RULE_IDS = Object.freeze([11434, 11435]);

/** @type {Promise<void> | null} */
let installPromise = null;

/**
 * @returns {void}
 */
export function resetOllamaOriginBypassMemoForTests() {
  installPromise = null;
}

/**
 * Install (or re-assert) DNR rules that strip Origin/Referer for local Ollama.
 * Concurrent callers share one in-flight install so early chat/list-models
 * requests wait for the rules before fetching. Failed installs clear the
 * memo so a later call can retry.
 *
 * @returns {Promise<void>}
 */
export function ensureOllamaOriginBypass() {
  if (!installPromise) {
    installPromise = installOllamaOriginBypass().catch((err) => {
      console.warn("Failed to install Ollama Origin bypass rule", err);
      installPromise = null;
      throw err;
    });
  }
  return installPromise;
}

/**
 * @returns {Promise<void>}
 */
async function installOllamaOriginBypass() {
  if (
    typeof chrome === "undefined" ||
    !chrome.declarativeNetRequest?.updateDynamicRules
  ) {
    return;
  }

  /** @type {chrome.declarativeNetRequest.Rule[]} */
  const rules = [
    {
      id: 11434,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "remove" },
          { header: "referer", operation: "remove" },
        ],
      },
      condition: {
        urlFilter: "||localhost:11434^",
        resourceTypes: ["xmlhttprequest", "other"],
      },
    },
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [...OLLAMA_ORIGIN_BYPASS_RULE_IDS],
    addRules: rules,
  });
}
