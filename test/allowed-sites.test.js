import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { groupAllowedSites } from "../ui/allowed-sites.js";
import {
  blockOrigin,
  clearOriginImageScope,
  clearOriginToolsScope,
  getSettings,
  grantOriginAlways,
  grantOriginOperationAlways,
  revokeAllOriginAccess,
  revokeOrigin,
  revokeOriginOperation,
  saveApprovalChoice,
} from "../src/storage.js";

const chromeMock = installChromeMock();
const origin = "https://app.example";
const chat = {
  providerId: "openai", model: "gpt-6-luna", toolFingerprint: "fn:weather",
  toolChoiceNone: true, imageInput: true, imageOutput: true,
};
const routes = {
  transcribe: { providerId: "openai", model: "whisper-1" },
  synthesize: { providerId: "openai", model: "tts-1", voice: "alloy" },
  decide: { providerId: "openrouter", model: "typesafe/jev" },
};

beforeEach(() => {
  vi.restoreAllMocks();
  chromeMock.reset();
});

async function grantMixedSite(site = origin) {
  await saveApprovalChoice(site, { ...chat, always: true, chatReasoningEffort: "high" });
  for (const [operation, route] of Object.entries(routes)) {
    await saveApprovalChoice(site, { ...route, operation, always: true });
  }
}

const sites = async () => groupAllowedSites(await getSettings());

describe("Allowed sites", () => {
  it("preserves legacy OpenAI defaults and unknown provider bindings without adding capabilities", async () => {
    chromeMock.store.set("allowedOrigins", {
      [origin]: { model: "gpt-5-nano", allowedAt: 1 },
      "https://unknown.example": { providerId: "retired", model: "saved-model", allowedAt: 2 },
    });
    expect(await sites()).toMatchObject([
      { origin, chat: { providerId: "openai", model: "gpt-5-nano" }, capabilities: ["Chat"], operations: [] },
      { origin: "https://unknown.example", chat: { providerId: "retired", model: "saved-model" }, capabilities: ["Chat"], operations: [] },
    ]);
  });

  it("groups mixed grants once and includes operation-only sites by exact origin", async () => {
    await grantMixedSite();
    await grantOriginAlways("https://chat.example", chat);
    await grantOriginOperationAlways(`${origin}:8443`, "transcribe", routes.transcribe);
    await grantOriginOperationAlways("https://decisions.example", "decide", routes.decide);
    await grantOriginOperationAlways("https://speech.example", "synthesize", routes.synthesize);
    const settings = await getSettings();
    const before = structuredClone(settings);
    const grouped = groupAllowedSites(settings);
    expect(grouped.map((site) => site.origin)).toEqual([
      origin, `${origin}:8443`, "https://chat.example", "https://decisions.example", "https://speech.example",
    ]);
    expect(grouped[0]).toMatchObject({
      chat: { ...chat, origin },
      capabilities: ["Chat", "Transcription", "Synthesis", "Decisions"],
    });
    expect(grouped[0].operations).toEqual(Object.entries(routes).map(([operation, route]) =>
      expect.objectContaining({ ...route, origin, operation })
    ));
    expect(grouped[1]).toMatchObject({ chat: null, capabilities: ["Transcription"] });
    expect(grouped[2]).toMatchObject({ capabilities: ["Chat"], operations: [] });
    expect(grouped[3]).toMatchObject({ chat: null, capabilities: ["Decisions"] });
    expect(grouped[4]).toMatchObject({ chat: null, capabilities: ["Synthesis"] });
    expect(settings).toEqual(before);
  });

  it("preserves unrelated grants as scopes and individual capabilities are revoked", async () => {
    await grantMixedSite();
    const before = await getSettings();
    await clearOriginToolsScope(origin);
    let settings = await getSettings();
    expect(settings.allowedOrigins[origin]).not.toHaveProperty("toolFingerprint");
    expect(settings.allowedOrigins[origin]).not.toHaveProperty("toolChoiceNone");
    expect(settings.allowedOrigins[origin].imageInput).toBe(true);
    expect(settings.operationGrants).toEqual(before.operationGrants);

    await clearOriginImageScope(origin);
    expect((await getSettings()).allowedOrigins[origin]).not.toHaveProperty("imageInput");
    await revokeOriginOperation(origin, "transcribe");
    expect((await sites())[0].capabilities).toEqual(["Chat", "Synthesis", "Decisions"]);
    expect((await getSettings()).operationGrants[origin].synthesize).toEqual(before.operationGrants[origin].synthesize);
    await revokeOrigin(origin);
    expect((await sites())[0]).toMatchObject({ chat: null, capabilities: ["Synthesis", "Decisions"] });
    await revokeOriginOperation(origin, "synthesize");
    expect((await sites())[0].capabilities).toEqual(["Decisions"]);
    await revokeOriginOperation(origin, "decide");
    expect(await sites()).toEqual([]);
  });

  it("revokes all persistent scopes in one write, preserving other exact origins, routes, preferences and blocks", async () => {
    await grantMixedSite();
    await grantMixedSite(`${origin}:8443`);
    await blockOrigin("https://blocked.example");
    const before = await getSettings();
    const write = vi.spyOn(chrome.storage.local, "set");
    await expect(revokeAllOriginAccess(origin)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      allowedOrigins: { [`${origin}:8443`]: before.allowedOrigins[`${origin}:8443`] },
      operationGrants: { [`${origin}:8443`]: before.operationGrants[`${origin}:8443`] },
    });
    const after = await getSettings();
    expect(after).toEqual({ ...before, ...write.mock.calls[0][0] });
    expect((await sites()).map((site) => site.origin)).toEqual([`${origin}:8443`]);
  });

  it.each(["chat", "transcribe", "synthesize", "decide"])("revokes a %s-only site and leaves no allowed sites", async (capability) => {
    if (capability === "chat") await grantOriginAlways(origin, chat);
    else await grantOriginOperationAlways(origin, capability, routes[capability]);
    await revokeAllOriginAccess(origin);
    expect(await sites()).toEqual([]);
  });

  it("keeps grants visible and reports persistence failure when full revocation fails", async () => {
    await grantMixedSite();
    const before = await getSettings();
    vi.spyOn(chrome.storage.local, "set").mockRejectedValueOnce(new Error("quota"));
    await expect(revokeAllOriginAccess(origin)).rejects.toThrow("Could not save settings");
    expect(await getSettings()).toEqual(before);
    expect(await sites()).toHaveLength(1);
  });

  it.each(["null", "file:///tmp/page", ""])("ignores invalid origin %s", async (invalid) => {
    await grantMixedSite();
    const before = await getSettings();
    await expect(revokeAllOriginAccess(invalid)).resolves.toBe(false);
    expect(await getSettings()).toEqual(before);
  });
});
