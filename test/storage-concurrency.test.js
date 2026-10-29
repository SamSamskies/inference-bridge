import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";

const chromeMock = installChromeMock();
const first = "https://first.example";
const second = "https://second.example";
const route = { providerId: "openai", model: "gpt-5-nano" };
let worker;
let options;

beforeEach(async () => {
  chromeMock.reset();
  // Separate module instances model the worker and Options page: module-local
  // queues cannot coordinate them, but they share browser storage and locks.
  vi.resetModules();
  worker = await import("../src/storage.js");
  vi.resetModules();
  options = await import("../src/storage.js");
});

afterEach(() => { vi.restoreAllMocks(); });

// Pause after taking a storage snapshot. Without cross-context coordination,
// another context can finish a change before this stale snapshot is written.
async function overlapRead(startPaused, startOther) {
  let resume;
  let notifyRead;
  const paused = new Promise((resolve) => { notifyRead = resolve; });
  const released = new Promise((resolve) => { resume = resolve; });
  const originalGet = chrome.storage.local.get;
  let nextRead = true;
  chrome.storage.local.get = async (...args) => {
    const snapshot = await originalGet(...args);
    if (nextRead) {
      nextRead = false;
      notifyRead();
      await released;
    }
    return snapshot;
  };
  try {
    const pending = startPaused();
    await paused;
    const other = startOther();
    // Drain the other operation's microtasks if it was allowed to run.
    await new Promise(setImmediate);
    resume();
    return await Promise.all([pending, other]);
  } finally {
    resume();
    chrome.storage.local.get = originalGet;
  }
}

