/**
 * Experimental image content parts + output.images helpers.
 * Stable IPA chat stays string-only; this surface is experimental.request only.
 */

/** @typedef {import("./providers/types.js").ChatMessage} ChatMessage */

export const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const IMAGE_MEDIA_TYPE_SET = new Set(IMAGE_MEDIA_TYPES);

/**
 * @param {unknown} value
 * @returns {value is "image/jpeg" | "image/png" | "image/webp" | "image/gif"}
 */
export function isImageMediaType(value) {
  return typeof value === "string" && IMAGE_MEDIA_TYPE_SET.has(value);
}

/**
 * Strip a `data:image/...;base64,` prefix if present so Ollama gets raw b64.
 * @param {string} data
 * @returns {string}
 */
export function rawImageBase64(data) {
  if (typeof data !== "string") return "";
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/.exec(data);
  return (match ? match[1] : data).trim();
}

/**
 * @param {unknown} part
 * @returns {part is { type: "image", mediaType: string, data: string }}
 */
export function isImagePart(part) {
  return Boolean(
    part &&
      typeof part === "object" &&
      /** @type {{ type?: unknown }} */ (part).type === "image"
  );
}

/**
 * @param {unknown} content
 * @returns {boolean}
 */
export function contentHasImageParts(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => isImagePart(part));
}

/**
 * @param {Array<{ content?: unknown }> | undefined | null} messages
 * @returns {boolean}
 */
export function messagesHaveImageParts(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => contentHasImageParts(m?.content));
}

/**
 * @param {unknown} output
 * @returns {boolean}
 */
export function requestWantsImageOutput(output) {
  return Boolean(
    output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      /** @type {{ images?: unknown }} */ (output).images === true
  );
}

/**
 * Persistent Always-allow covers image input / output only when those flags
 * were granted. A later chat-only Always-allow rebuilds the grant without
 * them (same idea as clearing toolFingerprint).
 *
 * @param {{ imageInput?: boolean, imageOutput?: boolean } | null | undefined} grant
 * @param {{ imageInput?: boolean, imageOutput?: boolean }} request
 * @returns {boolean}
 */
export function isImageGrantCovered(grant, request) {
  if (request.imageInput && grant?.imageInput !== true) return false;
  if (request.imageOutput && grant?.imageOutput !== true) return false;
  return true;
}

/**
 * True when Allow must stay disabled because this Bridge build cannot honor
 * the image request on the selected provider/model.
 *
 * @param {{ id?: string } | null | undefined} provider
 * @param {{
 *   imageInput?: boolean,
 *   imageOutput?: boolean,
 *   modelHasVision?: boolean,
 * }} request
 * @returns {boolean}
 */
export function blocksAllowForImages(provider, request) {
  if (request.imageOutput) return true;
  if (request.imageInput) {
    if (provider?.id !== "ollama") return true;
    if (request.modelHasVision !== true) return true;
  }
  return false;
}

/**
 * @param {{ id?: string, label?: string } | null | undefined} provider
 * @param {{
 *   imageInput?: boolean,
 *   imageOutput?: boolean,
 *   modelHasVision?: boolean,
 * }} request
 * @returns {string[]}
 */
export function imageCapabilityWarnings(provider, request) {
  if (!request.imageInput && !request.imageOutput) return [];
  const label =
    provider && typeof provider.label === "string" && provider.label
      ? provider.label
      : "This provider";
  /** @type {string[]} */
  const warnings = [];
  if (request.imageOutput) {
    warnings.push(
      "Image generation is not available for this provider yet. Choose a different request or wait for a provider that can return images."
    );
  }
  if (request.imageInput) {
    if (provider?.id !== "ollama") {
      warnings.push(
        `${label} cannot read image parts in this experimental build. Choose Ollama with a vision model.`
      );
    } else if (request.modelHasVision === false) {
      warnings.push(
        "The selected Ollama model does not support image input. Choose a vision model (for example llava or gemma3)."
      );
    }
  }
  return warnings;
}

/**
 * Fail closed in adapters when the provider cannot honor image parts / output.
 * Ollama image input is allowed here; the adapter still checks vision.
 *
 * @param {{ id?: string, label?: string } | null | undefined} provider
 * @param {ChatMessage[] | undefined | null} messages
 * @param {unknown} [output]
 * @returns {void}
 */
export function assertImagesSupported(provider, messages, output) {
  const imageInput = messagesHaveImageParts(messages);
  const imageOutput = requestWantsImageOutput(output);
  if (!imageInput && !imageOutput) return;
  if (imageOutput) {
    throwInference(
      "unavailable",
      "Image output (output.images) is not available for this provider."
    );
  }
  if (imageInput && provider?.id !== "ollama") {
    const label =
      provider && typeof provider.label === "string" && provider.label
        ? provider.label
        : "This provider";
    throwInference(
      "unavailable",
      `Image input is not supported by ${label}. Choose Ollama with a vision model.`
    );
  }
}

/**
 * Flatten experimental content parts for Ollama `/api/chat`.
 * Text parts concatenate in order; image parts become `images` (raw base64).
 *
 * @param {unknown} content
 * @returns {{ content: string, images?: string[] }}
 */
export function mapContentForOllama(content) {
  if (typeof content === "string") return { content };
  if (content == null) return { content: "" };
  if (!Array.isArray(content)) return { content: String(content) };

  let text = "";
  /** @type {string[]} */
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ type?: unknown, text?: unknown, data?: unknown }} */ (
      part
    );
    if (p.type === "text" && typeof p.text === "string") {
      text += p.text;
    } else if (p.type === "image" && typeof p.data === "string" && p.data) {
      const b64 = rawImageBase64(p.data);
      if (b64) images.push(b64);
    }
  }
  return images.length > 0 ? { content: text, images } : { content: text };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwInference(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  throw error;
}
