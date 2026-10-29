import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { MAX_LAST_USED_ORIGINS, pruneLastUsed } from "../src/storage-retention.js";
import { SettingsStorageError } from "../src/storage-errors.js";
import * as storage from "../src/storage.js";

const mock = installChromeMock();
const route = { providerId: "openai", model: "gpt-5-nano" };
const origin = (i) => `https://site-${i}.example`;
function routes(count = MAX_LAST_USED_ORIGINS + 2) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [origin(i), { ...route, usedAt: i + 1 }]));
}

beforeEach(() => mock.reset());
afterEach(() => vi.restoreAllMocks());

describe("last-used retention", () => {
  it("prunes existing caches on read, leaving grants, blocks and preferences intact", async () => {
    mock.store.set("originLastUsed", routes());
    mock.store.set("operationLastUsed", Object.fromEntries(Object.entries(routes()).map(
      ([key, value]) => [key, {
        decide: value,
        transcribe: value,
        synthesize: { providerId: value.providerId, model: value.model, voice: "alloy", usedAt: value.usedAt },
      }]
    )));
    const grants = Object.fromEntries(Object.keys(routes()).map((key) => [key, { ...route, allowedAt: 1, imageInput: true }]));
    const blocks = { "https://blocked.example": { blockedAt: 1 } };
    const operations = { [origin(0)]: { decide: { ...route, allowedAt: 1 } } };
    mock.store.set("allowedOrigins", grants);
    mock.store.set("blockedOrigins", blocks);
    mock.store.set("operationGrants", operations);
    mock.store.set("originChatReasoningEfforts", { [origin(0)]: "high" });
    const write = vi.spyOn(chrome.storage.local, "set");
    const result = await storage.getSettings();
    for (const map of [result.originLastUsed, result.operationLastUsed]) {
      expect(Object.keys(map)).toHaveLength(MAX_LAST_USED_ORIGINS);
      expect(map[origin(0)]).toBeUndefined();
      expect(map[origin(1)]).toBeUndefined();
      expect(map[origin(MAX_LAST_USED_ORIGINS + 1)]).toBeDefined();
    }
    expect(result.allowedOrigins).toEqual(grants);
    expect(result.operationGrants).toEqual(operations);
    expect(result.blockedOrigins).toEqual(blocks);
    expect(result.originChatReasoningEfforts).toEqual({ [origin(0)]: "high" });
    expect(mock.store.get("originLastUsed")).toEqual(result.originLastUsed);
    expect(mock.store.get("operationLastUsed")).toEqual(result.operationLastUsed);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      originLastUsed: result.originLastUsed,
      operationLastUsed: result.operationLastUsed,
    });
    await storage.getSettings();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("ranks operation origins by their latest operation and retains their other routes", () => {
    const entries = Object.fromEntries(Object.entries(routes()).map(
      ([key, value]) => [key, { transcribe: value }]
    ));
    entries[origin(0)].synthesize = { ...route, voice: "alloy", usedAt: 10_000 };
    expect(pruneLastUsed(entries, true)).toBe(true);
    expect(entries[origin(0)]).toHaveProperty("transcribe");
    expect(entries[origin(0)]).toHaveProperty("synthesize");
    expect(entries[origin(1)]).toBeUndefined();
    expect(entries[origin(2)]).toBeUndefined();
  });

  it("handles missing timestamps and breaks ties consistently", () => {
    const entries = routes();
    entries[origin(0)].usedAt = NaN;
    delete entries[origin(1)].usedAt;
    pruneLastUsed(entries);
    expect(entries[origin(0)]).toBeUndefined();
    expect(entries[origin(1)]).toBeUndefined();
    const tied = Object.fromEntries(Object.keys(routes()).reverse().map((key) => [key, { usedAt: 1 }]));
    const expected = Object.keys(tied).sort((a, b) => a.localeCompare(b)).slice(0, MAX_LAST_USED_ORIGINS);
    pruneLastUsed(tied);
    expect(Object.keys(tied).sort((a, b) => a.localeCompare(b))).toEqual(expected);
  });

  it.each(["chat", "transcribe"])("caps %s choices immediately on write", async (operation) => {
    const key = operation === "chat" ? "originLastUsed" : "operationLastUsed";
    const entries = routes(MAX_LAST_USED_ORIGINS);
    mock.store.set(key, operation === "chat" ? entries : Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, { transcribe: value }])
    ));
    if (operation === "chat") await storage.setOriginLastUsed("https://new.example", route);
    else await storage.setOriginOperationLastUsed("https://new.example", operation, route);
    const persisted = mock.store.get(key);
    expect(Object.keys(persisted)).toHaveLength(MAX_LAST_USED_ORIGINS);
    expect(persisted[origin(0)]).toBeUndefined();
    expect(persisted["https://new.example"]).toBeDefined();
  });

  it.each(["chat", "transcribe"])("caps %s choices in a combined approval write", async (operation) => {
    const entries = routes(MAX_LAST_USED_ORIGINS);
    const key = operation === "chat" ? "originLastUsed" : "operationLastUsed";
    mock.store.set(key, operation === "chat" ? entries : Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, { transcribe: value }])
    ));
    const write = vi.spyOn(chrome.storage.local, "set");
    await storage.saveApprovalChoice("https://new.example", {
      ...route, always: true, ...(operation === "chat" ? {} : { operation }),
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(mock.store.get(key))).toHaveLength(MAX_LAST_USED_ORIGINS);
    expect(mock.store.get(key)[origin(0)]).toBeUndefined();
    const settings = await storage.getSettings();
    if (operation === "chat") expect(settings.allowedOrigins["https://new.example"]).toMatchObject(route);
    else expect(settings.operationGrants["https://new.example"].transcribe).toMatchObject(route);
  });
});

