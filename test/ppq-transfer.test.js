import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { isPPQCompatEndpoint, ppqTransferModel, ppqTransferPreview } from "../src/ppq-transfer.js";
import {
  getSettings, saveSettings, saveCompatEndpoints, grantOriginAlways,
  grantOriginOperationAlways, setOriginLastUsed, transferPPQCompatEndpoint,
} from "../src/storage.js";

const mock = installChromeMock();
const endpoint = { id: "compat:ppq", name: "My PPQ", baseUrl: "https://api.ppq.ai/v1" };
const origin = "https://transfer.example";
const otherOrigin = "https://unrelated.example";
beforeEach(() => { mock.reset(); vi.restoreAllMocks(); });

async function setup(extra = {}) {
  await saveCompatEndpoints([endpoint, { id: "compat:other", name: "Other", baseUrl: "https://other.example/v1" }]);
  await saveSettings({ defaultProviderId: endpoint.id, defaultModel: "claude-sonnet-5.5", apiKeys: { [endpoint.id]: "private-source-key", openai: "unrelated-key" }, ...extra });
  return ppqTransferPreview(await getSettings(), endpoint.id);
}

describe("PPQ transfer detection", () => {
  it.each(["https://api.ppq.ai/v1", "https://api.ppq.ai/v1/", "https://API.PPQ.AI:443/v1"])("recognizes the official endpoint %s", (baseUrl) => {
    expect(isPPQCompatEndpoint({ ...endpoint, baseUrl })).toBe(true);
  });
  it.each(["https://api.ppq.ai.evil.example/v1", "https://evil.example/api.ppq.ai/v1", "http://api.ppq.ai/v1", "https://api.ppq.ai:444/v1", "https://api.ppq.ai/proxy/v1", "https://api.ppq.ai/v1?route=other", "https://user:password@api.ppq.ai/v1", "bad-url"])("rejects other destinations %s", (baseUrl) => {
    expect(isPPQCompatEndpoint({ ...endpoint, baseUrl })).toBe(false);
  });
  it("handles missing and malformed endpoint identities", () => {
    expect(isPPQCompatEndpoint(null)).toBe(false);
    expect(isPPQCompatEndpoint({ id: 4 })).toBe(false);
    expect(isPPQCompatEndpoint({ ...endpoint, id: "ppq" })).toBe(false);
  });
  it("removes only the search-enabling suffix and retains routing preferences", () => {
    expect(ppqTransferModel("model:ONLINE:nitro")).toBe("model:nitro");
    expect(ppqTransferModel("model:online:floor:online")).toBe("model:floor");
    expect(ppqTransferModel("model:thinking")).toBe("model:thinking");
    expect(ppqTransferModel(undefined)).toBe("auto");
  });
});

