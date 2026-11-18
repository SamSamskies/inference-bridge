/** sessionStorage key for the open Safari/Chrome approval document. */
export const APPROVAL_REQUEST_ID_KEY = "ipa-approval-requestId";

/** Short poll window while Safari assigns approval tabId after tabs.create. */
export const APPROVAL_FETCH_ATTEMPTS = 10;
export const APPROVAL_FETCH_DELAY_MS = 40;

/**
 * Prefer ?requestId= from the URL (and remember it). Fall back to sessionStorage
 * so a WebKit reload that drops the query can still talk to the pending request.
 * @param {string} search location.search (may include leading "?")
 * @param {Pick<Storage, "getItem" | "setItem"> | null | undefined} [storage]
 * @returns {string | null}
 */
export function resolveApprovalRequestId(search, storage = globalThis.sessionStorage) {
  const fromQuery = new URLSearchParams(search).get("requestId");
  if (typeof fromQuery === "string" && fromQuery.trim()) {
    const id = fromQuery.trim();
    try {
      storage?.setItem?.(APPROVAL_REQUEST_ID_KEY, id);
    } catch {
      // Private mode / quota — still use the query value.
    }
    return id;
  }
  try {
    const stored = storage?.getItem?.(APPROVAL_REQUEST_ID_KEY);
    if (typeof stored === "string" && stored.trim()) return stored.trim();
  } catch {
    // ignore unavailable storage
  }
  return null;
}

/**
 * Fetch the pending approval, retrying briefly so Safari first paint can wait
 * until the worker binds the approval tabId.
 * @param {string} requestId
 * @param {(message: { type: string, requestId: string }) => Promise<{ request?: unknown }>} sendMessage
 * @param {{
 *   attempts?: number,
 *   delayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<unknown | null>}
 */
export async function fetchPendingApprovalRequest(requestId, sendMessage, options = {}) {
  const attempts = options.attempts ?? APPROVAL_FETCH_ATTEMPTS;
  const delayMs = options.delayMs ?? APPROVAL_FETCH_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i++) {
    const response = await sendMessage({ type: "get-approval", requestId });
    if (response?.request) return response.request;
    if (i + 1 < attempts) await sleep(delayMs);
  }
  return null;
}
