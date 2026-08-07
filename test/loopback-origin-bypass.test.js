import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  isLoopbackHostname,
  loopbackBypassRuleId,
  ensureLoopbackOriginBypass,
} from "../src/loopback-origin-bypass.js";
import {
  ensureOllamaOriginBypass,
  resetOllamaOriginBypassMemoForTests,
} from "../src/ollama-origin-bypass.js";

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
  resetOllamaOriginBypassMemoForTests();
  vi.restoreAllMocks();
});

describe("isLoopbackHostname", () => {
  it("accepts localhost, 127.0.0.1, and ::1", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("10.0.0.1")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("loopbackBypassRuleId", () => {
  it("returns a stable integer outside the reserved Ollama ids", () => {
    const a = loopbackBypassRuleId("127.0.0.1", 1234);
    const b = loopbackBypassRuleId("127.0.0.1", 1234);
    const c = loopbackBypassRuleId("localhost", 1234);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(11434);
    expect(a).not.toBe(11435);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(1);
  });
});

describe("ensureLoopbackOriginBypass", () => {
  it("installs a DNR rule that strips origin and referer for the host:port", async () => {
    const update = vi.fn(async () => {});
    globalThis.chrome.declarativeNetRequest.updateDynamicRules = update;

    await ensureLoopbackOriginBypass("127.0.0.1", 1234);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    const ruleId = loopbackBypassRuleId("127.0.0.1", 1234);
    expect(arg.removeRuleIds).toEqual([ruleId]);
    expect(arg.addRules).toHaveLength(1);
    expect(arg.addRules[0]).toMatchObject({
      id: ruleId,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "remove" },
          { header: "referer", operation: "remove" },
        ],
      },
      condition: {
        urlFilter: "||127.0.0.1:1234^",
        resourceTypes: ["xmlhttprequest", "other"],
      },
    });
  });

  it("uses bracketed IPv6 host in the urlFilter", async () => {
    const update = vi.fn(async () => {});
    globalThis.chrome.declarativeNetRequest.updateDynamicRules = update;

    await ensureLoopbackOriginBypass("::1", 1234);

    expect(update).toHaveBeenCalledTimes(1);
    const rule = update.mock.calls[0][0].addRules[0];
    expect(rule.condition.urlFilter).toBe("||[::1]:1234^");
  });

  it("no-ops for non-loopback hosts", async () => {
    const update = vi.fn(async () => {});
    globalThis.chrome.declarativeNetRequest.updateDynamicRules = update;
    await ensureLoopbackOriginBypass("example.com", 443);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ensureOllamaOriginBypass", () => {
  it("still installs reserved rules for localhost and 127.0.0.1 on 11434", async () => {
    const update = vi.fn(async () => {});
    globalThis.chrome.declarativeNetRequest.updateDynamicRules = update;

    await ensureOllamaOriginBypass();

    expect(update).toHaveBeenCalled();
    const arg = update.mock.calls[0][0];
    expect(arg.removeRuleIds).toEqual(expect.arrayContaining([11434, 11435]));
    expect(arg.addRules.map((r) => r.id).sort()).toEqual([11434, 11435]);
  });
});