describe("explicit PPQ settings transfer", () => {
  it("copies key/model, switches the active source default, and removes only the old server in one write", async () => {
    const expected = await setup();
    const set = vi.spyOn(chrome.storage.local, "set");
    await transferPPQCompatEndpoint(endpoint.id, { expected });
    expect(set).toHaveBeenCalledTimes(1);
    const settings = await getSettings();
    expect(settings.apiKeys).toEqual({ ppq: "private-source-key", openai: "unrelated-key" });
    expect(settings.defaultProviderId).toBe("ppq");
    expect(settings.defaultModel).toBe("claude-sonnet-5.5");
    expect(settings.defaultModels[endpoint.id]).toBeUndefined();
    expect(settings.compatEndpoints.map((entry) => entry.id)).toEqual(["compat:other"]);
  });

  it("keeps another active default and its model unchanged", async () => {
    await setup();
    await saveSettings({ defaultProviderId: "openai", defaultModel: "gpt-6-luna" });
    const expected = ppqTransferPreview(await getSettings(), endpoint.id);
    await transferPPQCompatEndpoint(endpoint.id, { expected });
    const settings = await getSettings();
    expect(settings.defaultProviderId).toBe("openai");
    expect(settings.defaultModel).toBe("gpt-6-luna");
    expect(settings.defaultModels.ppq).toBe("claude-sonnet-5.5");
  });

  it("revokes old approvals, preserves per-site model prefills and unrelated permissions", async () => {
    await setup();
    await grantOriginAlways(origin, { providerId: endpoint.id, model: "site-model:online", toolFingerprint: "hosted:web_search|fn:weather", imageInput: true });
    await grantOriginAlways(otherOrigin, { providerId: "openai", model: "gpt-6-luna" });
    await grantOriginOperationAlways(origin, "decide", { providerId: "openai", model: "decision-model" });
    await setOriginLastUsed("https://last.example", { providerId: endpoint.id, model: "last-model" });
    await saveSettings({ operationDefaults: { synthesize: { providerId: "openai", model: "tts-1", voice: "alloy" } } });
    const before = await getSettings();
    await transferPPQCompatEndpoint(endpoint.id, { expected: ppqTransferPreview(before, endpoint.id) });
    const after = await getSettings();
    expect(after.allowedOrigins[origin]).toBeUndefined();
    expect(after.allowedOrigins[otherOrigin]).toEqual(before.allowedOrigins[otherOrigin]);
    expect(after.originLastUsed[origin]).toMatchObject({ providerId: "ppq", model: "site-model" });
    expect(after.originLastUsed[origin].toolFingerprint).toBeUndefined();
    expect(after.originLastUsed["https://last.example"]).toMatchObject({ providerId: "ppq", model: "last-model" });
    expect(after.operationGrants).toEqual(before.operationGrants);
    expect(after.operationDefaults).toEqual(before.operationDefaults);
    expect(after.blockedOrigins).toEqual(before.blockedOrigins);
  });

  it("does not overwrite a different existing last-used route while revoking a source grant", async () => {
    const expected = await setup();
    await grantOriginAlways(origin, { providerId: endpoint.id, model: "source-model" });
    await setOriginLastUsed(origin, { providerId: "openai", model: "gpt-6-luna" });
    await transferPPQCompatEndpoint(endpoint.id, { expected });
    expect((await getSettings()).originLastUsed[origin]).toMatchObject({ providerId: "openai", model: "gpt-6-luna" });
  });

  it("requires an explicit overwrite choice for existing PPQ settings", async () => {
    await setup();
    await saveSettings({ apiKeys: { ppq: "existing-key" }, defaultModels: { ppq: "existing-model" } });
    const before = await getSettings();
    const expected = ppqTransferPreview(before, endpoint.id);
    expect(expected.hasConflict).toBe(true);
    await expect(transferPPQCompatEndpoint(endpoint.id, { expected })).rejects.toThrow("replace");
    expect(await getSettings()).toEqual(before);
    await transferPPQCompatEndpoint(endpoint.id, { expected, replaceExisting: true });
    expect((await getSettings()).apiKeys.ppq).toBe("private-source-key");
  });

  it("requires an overwrite choice when a configured PPQ model is auto and the key is the same", async () => {
    await setup();
    await saveSettings({ apiKeys: { ppq: "private-source-key" }, defaultModels: { ppq: "auto" } });
    const expected = ppqTransferPreview(await getSettings(), endpoint.id);
    expect(expected.hasConflict).toBe(true);
    await expect(transferPPQCompatEndpoint(endpoint.id, { expected })).rejects.toThrow("replace");
  });

  it.each([
    { apiKeys: { ppq: "changed-target-key" } },
    { apiKeys: { [endpoint.id]: "changed-source-key" } },
    { defaultModels: { [endpoint.id]: "changed-source-model" } },
    { defaultModels: { ppq: "changed-target-model" } },
    { defaultProviderId: "openai" },
  ])("rejects stale previews without changing newer settings (%j)", async (patch) => {
    const expected = await setup();
    await saveSettings(patch);
    const before = await getSettings();
    await expect(transferPPQCompatEndpoint(endpoint.id, { expected, replaceExisting: true })).rejects.toThrow("Settings changed");
    expect(await getSettings()).toEqual(before);
  });

  it("keeps the complete old setup if the transfer write fails", async () => {
    const expected = await setup();
    await grantOriginAlways(origin, { providerId: endpoint.id, model: "auto" });
    const before = await getSettings();
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("private-source-key"));
    await expect(transferPPQCompatEndpoint(endpoint.id, { expected })).rejects.toThrow("Could not save");
    expect(await getSettings()).toEqual(before);
  });

  it("uses auto when no model is saved and previews removal of :online", async () => {
    await setup();
    await saveSettings({ defaultModels: { [endpoint.id]: "" } });
    let expected = ppqTransferPreview(await getSettings(), endpoint.id);
    expect(expected.model).toBe("auto");
    await saveSettings({ defaultModels: { [endpoint.id]: "model:online:nitro" } });
    expected = ppqTransferPreview(await getSettings(), endpoint.id);
    expect(expected.removedOnlineSuffix).toBe(true);
    await transferPPQCompatEndpoint(endpoint.id, { expected });
    expect((await getSettings()).defaultModels.ppq).toBe("model:nitro");
  });

  it("refuses missing keys and non-PPQ endpoints without removing anything", async () => {
    await setup();
    await saveSettings({ apiKeys: { [endpoint.id]: "" } });
    const before = await getSettings();
    await expect(transferPPQCompatEndpoint(endpoint.id, { expected: ppqTransferPreview(before, endpoint.id) })).rejects.toThrow("Save an API key");
    await expect(transferPPQCompatEndpoint("compat:other")).rejects.toThrow("not the official");
    expect(await getSettings()).toEqual(before);
  });
});