describe("storage failures", () => {
  it("maps persistence failures to the unavailable inference code", () => {
    expect(new SettingsStorageError()).toMatchObject({
      name: "SettingsStorageError",
      code: "unavailable",
    });
  });

  it.each([
    () => storage.saveSettings({ defaultModel: "gpt-6-luna" }),
    () => storage.revokeOrigin(origin(0)),
    () => storage.unblockOrigin("https://blocked.example"),
    () => storage.saveCompatEndpoints([{ id: "compat:local", name: "Local", baseUrl: "http://localhost:1234" }]),
  ])("reports write failure and leaves saved state available for retry", async (action) => {
    await storage.grantOriginAlways(origin(0), route);
    await storage.blockOrigin("https://blocked.example");
    const before = structuredClone([...mock.store]);
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("QUOTA_BYTES: secret-value"));
    await expect(action()).rejects.toBeInstanceOf(SettingsStorageError);
    expect([...mock.store]).toEqual(before);
    await action(); // The shared lock is released after failure, so a retry can save.
  });

  it("keeps reads available when persisting a last-used prune fails", async () => {
    mock.store.set("originLastUsed", routes());
    await storage.grantOriginAlways(origin(0), route);
    mock.store.set("originLastUsed", routes());
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("disk unavailable"));
    const result = await storage.getSettings();
    expect(Object.keys(result.originLastUsed)).toHaveLength(MAX_LAST_USED_ORIGINS);
    expect(result.allowedOrigins[origin(0)]).toMatchObject(route);
    expect(Object.keys(mock.store.get("originLastUsed"))).toHaveLength(MAX_LAST_USED_ORIGINS + 2);
    expect((await storage.getSettings()).allowedOrigins[origin(0)]).toMatchObject(route);
    expect(Object.keys(mock.store.get("originLastUsed"))).toHaveLength(MAX_LAST_USED_ORIGINS);
  });

  it("reports failed legacy cleanup and safely retries after a successful migration write", async () => {
    mock.store.set("openaiApiKey", "test-key");
    vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(storage.getSettings()).rejects.toBeInstanceOf(SettingsStorageError);
    expect(mock.store.get("apiKeys")).toEqual({ openai: "test-key" });
    expect((await storage.getSettings()).apiKeys).toEqual({ openai: "test-key" });
    expect(mock.store.has("openaiApiKey")).toBe(false);
  });
});
