import { describe, expect, it } from "vitest";
import {
  APPROVAL_REQUEST_ID_KEY,
  resolveApprovalRequestId,
} from "../src/approval-session.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    _data: data,
  };
}

describe("resolveApprovalRequestId", () => {
  it("prefers the query param and remembers it for reloads without the query", () => {
    const storage = memoryStorage();
    expect(resolveApprovalRequestId("?requestId=stream_1", storage)).toBe("stream_1");
    expect(storage._data[APPROVAL_REQUEST_ID_KEY]).toBe("stream_1");
    expect(resolveApprovalRequestId("", storage)).toBe("stream_1");
    expect(resolveApprovalRequestId("?", storage)).toBe("stream_1");
  });

  it("returns null when neither the query nor storage has an id", () => {
    expect(resolveApprovalRequestId("", memoryStorage())).toBeNull();
    expect(resolveApprovalRequestId("?other=1", memoryStorage())).toBeNull();
  });

  it("still returns the query id when storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(resolveApprovalRequestId("?requestId=stream_2", storage)).toBe("stream_2");
  });
});
