import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { ensurePermission, ensureOperationPermission, getPendingApproval, resolveApproval, clearToolEpisodes } from "../src/permissions.js";
import { getSettings, saveSettings, setOriginChatReasoningEffort, grantOriginAlways } from "../src/storage.js";
import { SettingsStorageError } from "../src/storage-errors.js";

const mock = installChromeMock();
const origin = "https://app.example";
const route = { providerId: "openai", model: "gpt-5-nano" };

beforeEach(() => { mock.reset(); clearToolEpisodes(); });
afterEach(() => vi.restoreAllMocks());

async function start(method) {
  const requestId = `failure-${method}`;
  const operationRoute = { ...route, ...(method === "synthesize" ? { voice: "alloy" } : {}) };
  if (method !== "chat") await saveSettings({ operationDefaults: { [method]: operationRoute } });
  const pending = method === "chat"
    ? ensurePermission({ requestId, origin, messages: [{ role: "user", content: "Hello" }] })
    : ensureOperationPermission({ requestId, origin, method });
  // Attach the rejection handler before inducing a failure.
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
  await vi.waitFor(() => expect(getPendingApproval(requestId)).not.toBeNull());
  return { requestId, outcome, operationRoute };
}

describe.each(["chat", "decide", "transcribe", "synthesize"])("%s approval persistence", (method) => {
  it.each(["allow_once", "always", "never"])("reports a failed %s to the popup and fails the page request", async (decision) => {
    await setOriginChatReasoningEffort(origin, "low");
    const { requestId, outcome, operationRoute } = await start(method);
    const before = structuredClone([...mock.store]);
    const write = vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("quota failure with secret-value"));
    const response = await resolveApproval(requestId, {
      decision, ...operationRoute, chatReasoningEffort: "high",
    });
    expect(response).toEqual({ ok: false, error: expect.stringContaining("Storage may be full or unavailable") });
    expect(response.error).not.toContain("secret-value");
    expect((await outcome).error).toBeInstanceOf(SettingsStorageError);
    expect([...mock.store]).toEqual(before);
    expect(write).toHaveBeenCalledTimes(1);
    expect(getPendingApproval(requestId)).toBeNull();
  });

  it("acknowledges Always allow only after the complete choice is saved", async () => {
    const { requestId, outcome, operationRoute } = await start(method);
    const originalSet = chrome.storage.local.set;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const write = vi.spyOn(chrome.storage.local, "set").mockImplementationOnce(async (patch) => {
      await gate;
      return originalSet(patch);
    });
    let acknowledged = false;
    const response = resolveApproval(requestId, {
      decision: "always", ...operationRoute, chatReasoningEffort: "high",
    }).then((result) => { acknowledged = true; return result; });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(acknowledged).toBe(false);
    expect(mock.store.get("allowedOrigins")?.[origin]).toBeUndefined();
    expect(mock.store.get("operationGrants")?.[origin]).toBeUndefined();
    release();
    expect(await response).toEqual({ ok: true });
    expect((await outcome).value).toMatchObject({ allowed: true, once: false });
    expect(write).toHaveBeenCalledTimes(1);
    const settings = await getSettings();
    if (method === "chat") {
      expect(settings.allowedOrigins[origin]).toMatchObject(route);
      expect(settings.originLastUsed[origin]).toMatchObject(route);
      expect(settings.originChatReasoningEfforts[origin]).toBe("high");
    } else {
      expect(settings.operationGrants[origin][method]).toMatchObject(operationRoute);
      expect(settings.operationLastUsed[origin][method]).toMatchObject(operationRoute);
      expect(settings.originChatReasoningEfforts).toEqual({});
    }
  });
});

it("keeps an existing grant when Never allow cannot be saved", async () => {
  const { requestId, outcome } = await start("chat");
  await grantOriginAlways(origin, route);
  vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("disk unavailable"));
  expect(await resolveApproval(requestId, { decision: "never", ...route })).toMatchObject({ ok: false });
  expect((await outcome).error).toBeInstanceOf(SettingsStorageError);
  const settings = await getSettings();
  expect(settings.allowedOrigins[origin]).toMatchObject(route);
  expect(settings.blockedOrigins).toEqual({});
});
