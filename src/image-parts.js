/**
 * Image content parts + output.images helpers for stable request.
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
 * Shared consent policy. Unknown discovery fails closed; the explicit native
 * passthrough exception retains existing OpenAI/Anthropic/compat behavior.
 * @param {import("./providers/types.js").ModelCapabilities} capabilities
 * @param {{ imageInput?: boolean, imageOutput?: boolean }} request
 */
export function blocksAllowForImages(capabilities, request) {
  if (request.imageOutput && capabilities?.imageOutput !== true) return true;
  if (request.imageInput && capabilities?.imageInput !== true) {
    return !(capabilities?.imageInput === null && capabilities.imageInputPassthrough === true);
  }
  return false;
}

/** Warnings and the Allow gate consume the same resolved model result. */
export function imageCapabilityWarnings(provider, request, capabilities = {}) {
  const label = provider?.label || "This provider";
  const warnings = [];
  const features = [
    ["imageInput", "image input"],
    ["imageOutput", "image generation"],
  ];
  for (const [field, description] of features) {
    if (!request[field] || !blocksAllowForImages(capabilities, { [field]: true })) continue;
    warnings.push(
      capabilities[field] === false
        ? `${label}: the selected model does not support ${description}. Choose a model with verified support.`
        : `${label}: could not verify ${description} for the selected model. Choose a verified model or retry discovery.`
    );
  }
  return warnings;
}

/** Native protocol guidance is supplied by the adapter, without provider IDs. */
export function imageCapabilityNotes(request, capabilities = {}) {
  return request.imageInput && capabilities.imageInputNote ? [capabilities.imageInputNote] : [];
}

/** Reject required image capabilities; never silently strip image parts/output. */
export function assertImagesSupported(provider, messages, output, capabilities = {}) {
  if (requestWantsImageOutput(output) && capabilities.imageOutput !== true) {
    throwInference(
      "unavailable",
      "Image output (output.images) is not available for this provider or model."
    );
  }
  if (blocksAllowForImages(capabilities, { imageInput: messagesHaveImageParts(messages) })) {
    throwInference(
      "unavailable",
      `Image input is not supported or verified by ${provider?.label || "this provider"}. Choose a vision-capable model.`
    );
  }
}

/**
 * Flatten content parts for Ollama `/api/chat`.
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
 * Map IPA content to OpenAI Chat Completions multimodal parts.
 * @param {unknown} content
 * @returns {unknown}
 */
export function mapContentForOpenAICompat(content) {
  if (typeof content === "string" || content == null) return content;
  if (!Array.isArray(content)) return String(content);
  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ type?: unknown, text?: unknown, mediaType?: unknown, data?: unknown }} */ (
      part
    );
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "image" && typeof p.data === "string" && p.data) {
      const mediaType = isImageMediaType(p.mediaType) ? p.mediaType : "image/png";
      const data = rawImageBase64(p.data);
      if (!data) continue;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mediaType};base64,${data}` },
      });
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * Map IPA content to Anthropic Messages blocks (base64 image sources).
 * @param {unknown} content
 * @returns {string | Array<Record<string, unknown>>}
 */
export function mapContentForAnthropic(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ type?: unknown, text?: unknown, mediaType?: unknown, data?: unknown }} */ (
      part
    );
    if (p.type === "text" && typeof p.text === "string") {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "image" && typeof p.data === "string" && p.data) {
      const mediaType = isImageMediaType(p.mediaType) ? p.mediaType : "image/png";
      const data = rawImageBase64(p.data);
      if (!data) continue;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
      });
    }
  }
  if (blocks.length === 0) return "";
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => String(b.text)).join("");
  }
  return blocks;
}

/**
 * Map IPA content to OpenAI Responses `input_text` / `input_image` parts.
 * @param {unknown} content
 * @returns {unknown}
 */
export function mapContentForOpenAIResponses(content) {
  if (typeof content === "string" || content == null) return content;
  if (!Array.isArray(content)) return String(content);
  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = /** @type {{ type?: unknown, text?: unknown, mediaType?: unknown, data?: unknown }} */ (
      part
    );
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image" && typeof p.data === "string" && p.data) {
      const mediaType = isImageMediaType(p.mediaType) ? p.mediaType : "image/png";
      const data = rawImageBase64(p.data);
      if (!data) continue;
      parts.push({
        type: "input_image",
        image_url: `data:${mediaType};base64,${data}`,
      });
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * @param {unknown} url
 * @returns {{ type: "image", mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: string } | null}
 */
export function imagePartFromDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url);
  if (!match || !isImageMediaType(match[1])) return null;
  const data = match[2].replace(/\s/g, "");
  if (!data) return null;
  return {
    type: "image",
    mediaType: /** @type {import("./providers/types.js").ImagePart["mediaType"]} */ (
      match[1]
    ),
    data,
  };
}

/**
 * OpenRouter assistant images: `{ type, image_url: { url } }` (or camelCase).
 * @param {unknown} images
 * @returns {import("./providers/types.js").ImagePart[]}
 */
export function collectOpenRouterImageParts(images) {
  if (!Array.isArray(images)) return [];
  /** @type {import("./providers/types.js").ImagePart[]} */
  const parts = [];
  const seen = new Set();
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (image);
    const imageUrl = rec.image_url || rec.imageUrl;
    const url =
      imageUrl && typeof imageUrl === "object"
        ? /** @type {Record<string, unknown>} */ (imageUrl).url
        : typeof rec.url === "string"
          ? rec.url
          : undefined;
    const part = imagePartFromDataUrl(url);
    if (!part) continue;
    const key = `${part.mediaType}:${part.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts;
}

/**
 * Spec: text-only done is a string; images on done make content a part array.
 * @param {string} text
 * @param {import("./providers/types.js").ImagePart[]} images
 * @returns {string | import("./providers/types.js").ContentPart[]}
 */
/**
 * @param {unknown} data
 * @returns {"image/jpeg" | "image/png" | "image/webp" | "image/gif"}
 */
export function sniffImageMediaType(data) {
  if (typeof data !== "string") return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR") || data.startsWith("UklG")) return "image/webp";
  return "image/png";
}

/**
 * OpenAI Responses `image_generation_call.result` is raw base64 (sometimes a data URL).
 * @param {unknown} result
 * @returns {import("./providers/types.js").ImagePart | null}
 */
export function imagePartFromOpenAIBase64(result) {
  if (typeof result !== "string" || !result) return null;
  const trimmed = result.trim();
  if (trimmed.startsWith("data:")) return imagePartFromDataUrl(trimmed);
  const data = trimmed.replace(/\s/g, "");
  if (!data) return null;
  return {
    type: "image",
    mediaType: sniffImageMediaType(data),
    data,
  };
}

export function assembleAssistantContent(text, images) {
  if (!Array.isArray(images) || images.length === 0) return text;
  /** @type {import("./providers/types.js").ContentPart[]} */
  const parts = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...images);
  return parts;
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
