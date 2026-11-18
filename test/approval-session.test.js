import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_FETCH_ATTEMPTS,
  APPROVAL_FETCH_DELAY_MS,
  APPROVAL_REQUEST_ID_KEY,
  fetchPendingApprovalRequest,
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

describe("fetchPendingApprovalRequest", () => {
  it("defaults to a multi-second pre-bind poll window", () => {
    expect((APPROVAL_FETCH_ATTEMPTS - 1) * APPROVAL_FETCH_DELAY_MS).toBeGreaterThanOrEqual(2_000);
  });

  it("returns on the first successful response without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => ({ request: { origin: "https://app.example" } }));
    await expect(fetchPendingApprovalRequest("stream_1", sendMessage, { sleep }))
      .resolves.toEqual({ origin: "https://app.example" });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries briefly until the pending request is bound", async () => {
    const sleep = vi.fn(async () => {});
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ request: null })
      .mockResolvedValueOnce({ request: null })
      .mockResolvedValueOnce({ request: { origin: "https://app.example" } });
    await expect(fetchPendingApprovalRequest("stream_1", sendMessage, {
      attempts: 5,
      delayMs: 10,
      sleep,
    })).resolves.toEqual({ origin: "https://app.example" });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("returns null after exhausting attempts", async () => {
    const sleep = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => ({ request: null }));
    await expect(fetchPendingApprovalRequest("stream_1", sendMessage, {
      attempts: 3,
      delayMs: 5,
      sleep,
    })).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
