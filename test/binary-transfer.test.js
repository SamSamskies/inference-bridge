import { describe, expect, it } from "vitest";
import {
  BinaryChunkReceiver,
  BinaryChunkSender,
  BinaryTransferError,
  decodeRuntimeBase64,
  encodeRuntimeBase64,
} from "../src/binary-transfer.js";

describe("BinaryChunkSender", () => {
  it("allows exactly one in-flight sequence", () => {
    const sender = new BinaryChunkSender({ maxBytes: 10, chunkBytes: 4 });
    expect(sender.beginChunk(4)).toEqual({
      sequence: 0,
      byteLength: 4,
      done: false,
    });
    expect(() => sender.beginChunk(1)).toThrow(/awaiting acknowledgement/);
    expect(sender.acknowledge(0)).toEqual({
      complete: false,
      totalBytes: 4,
    });
    expect(sender.beginChunk(2, { done: true })).toEqual({
      sequence: 1,
      byteLength: 2,
      done: true,
    });
    expect(sender.acknowledge(1)).toEqual({
      complete: true,
      totalBytes: 6,
    });
    expect(() => sender.beginChunk(1)).toThrow(/already complete/);
  });

  it("rejects missing, duplicate, and out-of-order acknowledgements", () => {
    const sender = new BinaryChunkSender({ maxBytes: 10 });
    expect(() => sender.acknowledge(0)).toThrow(/Unexpected acknowledgement/);
    sender.beginChunk(1);
    expect(() => sender.acknowledge(1)).toThrow(
      /Expected acknowledgement 0/
    );
    sender.acknowledge(0);
    expect(() => sender.acknowledge(0)).toThrow(/Unexpected acknowledgement/);
  });

  it("enforces non-empty chunks, chunk size, and accumulated cap", () => {
    const sender = new BinaryChunkSender({ maxBytes: 5, chunkBytes: 4 });
    expect(() => sender.beginChunk(0)).toThrow(/between 1 and 4/);
    expect(() => sender.beginChunk(5)).toThrow(/between 1 and 4/);
    sender.beginChunk(4);
    sender.acknowledge(0);
    expect(() => sender.beginChunk(2)).toThrow(/5-byte limit/);
    sender.beginChunk(1, { done: true });
    sender.acknowledge(1);
    expect(sender.totalBytes).toBe(5);
  });

  it("clears pending state and rejects work after abort", () => {
    const sender = new BinaryChunkSender({ maxBytes: 5 });
    sender.beginChunk(1);
    sender.abort();
    expect(sender.inFlight).toBeNull();
    expect(() => sender.acknowledge(0)).toThrow(/aborted/);
    expect(() => sender.beginChunk(1)).toThrow(/aborted/);
  });
});

