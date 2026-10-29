/** Last-used routes only prefill prompts; they never authorize requests. */
export const MAX_LAST_USED_ORIGINS = 500;

/**
 * Bound each cache by origin count. Operation origins are ranked by their most
 * recent operation, keeping the (at most three) routes together. No clock-based
 * expiry: infrequent users keep their choices until the cache needs space.
 * @param {Record<string, any>} entries
 * @param {boolean} [operations]
 * @returns {boolean} Whether entries were removed.
 */
export function pruneLastUsed(entries, operations = false) {
  const origins = Object.keys(entries);
  if (origins.length <= MAX_LAST_USED_ORIGINS) return false;
  const timestamp = (entry) => {
    const routes = operations ? Object.values(entry) : [entry];
    return Math.max(0, ...routes.map((route) =>
      Number.isFinite(route?.usedAt) ? route.usedAt : 0));
  };
  origins.sort((a, b) => timestamp(entries[b]) - timestamp(entries[a]) || a.localeCompare(b));
  for (const origin of origins.slice(MAX_LAST_USED_ORIGINS)) delete entries[origin];
  return true;
}
