import { normalizeProviderError } from "./provider-error.js";

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
      throw normalizeProviderError(cause, args);
    }
  };
}
