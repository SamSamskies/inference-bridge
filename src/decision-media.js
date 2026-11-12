/** Explicit, bounded native decision images. Never fetches or rewrites media. */
import { rawBase64ByteLength } from "./speech.js";
import { byteLimitMessage } from "./format-bytes.js";

export const DECISION_IMAGE_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const DECISION_ATTACHMENT_MAX_COUNT = 4;
export const DECISION_IMAGE_MAX_BYTES = 20_000_000;
export const DECISION_IMAGES_MAX_BYTES = 32_000_000;
export const DECISION_MEDIA_TRANSPORT_MAX_BYTES = 48_000_000;

export function decisionMediaError(code, message) {
  return Object.assign(new Error(message), { name: "InferenceError", code });
}
function checkAbort(signal) {
  if (signal?.aborted) throw decisionMediaError("aborted", "Request aborted");
}
const plain = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || (Object.getPrototypeOf(proto) === null && proto.constructor?.name === "Object");
};
function invalid(index, message) {
  throw decisionMediaError("invalid_request", `Decision attachment ${index}: ${message}`);
}

/** Length/alphabet/padding checks precede any decoded allocation. */
export function decisionImageByteLength(data, index = 0) {
  if (typeof data !== "string") invalid(index, "data must be canonical raw base64.");
  if (data.length > 4 * Math.ceil(DECISION_IMAGE_MAX_BYTES / 3)) {
    if (data.length % 4 === 0) {
      const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      invalid(index, byteLimitMessage("Decoded image", size, DECISION_IMAGE_MAX_BYTES));
    }
    invalid(index, byteLimitMessage("Encoded image data", data.length, 4 * Math.ceil(DECISION_IMAGE_MAX_BYTES / 3)));
  }
  const size = rawBase64ByteLength(data);
  if (size < 1) invalid(index, "data must be nonempty canonical raw base64.");
  if (size > DECISION_IMAGE_MAX_BYTES) invalid(index, byteLimitMessage("Decoded image", size, DECISION_IMAGE_MAX_BYTES));
  // RFC 4648 requires unused padding bits to be zero.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if ((data.endsWith("==") && (alphabet.indexOf(data.at(-3)) & 15)) ||
      (data.endsWith("=") && !data.endsWith("==") && (alphabet.indexOf(data.at(-2)) & 3)))
    invalid(index, "base64 padding bits are not canonical.");
  return size;
}

/** The extension transport contains strings only; page Blobs are snapshotted there. */
export function snapshotDecisionAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length > DECISION_ATTACHMENT_MAX_COUNT)
    throw decisionMediaError("invalid_request", `Decision attachments must be a dense array of at most ${DECISION_ATTACHMENT_MAX_COUNT} images.`);
  let total = 0;
  const snapshot = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const image = attachments[index];
    if (!Object.hasOwn(attachments, index) || !plain(image) ||
        Object.keys(image).length !== 3 || Object.keys(image).some((key) => !["type", "mediaType", "data"].includes(key)) ||
        image.type !== "image") invalid(index, "expected exactly type, mediaType, and data for an image.");
    if (!DECISION_IMAGE_MEDIA_TYPES.includes(image.mediaType)) invalid(index, "mediaType is not an advertised decision image type (JPEG, PNG, WebP).");
    total += decisionImageByteLength(image.data, index);
    if (total > DECISION_IMAGES_MAX_BYTES) invalid(index, byteLimitMessage("Total decoded images", total, DECISION_IMAGES_MAX_BYTES));
    snapshot.push({ type: "image", mediaType: image.mediaType, data: image.data });
  }
  return snapshot;
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parse dimensions before asking a browser decoder to allocate pixel buffers. */
export function decisionImageDimensions(bytes, mediaType, index = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0, height = 0;
  if (mediaType === "image/png") {
    if (bytes.length < 45 || ascii(0, 8) !== "\x89PNG\r\n\x1a\n") invalid(index, "invalid PNG signature.");
    let offset = 8, idat = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) invalid(index, "truncated PNG chunk.");
      const type = ascii(offset + 4, 4);
      if (crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) invalid(index, "corrupt PNG checksum.");
      if (offset === 8 && (type !== "IHDR" || length !== 13)) invalid(index, "invalid PNG header.");
      if (type === "IHDR") {
        if (width || offset !== 8 || length !== 13) invalid(index, "duplicate PNG header.");
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      }
      if (type === "acTL") invalid(index, "animated images are not supported.");
      if (type === "IDAT") idat = true;
      offset = end;
      if (type === "IEND") { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!idat || !ended) invalid(index, "incomplete PNG image.");
  } else if (mediaType === "image/jpeg") {
    if (bytes.length < 4 || view.getUint16(0) !== 0xffd8 || view.getUint16(bytes.length - 2) !== 0xffd9)
      invalid(index, "invalid or truncated JPEG.");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) invalid(index, "invalid JPEG marker.");
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) invalid(index, "truncated JPEG header.");
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) invalid(index, "truncated JPEG segment.");
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8) invalid(index, "invalid JPEG dimensions.");
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += size;
    }
  } else if (mediaType === "image/webp") {
    if (bytes.length < 20 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length)
      invalid(index, "invalid WebP container.");
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + size + (size & 1) > bytes.length) invalid(index, "truncated WebP chunk.");
      if (type === "ANIM" || type === "ANMF" || (type === "VP8X" && (bytes[start] & 2))) invalid(index, "animated images are not supported.");
      if (type === "VP8X" && size >= 10) {
        width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
        height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
      } else if (type === "VP8 " && size >= 10 && ascii(start + 3, 3) === "\x9d\x01\x2a") {
        width ||= view.getUint16(start + 6, true) & 0x3fff;
        height ||= view.getUint16(start + 8, true) & 0x3fff;
      } else if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
        width ||= 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8);
        height ||= 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10);
      }
      offset = start + size + (size & 1);
    }
    if (offset !== bytes.length) invalid(index, "incomplete WebP image.");
  } else invalid(index, "unsupported image format.");
  if (!width || !height) invalid(index, "missing image dimensions or mismatched format.");
  return { width, height };
}

