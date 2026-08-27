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
 * Providers that map IPA image parts on chat without a catalog probe.
 * OpenRouter is catalog-gated (`capabilities.imageInput`) instead.
 * @param {{ id?: string } | null | undefined} provider
 * @returns {boolean}
 */
export function providerMapsImageInput(provider) {
  const id = provider?.id;
  if (id === "ollama" || id === "openai" || id === "anthropic") return true;
  return typeof id === "string" && id.startsWith("compat:");
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
 *   modelCanGenerateImages?: boolean,
 * }} request
 * @returns {boolean}
 */
export function blocksAllowForImages(provider, request) {
  if (request.imageOutput) {
    if (provider?.id !== "openrouter") return true;
    if (request.modelCanGenerateImages !== true) return true;
  }
  if (request.imageInput) {
    if (provider?.id === "ollama") {
      return request.modelHasVision !== true;
    }
    if (provider?.id === "openrouter") {
      return request.modelHasVision !== true;
    }
    if (providerMapsImageInput(provider)) return false;
    return true;
  }
  return false;
}

/**
 * @param {{ id?: string, label?: string } | null | undefined} provider
 * @param {{
 *   imageInput?: boolean,
 *   imageOutput?: boolean,
 *   modelHasVision?: boolean,
 *   modelCanGenerateImages?: boolean,
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
    if (provider?.id !== "openrouter") {
      warnings.push(
        "Image generation is not available for this provider yet. Choose OpenRouter with an image-output model (for example google/gemini-2.5-flash-image)."
      );
    } else if (request.modelCanGenerateImages === false) {
      warnings.push(
        "The selected OpenRouter model does not generate images. Choose a model whose output modalities include image (for example google/gemini-2.5-flash-image)."
      );
    }
  }
  if (request.imageInput) {
    if (provider?.id === "ollama") {
      if (request.modelHasVision === false) {
        warnings.push(
          "The selected Ollama model does not support image input. Choose a vision model (for example llava or gemma3)."
        );
      }
    } else if (provider?.id === "openrouter") {
      if (request.modelHasVision === false) {
        warnings.push(
          "The selected OpenRouter model does not accept image input. Choose a vision-capable model."
        );
      }
    } else if (!providerMapsImageInput(provider)) {
      warnings.push(
        `${label} cannot read image parts in this experimental build. Choose a vision-capable OpenAI, Anthropic, OpenRouter, Ollama, or OpenAI-compatible model.`
      );
    }
  }
  return warnings;
}

/**
 * Informational (non-blocking) image notes. Shown with muted hint styling,
 * not the danger color used when Allow is disabled.
 *
 * @param {{ id?: string } | null | undefined} provider
 * @param {{ imageInput?: boolean }} request
 * @returns {string[]}
 */
export function imageCapabilityNotes(provider, request) {
  if (!request.imageInput) return [];
  if (typeof provider?.id === "string" && provider.id.startsWith("compat:")) {
    return [
      "Image parts are forwarded as Chat Completions image_url. The selected model must support vision.",
    ];
  }
  return [];
}

/**
 * Fail closed in adapters when the provider cannot honor image parts / output.
 * Ollama image input is allowed here; the adapter still checks vision.
 * Pass `capabilities.imageOutput` / `imageInput` when a provider (OpenRouter)
 * has already confirmed the selected model can honor that surface.
 *
 * @param {{ id?: string, label?: string } | null | undefined} provider
 * @param {ChatMessage[] | undefined | null} messages
 * @param {unknown} [output]
 * @param {{ imageInput?: boolean, imageOutput?: boolean }} [capabilities]
 * @returns {void}
 */
export function assertImagesSupported(provider, messages, output, capabilities = {}) {
  const imageInput = messagesHaveImageParts(messages);
  const imageOutput = requestWantsImageOutput(output);
  if (!imageInput && !imageOutput) return;
  if (imageOutput && capabilities.imageOutput !== true) {
    throwInference(
      "unavailable",
      "Image output (output.images) is not available for this provider or model."
    );
  }
  if (
    imageInput &&
    !providerMapsImageInput(provider) &&
    capabilities.imageInput !== true
  ) {
    const label =
      provider && typeof provider.label === "string" && provider.label
        ? provider.label
        : "This provider";
    throwInference(
      "unavailable",
      `Image input is not supported by ${label}. Choose a vision-capable OpenAI, Anthropic, OpenRouter, Ollama, or OpenAI-compatible model.`
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
