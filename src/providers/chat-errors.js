import { ERROR_CODES } from "../errors.js";

function checkAbort(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error("Request aborted"), { code: "aborted" });
  }
}

/**
 * Keep diagnostics useful without returning a request's credential or arbitrary
 * exception fields. Each invocation closes over its own explicit credentials.
 * @param {import("./types.js").Provider["streamChat"]} streamChat
 * @returns {import("./types.js").Provider["streamChat"]}
 */
export function withChatErrorBoundary(streamChat) {
  return async function (args) {
    try {
      checkAbort(args.signal);
      const result = await streamChat.call(this, args);
      checkAbort(args.signal);
      return result;
    } catch (cause) {
      const code = args.signal?.aborted
        ? "aborted"
        : ERROR_CODES.includes(cause?.code) ? cause.code : "provider_error";
      let message = code === "aborted"
        ? "Request aborted"
        : typeof cause?.message === "string" ? cause.message : "Provider request failed";
      if (args.apiKey) message = message.replaceAll(args.apiKey, "[redacted]");
      message = message
        .replace(/\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)\b/g, "[redacted]")
        .slice(0, 1200);
      throw Object.assign(new Error(message), { name: "InferenceError", code });
    }
  };
}