describe("BinaryChunkReceiver", () => {
  it("pulls ordered chunks and verifies the exact declared length", () => {
    const receiver = new BinaryChunkReceiver({
      maxBytes: 10,
      expectedBytes: 6,
      chunkBytes: 4,
    });
    expect(receiver.requestChunk()).toEqual({ sequence: 0, maxBytes: 4 });
    expect(
      receiver.receiveChunk({ sequence: 0, byteLength: 4 })
    ).toEqual({
      acknowledge: 0,
      complete: false,
      totalBytes: 4,
    });
    expect(receiver.requestChunk()).toEqual({ sequence: 1, maxBytes: 2 });
    expect(
      receiver.receiveChunk({ sequence: 1, byteLength: 2, done: true })
    ).toEqual({
      acknowledge: 1,
      complete: true,
      totalBytes: 6,
    });
  });

  it("rejects unsolicited, duplicate, and out-of-order chunks", () => {
    const receiver = new BinaryChunkReceiver({ maxBytes: 10 });
    expect(() =>
      receiver.receiveChunk({ sequence: 0, byteLength: 1 })
    ).toThrow(/without a request/);
    receiver.requestChunk();
    expect(() => receiver.requestChunk()).toThrow(/already requested/);
    expect(() =>
      receiver.receiveChunk({ sequence: 1, byteLength: 1 })
    ).toThrow(/Expected sequence 0/);
    receiver.receiveChunk({ sequence: 0, byteLength: 1 });
    expect(() =>
      receiver.receiveChunk({ sequence: 0, byteLength: 1 })
    ).toThrow(/without a request/);
  });

  it("rejects early, late, and unmarked declared-length endings", () => {
    const early = new BinaryChunkReceiver({
      maxBytes: 10,
      expectedBytes: 4,
    });
    early.requestChunk();
    expect(() =>
      early.receiveChunk({ sequence: 0, byteLength: 3, done: true })
    ).toThrow(/ended at 3 bytes/);

    const late = new BinaryChunkReceiver({
      maxBytes: 10,
      expectedBytes: 4,
    });
    late.requestChunk();
    expect(() =>
      late.receiveChunk({ sequence: 0, byteLength: 5, done: true })
    ).toThrow(/declared 4-byte length/);

    const unmarked = new BinaryChunkReceiver({
      maxBytes: 10,
      expectedBytes: 4,
    });
    unmarked.requestChunk();
    expect(() =>
      unmarked.receiveChunk({ sequence: 0, byteLength: 4 })
    ).toThrow(/must be marked done/);
  });

  it("enforces the exact cap for unknown-length output", () => {
    const receiver = new BinaryChunkReceiver({
      maxBytes: 4,
      chunkBytes: 4,
    });
    receiver.requestChunk();
    expect(() =>
      receiver.receiveChunk({ sequence: 0, byteLength: 4 })
    ).toThrow(/reaching its byte limit/);

    const exact = new BinaryChunkReceiver({
      maxBytes: 4,
      chunkBytes: 4,
    });
    exact.requestChunk();
    expect(
      exact.receiveChunk({ sequence: 0, byteLength: 4, done: true })
    ).toMatchObject({ complete: true, totalBytes: 4 });
  });

  it("rejects an expected payload over cap before transfer", () => {
    expect(
      () => new BinaryChunkReceiver({ maxBytes: 4, expectedBytes: 5 })
    ).toThrow(/Expected payload exceeds/);
  });

  it("clears its outstanding request on abort", () => {
    const receiver = new BinaryChunkReceiver({ maxBytes: 4 });
    receiver.requestChunk();
    receiver.abort();
    expect(receiver.requestedSequence).toBeNull();
    expect(() =>
      receiver.receiveChunk({ sequence: 0, byteLength: 1 })
    ).toThrow(/aborted/);
  });
});

describe("runtime-port base64 chunks", () => {
  it("round-trips arbitrary bytes without Node APIs", () => {
    const input = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const encoded = encodeRuntimeBase64(input);
    expect([...decodeRuntimeBase64(encoded)]).toEqual([...input]);
  });

  it("handles the 256 KiB raw chunk boundary", () => {
    const input = new Uint8Array(256 * 1024);
    input[0] = 1;
    input[input.length - 1] = 255;
    const decoded = decodeRuntimeBase64(encodeRuntimeBase64(input));
    expect(decoded.byteLength).toBe(256 * 1024);
    expect(decoded[0]).toBe(1);
    expect(decoded[decoded.length - 1]).toBe(255);
  });

  it.each(["", "Zg", "Zg===", "Zm=v", "Zm9v\n"])(
    "rejects malformed base64 %s",
    (value) => {
      expect(() => decodeRuntimeBase64(value)).toThrow(BinaryTransferError);
    }
  );

  it("rejects empty, wrong-type, and oversized chunks", () => {
    expect(() => encodeRuntimeBase64(new Uint8Array())).toThrow(/non-empty/);
    expect(() => encodeRuntimeBase64([1, 2, 3])).toThrow(/Uint8Array/);
    expect(() => decodeRuntimeBase64("AA==", 0)).toThrow(/positive/);
    expect(() => decodeRuntimeBase64("AAEC", 2)).toThrow(/1 to 2 bytes/);
  });
});
