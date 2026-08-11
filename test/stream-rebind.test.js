import { describe, expect, it } from "vitest";
import {
  canAcceptRebind,
  canAcceptStartedAck,
  decidePortDisconnect,
} from "../src/stream-rebind.js";

/** @returns {{ port: object, tabId: number, phase: "awaiting_permission", announced: boolean }} */
function awaitingEntry(overrides = {}) {
  return {
    port: { id: "port-a" },
    tabId: 42,
    phase: "awaiting_permission",
    announced: false,
    ...overrides,
  };
}

describe("decidePortDisconnect", () => {
  it("soft-holds while awaiting permission and announced", () => {
    const port = { id: "port-a" };
    const entry = awaitingEntry({ port, announced: true });
    expect(decidePortDisconnect(entry, port)).toBe("soft_hold");
  });

  it("aborts when disconnect happens before started-ack (announced false)", () => {
    const port = { id: "port-a" };
    const entry = awaitingEntry({ port, announced: false });
    expect(decidePortDisconnect(entry, port)).toBe("abort");
  });

  it("aborts when phase is not awaiting_permission", () => {
    const port = { id: "port-a" };
    const entry = awaitingEntry({
      port,
      phase: "streaming",
      announced: true,
    });
    expect(decidePortDisconnect(entry, port)).toBe("abort");
  });

  it("aborts when the stream entry is missing", () => {
    expect(decidePortDisconnect(undefined, { id: "port-a" })).toBe("abort");
    expect(decidePortDisconnect(null, { id: "port-a" })).toBe("abort");
  });

  it("ignores a superseded port disconnect after successful rebind", () => {
    const livePort = { id: "port-b" };
    const oldPort = { id: "port-a" };
    const entry = awaitingEntry({
      port: livePort,
      announced: true,
    });
    // Must not soft-hold on the old port — that would flip portDisconnected
    // again and Approve would wait forever.
    expect(decidePortDisconnect(entry, oldPort)).toBe("ignore");
  });
});

describe("canAcceptRebind", () => {
  it("accepts rebind from the same tab while awaiting permission", () => {
    const entry = awaitingEntry({ tabId: 7 });
    expect(canAcceptRebind(entry, 7)).toBe(true);
  });

  it("rejects rebind from a different tab", () => {
    const entry = awaitingEntry({ tabId: 7 });
    expect(canAcceptRebind(entry, 99)).toBe(false);
  });

  it("rejects rebind when phase is not awaiting_permission", () => {
    const entry = awaitingEntry({ phase: "streaming", tabId: 7 });
    expect(canAcceptRebind(entry, 7)).toBe(false);
  });

  it("rejects rebind when the stream entry is missing", () => {
    expect(canAcceptRebind(undefined, 7)).toBe(false);
    expect(canAcceptRebind(null, 7)).toBe(false);
  });

  it("rejects rebind when either tab id is nullish", () => {
    expect(canAcceptRebind(awaitingEntry({ tabId: undefined }), 7)).toBe(
      false
    );
    expect(canAcceptRebind(awaitingEntry({ tabId: 7 }), null)).toBe(false);
    expect(canAcceptRebind(awaitingEntry({ tabId: 7 }), undefined)).toBe(
      false
    );
  });
});

describe("canAcceptStartedAck", () => {
  it("accepts started-ack for the matching port while awaiting permission", () => {
    const port = { id: "port-a" };
    const entry = awaitingEntry({ port });
    expect(canAcceptStartedAck(entry, port)).toBe(true);
  });

  it("rejects started-ack from a different port", () => {
    const entry = awaitingEntry({ port: { id: "port-a" } });
    expect(canAcceptStartedAck(entry, { id: "port-b" })).toBe(false);
  });

  it("rejects started-ack when phase is not awaiting_permission", () => {
    const port = { id: "port-a" };
    const entry = awaitingEntry({ port, phase: "streaming" });
    expect(canAcceptStartedAck(entry, port)).toBe(false);
  });

  it("rejects started-ack when the stream entry is missing", () => {
    expect(canAcceptStartedAck(undefined, { id: "port-a" })).toBe(false);
    expect(canAcceptStartedAck(null, { id: "port-a" })).toBe(false);
  });
});
