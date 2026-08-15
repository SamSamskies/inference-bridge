/**
 * Ensure an offscreen document owns LanguageModel (Prompt API is not reliable in
 * service workers / web workers). SW and provider code talk to it via messaging.
 */

export const PROMPT_API_OFFSCREEN_PATH = "offscreen/prompt-api.html";

/** @type {Promise<void> | null} */
let creating = null;

/**
 * @returns {Promise<boolean>}
 */
async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(PROMPT_API_OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  const matched = await clients.matchAll();
  return matched.some((client) => client.url === offscreenUrl);
}

/**
 * Create the Prompt API offscreen document if needed.
 * @returns {Promise<void>}
 */
export async function ensurePromptApiOffscreen() {
  if (await hasOffscreenDocument()) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: PROMPT_API_OFFSCREEN_PATH,
    // LanguageModel needs a document context; no dedicated AI reason exists yet.
    reasons: ["DOM_SCRAPING"],
    justification:
      "Host the browser Prompt API (LanguageModel) for on-device inference; not available in the service worker.",
  });

  try {
    await creating;
  } finally {
    creating = null;
  }
}

/**
 * @param {object} message
 * @returns {Promise<any>}
 */
export async function sendPromptApiOffscreenMessage(message) {
  await ensurePromptApiOffscreen();
  return chrome.runtime.sendMessage({
    ...message,
    target: "prompt-api-offscreen",
  });
}
