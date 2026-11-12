/** Decimal units match the MB/kB labels shown to users. */
export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const divisor = bytes < 1_000_000 ? 1000 : 1_000_000;
  return `${Number((bytes / divisor).toFixed(1))} ${divisor === 1000 ? "kB" : "MB"}`;
}

export function byteLimitMessage(subject, bytes, limit) {
  const size = formatBytes(bytes), maximum = formatBytes(limit);
  // Keep a one-byte overflow clear even when both rounded values are identical.
  const exact = size === maximum ? ` (${bytes.toLocaleString("en-US")} > ${limit.toLocaleString("en-US")} bytes)` : "";
  return `${subject} is ${size}; the limit is ${maximum}${exact}.`;
}
