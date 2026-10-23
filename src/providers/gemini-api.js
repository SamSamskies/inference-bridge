/** Native Gemini HTTP/SSE primitives. Credentials are headers, never URL data. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

export function geminiError(code, message) {
  return Object.assign(new Error(message), { name: "InferenceError", code });
}

export function checkGeminiAbort(signal) {
  if (signal?.aborted) throw geminiError("aborted", "Request aborted");
}

export function safeGeminiDetail(value, apiKey) {
  const detail = typeof value === "string" ? value : "Gemini request failed";
  return (apiKey ? detail.replaceAll(apiKey, "[redacted]") : detail)
    .replace(/AIza[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 1200);
}

/** Preserve Google's structured field errors without forwarding arbitrary metadata. */
export function geminiErrorDetail(error, apiKey) {
  const message = typeof error === "string" ? error : error?.message;
  const fields = (Array.isArray(error?.details) ? error.details : [])
    .flatMap((detail) =>
      Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []
    )
    .filter(
      (item) =>
        typeof item?.field === "string" && typeof item?.description === "string"
    )
    .slice(0, 5)
    .map((item) => `${item.field}: ${item.description}`);
  return safeGeminiDetail(
    [message || "Gemini request failed", ...fields].join("; "),
    apiKey
  );
}

export async function geminiFetch(path, { apiKey, signal, ...init } = {}) {
  checkGeminiAbort(signal);
  if (!apiKey?.trim())
    throw geminiError(
      "unavailable",
      "Google Gemini needs an API key. Add your Google AI Studio key in Options."
    );
  const url = new URL(path, GEMINI_BASE_URL);
  if (url.origin !== GEMINI_BASE_URL || url.username || url.password) {
    throw geminiError(
      "provider_error",
      "Gemini returned an unexpected API host"
    );
  }
  let response;
  try {
    response = await fetch(url.href, {
      ...init,
      headers: { ...init.headers, "x-goog-api-key": apiKey },
      redirect: "error",
      signal,
    });
  } catch {
    checkGeminiAbort(signal);
    throw geminiError(
      "unavailable",
      "Unable to contact Google Gemini. Check your connection and provider host access."
    );
  }
  if (!response.ok) {
    let error;
    try {
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        // The Interactions streaming endpoint can return an SSE error record
        // even with a non-2xx HTTP status. Do not discard its useful message.
        const data = text
          .split(/\r?\n/)
          .find((line) => line.startsWith("data:"));
        if (data) payload = JSON.parse(data.slice(5).trim());
      }
      const body = Array.isArray(payload) ? payload[0] : payload;
      error =
        typeof body?.error === "string" && typeof body?.message === "string"
          ? body
          : (body?.error ?? body);
    } catch {
      /* no raw body */
    }
    const detail = geminiErrorDetail(error, apiKey);
    const status = response.status;
    const reason = /billing|payment|paid tier/i.test(detail)
      ? "API billing"
      : status === 401
        ? "API key authentication"
        : status === 403
          ? "API key permissions or project access"
          : status === 429
            ? "rate limit or quota"
            : status === 404
              ? "model or API availability"
              : `HTTP ${status}`;
    throw Object.assign(
      geminiError(
        status >= 500 || status === 404 ? "unavailable" : "provider_error",
        `Google Gemini ${reason}: ${detail}`
      ),
      { status }
    );
  }
  return response;
}

export async function geminiJson(path, args) {
  const response = await geminiFetch(path, args);
  try {
    return await response.json();
  } catch {
    checkGeminiAbort(args?.signal);
    throw geminiError(
      "provider_error",
      "Google Gemini returned malformed JSON"
    );
  }
}

/** Dispatch complete SSE records (including multiline data and a final record). */
export async function readGeminiEvents(response, { signal, onEvent }) {
  if (!response.body)
    throw geminiError("provider_error", "Google Gemini response had no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  async function dispatch(record) {
    const data = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw geminiError(
        "provider_error",
        "Google Gemini returned malformed stream data"
      );
    }
    if (!event || typeof event !== "object")
      throw geminiError(
        "provider_error",
        "Google Gemini returned an invalid stream event"
      );
    await onEvent(event);
    if (event.event_type === "interaction.completed") complete = true;
  }
  try {
    while (true) {
      checkGeminiAbort(signal);
      const { value, done } = await reader.read();
      checkGeminiAbort(signal);
      buffer += value ? decoder.decode(value, { stream: true }) : "";
      if (done) buffer += decoder.decode();
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        await dispatch(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (complete) return;
      }
      if (buffer.length > 2_000_000)
        throw geminiError(
          "provider_error",
          "Google Gemini stream event exceeded the size limit"
        );
      if (done) {
        if (buffer.trim()) await dispatch(buffer);
        break;
      }
    }
    if (!complete)
      throw geminiError(
        "provider_error",
        "Google Gemini stream ended before completion"
      );
  } catch (error) {
    checkGeminiAbort(signal);
    if (error?.code) throw error;
    throw geminiError("provider_error", "Google Gemini stream was interrupted");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      /* closed stream */
    }
    reader.releaseLock();
  }
}
