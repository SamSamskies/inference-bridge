/** sessionStorage key for the open Safari/Chrome approval document. */
export const APPROVAL_REQUEST_ID_KEY = "ipa-approval-requestId";

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
