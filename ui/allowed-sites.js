import { normalizeProviderId } from "../src/storage.js";

/** Capability order and labels shared by site summaries and operation controls. */
export const OPERATION_LABELS = {
  transcribe: "Transcription",
  synthesize: "Synthesis",
  decide: "Decisions",
};

/**
 * Group a sanitized settings snapshot by exact origin, including operation-only
 * sites. The original grants retain their independent permission semantics.
 * @param {{ allowedOrigins: Record<string, import("../src/storage-local.js").OriginGrant>, operationGrants: import("../src/storage-local.js").OperationGrants }} settings
 */
export function groupAllowedSites({ allowedOrigins, operationGrants }) {
  const origins = new Set([
    ...Object.keys(allowedOrigins),
    ...Object.keys(operationGrants),
  ]);
  return [...origins].sort((a, b) => a.localeCompare(b)).flatMap((origin) => {
    const chat = allowedOrigins[origin];
    const operations = Object.entries(OPERATION_LABELS).flatMap(([operation, label]) => {
      const grant = operationGrants[origin]?.[operation];
      return grant ? [{ ...grant, origin, operation, label }] : [];
    });
    if (!chat && operations.length === 0) return [];
    return [{
      origin,
      chat: chat ? { ...chat, origin, providerId: normalizeProviderId(chat.providerId) } : null,
      operations,
      capabilities: [...(chat ? ["Chat"] : []), ...operations.map(({ label }) => label)],
    }];
  });
}
