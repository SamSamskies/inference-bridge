import { beforeEach, expect, it } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { getOriginOperationGrant, grantOriginOperationAlways, setOriginOperationRoute, getSettings } from "../src/storage.js";
const mock = installChromeMock();
const origin = "https://media.example";
const route = { providerId: "gemini", model: "gemini-decision-1" };
beforeEach(() => mock.reset());
it("leaves existing decision and chat image grants text-only for decisions", async () => {
  await chrome.storage.local.set({ allowedOrigins: { [origin]: { ...route, imageInput: true } }, operationGrants: { [origin]: { decide: { ...route, allowedAt: 1 } } } });
  expect(await getOriginOperationGrant(origin, "decide")).toEqual({ ...route, allowedAt: 1 });
});
it.each([["image/gif"], ["image/png", "text/html"], new Array(1), "image/png"].map((value) => [value]))("fails closed when persisted media scopes are malformed: %j", async (imageMediaTypes) => {
  await chrome.storage.local.set({ operationGrants: { [origin]: { decide: { ...route, imageMediaTypes, allowedAt: 1 } } } });
  expect((await getOriginOperationGrant(origin, "decide")).imageMediaTypes).toBeUndefined();
});
it("normalizes exact MIME scopes and revokes media without losing text decisions", async () => {
  await grantOriginOperationAlways(origin, "decide", { ...route, imageMediaTypes: ["image/png", "image/jpeg", "image/png"] });
  const before = await getOriginOperationGrant(origin, "decide");
  expect(before.imageMediaTypes).toEqual(["image/jpeg", "image/png"]);
  await setOriginOperationRoute(origin, "decide", route);
  expect(await getOriginOperationGrant(origin, "decide")).toEqual({ ...route, allowedAt: before.allowedAt });
  expect(JSON.stringify(await getSettings())).not.toContain("data:");
});
it("does not carry media authorization to a changed provider/model", async () => {
  await grantOriginOperationAlways(origin, "decide", { ...route, imageMediaTypes: ["image/png"] });
  await setOriginOperationRoute(origin, "decide", { providerId: "openai", model: "gpt-6-luna" });
  expect((await getOriginOperationGrant(origin, "decide")).imageMediaTypes).toBeUndefined();
});
