/**
 * Pure decision rules for approval-wait port soft-disconnect / rebind.
 * Chrome Port wiring stays in the service worker.
 */

/**
 * @typedef {"awaiting_permission" | "streaming"} StreamPhase
 */

/**
 * Minimal stream entry shape used by rebind predicates.
 * @typedef {{
 *   port: unknown,
 *   tabId?: number,
 *   phase: StreamPhase,
 *   announced?: boolean,
 * }} StreamRebindEntry
 */

/** @typedef {"ignore" | "soft_hold" | "abort"} PortDisconnectDecision */

/**
 * Whether a started-ack may mark the stream as announced for soft-disconnect.
 * Requires awaiting_permission and the same port that owns the stream.
 * @param {StreamRebindEntry | undefined | null} entry
 * @param {unknown} port
 * @returns {boolean}
 */
export function canAcceptStartedAck(entry, port) {
  return Boolean(
    entry && entry.phase === "awaiting_permission" && entry.port === port
  );
}

/**
 * Whether a rebind from senderTabId may take over an awaiting stream.
 * Only the originating tab may rebind — streamId alone must not let another
 * tab take over. Both tab ids must be non-null and equal.
 * @param {StreamRebindEntry | undefined | null} entry
 * @param {number | undefined | null} senderTabId
 * @returns {boolean}
 */
export function canAcceptRebind(entry, senderTabId) {
  if (!entry || entry.phase !== "awaiting_permission") return false;
  return (
    entry.tabId != null && senderTabId != null && senderTabId === entry.tabId
  );
}

/**
 * Decide what to do when an inference port disconnects during a bound stream.
 * - ignore: superseded port after a successful rebind (must not flip soft-hold)
 * - soft_hold: awaiting permission and announced — content script may rebind
 * - abort: otherwise cancel the stream
 * @param {StreamRebindEntry | undefined | null} entry
 * @param {unknown} port
 * @returns {PortDisconnectDecision}
 */
export function decidePortDisconnect(entry, port) {
  // Ignore disconnect from a superseded port after a successful rebind —
  // otherwise portDisconnected flips true again and Approve waits forever.
  if (entry && entry.port !== port) return "ignore";
  // While the approval popup is open, a brief port drop must not cancel the
  // pending decision — the content script may rebind, and a late Approve
  // should still resolve. Only after the content script acks "started"
  // (announced); before that it has no streamId and cannot rebind.
  if (entry?.phase === "awaiting_permission" && entry.announced) {
    return "soft_hold";
  }
  return "abort";
}
