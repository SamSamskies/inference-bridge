import { AUDIO_TRANSFER_CHUNK_BYTES } from "./speech.js";

export class BinaryTransferError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "BinaryTransferError";
  }
}

/**
 * State for the side sending sequenced binary chunks. A chunk cannot begin
 * until the previous sequence is acknowledged.
 */
export class BinaryChunkSender {
  /**
   * @param {{ maxBytes: number, chunkBytes?: number }} options
   */
  constructor({ maxBytes, chunkBytes = AUDIO_TRANSFER_CHUNK_BYTES }) {
    assertPositiveInteger(maxBytes, "maxBytes");
    assertPositiveInteger(chunkBytes, "chunkBytes");
    this.maxBytes = maxBytes;
    this.chunkBytes = chunkBytes;
    this.totalBytes = 0;
    this.nextSequence = 0;
    this.inFlight = null;
    this.complete = false;
    this.aborted = false;
  }

  /**
   * Reserve the next outbound chunk before encoding/sending it.
   * @param {number} byteLength
   * @param {{ done?: boolean }} [options]
   * @returns {{ sequence: number, byteLength: number, done: boolean }}
   */
  beginChunk(byteLength, options = {}) {
    this.#assertActive();
    if (this.inFlight) {
      throw new BinaryTransferError(
        `Sequence ${this.inFlight.sequence} is still awaiting acknowledgement.`
      );
    }
    assertChunkLength(byteLength, this.chunkBytes);
    if (this.totalBytes + byteLength > this.maxBytes) {
      throw new BinaryTransferError(
        `Binary transfer exceeds the ${this.maxBytes}-byte limit.`
      );
    }
    const chunk = {
      sequence: this.nextSequence,
      byteLength,
      done: options.done === true,
    };
    this.nextSequence += 1;
    this.totalBytes += byteLength;
    this.inFlight = chunk;
    return { ...chunk };
  }

  /**
   * @param {number} sequence
   * @returns {{ complete: boolean, totalBytes: number }}
   */
  acknowledge(sequence) {
    this.#assertActive();
    if (!this.inFlight) {
      throw new BinaryTransferError(
        `Unexpected acknowledgement for sequence ${sequence}.`
      );
    }
    if (sequence !== this.inFlight.sequence) {
      throw new BinaryTransferError(
        `Expected acknowledgement ${this.inFlight.sequence}, received ${sequence}.`
      );
    }
    const done = this.inFlight.done;
    this.inFlight = null;
    if (done) this.complete = true;
    return { complete: this.complete, totalBytes: this.totalBytes };
  }

  abort() {
    this.aborted = true;
    this.inFlight = null;
  }

  #assertActive() {
    if (this.aborted) {
      throw new BinaryTransferError("Binary transfer is aborted.");
    }
    if (this.complete) {
      throw new BinaryTransferError("Binary transfer is already complete.");
    }
  }
}

/**
 * State for a pull-based receiver. requestChunk() authorizes exactly one
 * sequence; receiveChunk() consumes it and returns the acknowledgement.
 */
export class BinaryChunkReceiver {
  /**
   * @param {{
   *   maxBytes: number,
   *   expectedBytes?: number,
   *   chunkBytes?: number,
   * }} options
   */
  constructor({
    maxBytes,
    expectedBytes,
    chunkBytes = AUDIO_TRANSFER_CHUNK_BYTES,
  }) {
    assertPositiveInteger(maxBytes, "maxBytes");
    assertPositiveInteger(chunkBytes, "chunkBytes");
    if (expectedBytes !== undefined) {
      assertPositiveInteger(expectedBytes, "expectedBytes");
      if (expectedBytes > maxBytes) {
        throw new BinaryTransferError(
          `Expected payload exceeds the ${maxBytes}-byte limit.`
        );
      }
    }
    this.maxBytes = maxBytes;
    this.expectedBytes = expectedBytes;
    this.chunkBytes = chunkBytes;
    this.totalBytes = 0;
    this.nextSequence = 0;
    this.requestedSequence = null;
    this.complete = false;
    this.aborted = false;
  }