/** Uncancellable browser work is raced against cancellation; late bitmaps close. */
export async function validateDecisionImages(attachments = [], { signal } = {}) {
  checkAbort(signal);
  const images = snapshotDecisionAttachments(attachments);
  const summaries = [];
  for (const [index, image] of images.entries()) {
    checkAbort(signal);
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    const dimensions = decisionImageDimensions(bytes, image.mediaType, index);
    if (typeof createImageBitmap !== "function")
      throw decisionMediaError("unavailable", "Native decision image validation is unavailable in this browser.");
    let bitmap;
    let onAbort;
    const decoding = Promise.resolve().then(() => { checkAbort(signal); return createImageBitmap(new Blob([bytes], { type: image.mediaType })); });
    try {
      bitmap = await Promise.race([
        decoding,
        new Promise((_, reject) => {
          onAbort = () => reject(decisionMediaError("aborted", "Request aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
      checkAbort(signal);
    } catch (error) {
      if (typeof error?.code === "string") throw error;
      invalid(index, "corrupt image bytes or unsupported image encoding.");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      bitmap?.close();
      if (!bitmap) void decoding.then((late) => late.close(), () => {});
    }
    summaries.push({ index, mediaType: image.mediaType, byteLength: bytes.length, ...dimensions });
  }
  return summaries;
}

export function decisionMediaTypes(attachments = []) {
  return [...new Set(attachments.map((image) => image.mediaType))].sort();
}
export function coversDecisionMedia(grant, types = []) {
  return types.every((type) => grant?.imageMediaTypes?.includes(type));
}
export function assertDecisionMediaSupported(provider, attachments = [], model) {
  const supported = provider?.decisions?.imageMediaTypes || [];
  if (attachments.some((image) => !supported.includes(image.mediaType)))
    throw decisionMediaError("unavailable", `${provider?.label || "This provider"} cannot accept these native decision images. Choose a supported image decision route.`);
  if (attachments.length && model !== undefined && provider.decisions.imageInputRequiresModelCapability && !model?.inputModalities?.includes("image"))
    throw decisionMediaError("unavailable", `${provider.label}: native decision image support is not verified for the selected model.`);
  let total = 0, encoded = 0;
  for (const [index, image] of attachments.entries()) {
    const size = image.byteLength ?? decisionImageByteLength(image.data, index);
    const limit = provider.decisions.maxImageBytes ?? DECISION_IMAGE_MAX_BYTES;
    if (size > limit)
      throw decisionMediaError("invalid_request", byteLimitMessage(`${provider.label} decision attachment ${image.index ?? index}`, size, limit));
    total += size;
    encoded += 4 * Math.ceil(size / 3);
    const maxPixels = provider.decisions.maxImagePixels;
    if (maxPixels !== undefined) {
      // Only routes with a documented pixel limit need dimensions here.
      // Approval receives metadata; direct adapters receive bounded base64.
      const { width, height } = typeof image.data === "string"
        ? decisionImageDimensions(Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)), image.mediaType, index)
        : image;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw decisionMediaError("invalid_request", `${provider.label}: decision image dimensions are unavailable.`);
      if (width * height > maxPixels)
        throw decisionMediaError("invalid_request", `${provider.label} decision attachment ${image.index ?? index} is ${width} × ${height} pixels; this provider's limit is ${maxPixels / 1_000_000} MP.`);
    }
  }
  const limit = provider?.decisions?.maxTotalImageBytes ?? DECISION_IMAGES_MAX_BYTES;
  if (total > limit) throw decisionMediaError("invalid_request", byteLimitMessage(`${provider.label} total decoded images`, total, limit));
  // Metadata alone can rule out a body that already exceeds the route's cap.
  // Adapter preflight also measures the exact final JSON, including text.
  const bodyLimit = provider?.decisions?.maxMediaBodyBytes ?? DECISION_MEDIA_TRANSPORT_MAX_BYTES;
  if (encoded > bodyLimit) throw decisionMediaError("invalid_request", byteLimitMessage(`${provider.label} encoded images`, encoded, bodyLimit));
}