describe("settings updates across extension contexts", () => {
  it("keeps concurrent grants for different origins", async () => {
    await overlapRead(
      () => worker.grantOriginAlways(first, route),
      () => options.grantOriginAlways(second, route)
    );
    expect(Object.keys((await options.getSettings()).allowedOrigins).sort())
      .toEqual([first, second]);
  });

  it("keeps complete approval choices from concurrent contexts", async () => {
    await overlapRead(
      () => worker.saveApprovalChoice(first, { ...route, always: true, chatReasoningEffort: "high" }),
      () => options.saveApprovalChoice(second, { ...route, always: true, operation: "decide" })
    );
    const settings = await options.getSettings();
    expect(settings.allowedOrigins[first]).toMatchObject(route);
    expect(settings.originLastUsed[first]).toMatchObject(route);
    expect(settings.originChatReasoningEfforts[first]).toBe("high");
    expect(settings.operationGrants[second].decide).toMatchObject(route);
    expect(settings.operationLastUsed[second].decide).toMatchObject(route);
  });

  it("does not restore a revoked grant while pruning a cache in another context", async () => {
    await worker.grantOriginAlways(first, route);
    chromeMock.store.set("originLastUsed", Object.fromEntries(Array.from(
      { length: 501 }, (_, i) => [`https://site-${i}.example`, { ...route, usedAt: i }]
    )));
    await overlapRead(
      () => options.getSettings(),
      () => worker.revokeOrigin(first)
    );
    const settings = await options.getSettings();
    expect(settings.allowedOrigins).toEqual({});
    expect(Object.keys(settings.originLastUsed)).toHaveLength(500);
  });

  it("does not restore a revoked origin with a stale unrelated grant", async () => {
    await options.grantOriginAlways(first, route);
    await overlapRead(
      () => worker.grantOriginAlways(second, route),
      () => options.revokeOrigin(first)
    );
    expect((await worker.getSettings()).allowedOrigins).toEqual({
      [second]: expect.objectContaining(route),
    });
  });

  it("does not recreate a revoked grant when a route edit is queued after it", async () => {
    await worker.grantOriginAlways(first, route);
    const results = await overlapRead(
      () => options.revokeOrigin(first),
      () => worker.setOriginProviderModel(first, { ...route, model: "gpt-6-luna" })
    );
    expect(results[1]).toBe(false);
    expect((await options.getSettings()).allowedOrigins).toEqual({});
  });

  it("does not restore cleared scope when a route edit overlaps", async () => {
    await worker.grantOriginAlways(first, {
      ...route, toolFingerprint: "fn:weather", imageInput: true,
    });
    await overlapRead(
      () => options.setOriginProviderModel(first, { ...route, model: "gpt-6-luna" }),
      () => worker.clearOriginToolsScope(first)
    );
    expect((await options.getSettings()).allowedOrigins[first]).toEqual({
      ...route, model: "gpt-6-luna", allowedAt: expect.any(Number), imageInput: true,
    });
  });

  it("keeps operation edits without restoring a revoked operation", async () => {
    await worker.grantOriginOperationAlways(first, "transcribe", route);
    await worker.grantOriginOperationAlways(first, "synthesize", { ...route, voice: "alloy" });
    await overlapRead(
      () => options.setOriginOperationRoute(first, "synthesize", { ...route, voice: "coral" }),
      () => worker.revokeOriginOperation(first, "transcribe")
    );
    expect((await options.getSettings()).operationGrants[first]).toEqual({
      synthesize: { ...route, voice: "coral", allowedAt: expect.any(Number) },
    });
  });

  it("keeps a block while granting another origin", async () => {
    await worker.grantOriginAlways(first, route);
    await worker.grantOriginOperationAlways(first, "transcribe", route);
    await overlapRead(
      () => worker.grantOriginAlways(second, route),
      () => options.blockOrigin(first)
    );
    const settings = await options.getSettings();
    expect(settings.allowedOrigins).toEqual({ [second]: expect.objectContaining(route) });
    expect(settings.blockedOrigins[first]).toBeDefined();
    expect(settings.operationGrants[first]).toBeUndefined();
  });

  it("revokes every site grant without losing a concurrent approval for another site", async () => {
    await worker.grantOriginAlways(first, { ...route, imageInput: true, toolFingerprint: "fn:weather" });
    await worker.grantOriginOperationAlways(first, "decide", route);
    await overlapRead(
      () => options.revokeAllOriginAccess(first),
      () => worker.saveApprovalChoice(second, { ...route, operation: "synthesize", voice: "alloy", always: true })
    );
    const settings = await options.getSettings();
    expect(settings.allowedOrigins).toEqual({});
    expect(settings.operationGrants).toEqual({
      [second]: { synthesize: { ...route, voice: "alloy", allowedAt: expect.any(Number) } },
    });
  });

  it("merges concurrent provider and operation defaults", async () => {
    await overlapRead(
      () => worker.saveSettings({ apiKeys: { openai: "first-key" }, operationDefaults: { transcribe: route } }),
      () => options.saveSettings({ apiKeys: { openrouter: "second-key" }, operationDefaults: { decide: route } })
    );
    const settings = await options.getSettings();
    expect(settings.apiKeys).toEqual({ openai: "first-key", openrouter: "second-key" });
    expect(settings.operationDefaults).toEqual({ transcribe: route, decide: route });
  });

  it("coordinates migration writes with revocations and unrelated saves", async () => {
    await worker.grantOriginAlways(first, route);
    chromeMock.store.set("openaiApiKey", "legacy-key");
    await overlapRead(
      () => options.getSettings(),
      async () => {
        await worker.revokeOrigin(first);
        await worker.saveSettings({ apiKeys: { openrouter: "new-key" } });
      }
    );
    const settings = await worker.getSettings();
    expect(settings.allowedOrigins).toEqual({});
    expect(settings.apiKeys).toEqual({ openai: "legacy-key", openrouter: "new-key" });
    expect(chromeMock.store.has("openaiApiKey")).toBe(false);
  });

  it("does not undo endpoint cleanup with a stale grant update", async () => {
    await options.saveCompatEndpoints([
      { id: "compat:local", name: "Local", baseUrl: "http://localhost:1234/v1" },
    ]);
    await worker.grantOriginAlways(first, { providerId: "compat:local", model: "local" });
    await overlapRead(
      () => worker.grantOriginAlways(second, route),
      () => options.saveCompatEndpoints([])
    );
    // Check raw persistence before a later read gets a chance to scrub it.
    expect(chromeMock.store.get("allowedOrigins")).toEqual({
      [second]: expect.objectContaining(route),
    });
    expect((await worker.getSettings()).compatEndpoints).toEqual([]);
  });

  it("keeps last-used and reasoning choices for concurrent origins", async () => {
    await overlapRead(
      () => worker.setOriginLastUsed(first, route),
      () => options.setOriginLastUsed(second, route)
    );
    await overlapRead(
      () => worker.setOriginOperationLastUsed(first, "transcribe", route),
      () => options.setOriginOperationLastUsed(second, "decide", route)
    );
    await overlapRead(
      () => worker.setOriginChatReasoningEffort(first, "high"),
      () => options.setOriginChatReasoningEffort(second, "low")
    );
    const settings = await options.getSettings();
    expect(Object.keys(settings.originLastUsed).sort()).toEqual([first, second]);
    expect(Object.keys(settings.operationLastUsed).sort()).toEqual([first, second]);
    expect(settings.originChatReasoningEfforts).toEqual({ [first]: "high", [second]: "low" });
  });

  it("releases the lock on a storage failure so queued changes can finish", async () => {
    const failure = new Error("storage write failed");
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      worker.grantOriginAlways(first, route),
      options.grantOriginAlways(second, route),
    ]);
    expect(results[0]).toEqual({ status: "rejected", reason: expect.objectContaining({
      name: "SettingsStorageError", message: expect.stringContaining("Storage may be full or unavailable"),
    }) });
    expect(results[1].status).toBe("fulfilled");
    expect((await worker.getSettings()).allowedOrigins).toEqual({
      [second]: expect.objectContaining(route),
    });
  });

  it("retries interrupted migration cleanup in a fresh context", async () => {
    chromeMock.store.set("openaiApiKey", "legacy-key");
    vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(worker.getSettings()).rejects.toThrow("Storage may be full or unavailable");
    vi.resetModules();
    const restartedWorker = await import("../src/storage.js");
    await restartedWorker.saveSettings({ apiKeys: { openrouter: "new-key" } });
    expect((await restartedWorker.getSettings()).apiKeys).toEqual({
      openai: "legacy-key", openrouter: "new-key",
    });
    expect(chromeMock.store.has("openaiApiKey")).toBe(false);
  });

  it("rejects access without browser coordination instead of writing unlocked", async () => {
    const locks = navigator.locks;
    try {
      navigator.locks = undefined;
      await expect(worker.grantOriginAlways(first, route)).rejects.toThrow("Web Locks API");
      expect(chromeMock.store.size).toBe(0);
    } finally {
      navigator.locks = locks;
    }
  });
});