  /**
   * @returns {{ sequence: number, maxBytes: number }}
   */
  requestChunk() {
    this.#assertActive();
    if (this.requestedSequence !== null) {
      throw new BinaryTransferError(
        `Sequence ${this.requestedSequence} was already requested.`
      );
    }
    this.requestedSequence = this.nextSequence;
    return {
      sequence: this.requestedSequence,
      maxBytes: Math.min(
        this.chunkBytes,
        this.expectedBytes === undefined
          ? this.maxBytes - this.totalBytes
          : this.expectedBytes - this.totalBytes
      ),
    };
  }

  /**
   * @param {{ sequence: number, byteLength: number, done?: boolean }} chunk
   * @returns {{
   *   acknowledge: number,
   *   complete: boolean,
   *   totalBytes: number,
   * }}
   */
  receiveChunk(chunk) {
    this.#assertActive();
    if (this.requestedSequence === null) {
      throw new BinaryTransferError(
        `Sequence ${chunk.sequence} arrived without a request.`
      );
    }
    if (chunk.sequence !== this.requestedSequence) {
      throw new BinaryTransferError(
        `Expected sequence ${this.requestedSequence}, received ${chunk.sequence}.`
      );
    }
    assertChunkLength(chunk.byteLength, this.chunkBytes);
    if (this.totalBytes + chunk.byteLength > this.maxBytes) {
      throw new BinaryTransferError(
        `Binary transfer exceeds the ${this.maxBytes}-byte limit.`
      );
    }

    const nextTotal = this.totalBytes + chunk.byteLength;
    if (
      this.expectedBytes !== undefined &&
      nextTotal > this.expectedBytes
    ) {
      throw new BinaryTransferError(
        `Binary transfer exceeds its declared ${this.expectedBytes}-byte length.`
      );
    }
    const done = chunk.done === true;
    if (
      this.expectedBytes !== undefined &&
      done &&
      nextTotal !== this.expectedBytes
    ) {
      throw new BinaryTransferError(
        `Binary transfer ended at ${nextTotal} bytes; expected ${this.expectedBytes}.`
      );
    }
    if (
      this.expectedBytes !== undefined &&
      nextTotal === this.expectedBytes &&
      !done
    ) {
      throw new BinaryTransferError(
        "Final binary chunk must be marked done."
      );
    }
    if (
      this.expectedBytes === undefined &&
      nextTotal === this.maxBytes &&
      !done
    ) {
      throw new BinaryTransferError(
        "A binary transfer reaching its byte limit must be marked done."
      );
    }

    const acknowledge = this.requestedSequence;
    this.requestedSequence = null;
    this.nextSequence += 1;
    this.totalBytes = nextTotal;
    if (done) this.complete = true;
    return {
      acknowledge,
      complete: this.complete,
      totalBytes: this.totalBytes,
    };
  }

  abort() {
    this.aborted = true;
    this.requestedSequence = null;
  }

  #assertActive() {
    if (this.aborted) {
      throw new BinaryTransferError("Binary transfer is aborted.");
    }
    if (this.complete) {
      throw new BinaryTransferError("Binary transfer is already complete.");
    }
  }
}

/**
 * Encode raw bytes only for a chrome.runtime.Port hop.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeRuntimeBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new BinaryTransferError("Binary chunks must be non-empty Uint8Array values.");
  }
  let binary = "";
  const batchBytes = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += batchBytes) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + batchBytes)
    );
  }
  return btoa(binary);
}

/**
 * Decode and bound one runtime-port chunk.
 * @param {unknown} value
 * @param {number} [chunkBytes]
 * @returns {Uint8Array}
 */
export function decodeRuntimeBase64(
  value,
  chunkBytes = AUDIO_TRANSFER_CHUNK_BYTES
) {
  assertPositiveInteger(chunkBytes, "chunkBytes");
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new BinaryTransferError("Runtime binary chunk is not valid base64.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new BinaryTransferError("Runtime binary chunk is not valid base64.");
  }
  if (binary.length === 0 || binary.length > chunkBytes) {
    throw new BinaryTransferError(
      `Runtime binary chunk must contain 1 to ${chunkBytes} bytes.`
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {number} value
 * @param {string} label
 */
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BinaryTransferError(`${label} must be a positive safe integer.`);
  }
}

/**
 * @param {number} value
 * @param {number} max
 */
function assertChunkLength(value, max) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new BinaryTransferError(
      `Binary chunk length must be between 1 and ${max} bytes.`
    );
  }
}
