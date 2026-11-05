import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "./fixtures/ppq-decisions-models.json";
import request from "./fixtures/system-one-request.json";
import fixture from "./fixtures/system-one-response.json";

const url = "https://api.ppq.ai/v1/decisions";
let provider, listModels, response;
const args = (extra = {}) => ({
  ...structuredClone(request), apiKey: "private-ppq-key", model: "typesafe/jev-1.13",
  signal: new AbortController().signal, ...extra,
});
const posts = () => fetch.mock.calls.filter(([, options]) => options?.method === "POST");
beforeEach(async () => {
  vi.resetModules();
  provider = (await import("../src/providers/ppq.js")).ppqProvider;
  listModels = provider.decisions.listModels;
  response = () => Response.json(fixture);
  vi.stubGlobal("fetch", vi.fn(async (endpoint, options) => endpoint === `${url}/models`
    ? Response.json(catalog) : response(endpoint, options)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PPQ decision discovery", () => {
  it("lists a separate public catalog with aliases, non-Jev models, labels, sorting, and no credential", async () => {
    const signal = new AbortController().signal;
    const models = await listModels({ signal, apiKey: "must-not-send" });
    expect(models).toEqual(catalog.data.map((model) => ({ id: model.id, label: model.name, outputModalities: ["decisions"] })).sort((a, b) => a.id.localeCompare(b.id)));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${url}/models`, { signal });
    expect(provider.defaultModel).toBe("auto");
    expect(provider.decisions.defaultModel).toBe("typesafe/jev-1.13");
    // A consumer cannot edit the validation cache through the returned list.
    models[0].id = "tampered";
    models[1].outputModalities.push("text");
    await expect(provider.decide(args({ model: "morph/reflex" }))).resolves.toHaveProperty("answers");
  });

  it("ignores chat, audio, batch, duplicate and malformed entries", async () => {
    fetch.mockResolvedValueOnce(Response.json({ data: [
      ...catalog.data, catalog.data[0], { id: "chat", type: "chat" },
      { id: "tts", type: "tts" }, { id: "bad:batch", type: "decision" },
      { id: "" }, { id: 2 }, {}, null,
    ] }));
    expect(await listModels()).toHaveLength(3);
  });

  it("does not mix chat and decision catalogs or dispatch known decisions as chat", async () => {
    await listModels();
    fetch.mockResolvedValueOnce(Response.json({ data: [
      { id: "auto", type: "chat" }, { id: "morph/reflex" },
      { id: "typesafe/jev-1.13" }, { id: "other/decider", type: "decision" },
    ] }));
    expect(await provider.listModels()).toEqual([{ id: "auto" }]);
    fetch.mockClear();
    await expect(provider.streamChat({ ...args({ model: "morph/reflex" }), messages: [], onDelta() {} })).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.decide(args({ model: "auto" }))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [() => { throw new TypeError("network"); }, "unavailable"],
    [() => new Response("unavailable", { status: 503 }), "unavailable"],
    [() => new Response("denied", { status: 403 }), "provider_error"],
    [() => new Response("bad JSON"), "provider_error"],
    [() => Response.json({ models: [] }), "provider_error"],
  ])("fails closed when discovery fails (%s)", async (reply, code) => {
    fetch.mockImplementation(reply);
    await expect(listModels()).rejects.toMatchObject({ code });
    await expect(provider.decide(args())).rejects.toMatchObject({ code });
    expect(posts()).toEqual([]);
  });

  it("refreshes expired metadata and rejects a retired decision model", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await listModels();
    clock.mockReturnValue(now + 60_001);
    fetch.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(provider.decide(args())).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posts()).toEqual([]);
  });

  it("does not keep an earlier validated catalog after a failed refresh", async () => {
    await listModels();
    fetch.mockRejectedValueOnce(new TypeError("network"));
    await expect(listModels()).rejects.toMatchObject({ code: "unavailable" });
    fetch.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(provider.decide(args())).rejects.toMatchObject({ code: "unavailable" });
    expect(posts()).toEqual([]);
  });
});

describe("PPQ System One adapter", () => {
  it.each(catalog.data.map((model) => model.id))("posts typed state/questions through model %s and normalizes all three primitives", async (model) => {
    const input = args({ model });
    expect(await provider.decide(input)).toEqual({
      model: fixture.model, answers: fixture.answers,
      usage: { inputTokens: 476, outputTokens: 70 },
    });
    expect(posts()).toEqual([[url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer private-ppq-key" },
      body: JSON.stringify({ model, ...request }), signal: input.signal,
    }]]);
    expect(JSON.parse(posts()[0][1].body).stream).toBeUndefined();
  });

  it("snapshots input before awaiting discovery", async () => {
    const input = args();
    const expected = structuredClone(input.state);
    const pending = provider.decide(input);
    input.state.ticket = "changed";
    input.questions.is_bug.instructions = "changed";
    await pending;
    const body = JSON.parse(posts()[0][1].body);
    expect(body.state).toEqual(expected);
    expect(body.questions).toEqual(request.questions);
  });

  it("keeps concurrent calls' explicit models, keys, and states isolated", async () => {
    await listModels();
    response = async (_endpoint, options) => Response.json({ ...fixture, model: JSON.parse(options.body).model });
    const inputs = [args({ model: "morph/reflex", apiKey: "key-A", state: "state-A" }), args({ apiKey: "key-B", state: "state-B" })];
    const result = await Promise.all(inputs.map((input) => provider.decide(input)));
    expect(result.map((value) => value.model)).toEqual(inputs.map((input) => input.model));
    for (const [index, [, options]] of posts().entries()) {
      expect(options.headers.Authorization).toBe(`Bearer ${inputs[index].apiKey}`);
      expect(JSON.parse(options.body).state).toBe(inputs[index].state);
    }
  });

  it("validates before any network call and requires the explicit PPQ key", async () => {
    await expect(provider.decide(args({ apiKey: undefined }))).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.decide(args({ questions: {} }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.decide(args({ state: "x".repeat(64 * 1024) }))).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, "invalid_request", "question"], [401, "provider_error", "API key"],
    [402, "provider_error", "balance"], [403, "provider_error", "API key"],
    [404, "unavailable", "catalog"], [413, "invalid_request", "question"],
    [422, "invalid_request", "question"], [429, "provider_error", "rate limit"],
    [503, "unavailable", "temporarily unavailable"],
  ])("sanitizes HTTP %s with an actionable hint and no fallback", async (status, code, hint) => {
    response = () => Response.json({ error: { message: "upstream private-ppq-key", debug: "hidden" } }, { status });
    const error = await provider.decide(args()).catch((error) => error);
    expect(error).toMatchObject({ code, message: expect.stringContaining(hint) });
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("private-ppq-key");
    expect(error.message).not.toContain("hidden");
    expect(error).not.toHaveProperty("debug");
    expect(posts()).toHaveLength(1);
    expect(fetch.mock.calls.every(([endpoint]) => endpoint.startsWith(url))).toBe(true);
  });

  it.each([
    ["missing answers", (body) => { body.answers = {}; }],
    ["invalid noul", (body) => { body.answers.is_bug.noul = 2; }],
    ["invalid choice", (body) => { body.answers.team.choice = "other"; }],
    ["invalid score", (body) => { body.answers.urgency.score = 0; }],
    ["changed score legend", (body) => { body.answers.urgency.legend[0] = "changed"; }],
  ])("rejects %s without returning a chat substitute", async (_name, mutate) => {
    const body = structuredClone(fixture); mutate(body);
    response = () => Response.json(body);
    await expect(provider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    expect(posts()).toHaveLength(1);
  });

  it("handles invalid JSON and typed refusals", async () => {
    response = () => new Response("bad JSON");
    await expect(provider.decide(args())).rejects.toMatchObject({ code: "provider_error" });
    const body = structuredClone(fixture);
    body.answers.is_bug = { type: "refusal" };
    response = () => Response.json(body);
    expect((await provider.decide(args())).answers.is_bug).toEqual({ type: "refusal" });
  });

  it("bounds and redacts network exception messages", async () => {
    response = () => { throw Object.assign(new Error(`network private-ppq-key ${"x".repeat(2000)}`), { debug: "hidden" }); };
    const error = await provider.decide(args()).catch((error) => error);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message.length).toBeLessThanOrEqual(1200);
    expect(error.message).not.toContain("private-ppq-key");
    expect(error).not.toHaveProperty("debug");
  });

  it("aborts before any network call", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(provider.decide(args({ signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["catalog", "decision"])("aborts the in-flight %s fetch", async (phase) => {
    if (phase === "decision") await listModels();
    const controller = new AbortController();
    fetch.mockImplementationOnce((_endpoint, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = provider.decide(args({ signal: controller.signal }));
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(fetch.mock.calls.at(-1)[1].signal).toBe(controller.signal));
    controller.abort();
    await assertion;
  });

  it("does not complete if cancellation arrives while decoding the JSON body", async () => {
    const controller = new AbortController();
    response = () => ({ ok: true, json: async () => { controller.abort(); return fixture; } });
    await expect(provider.decide(args({ signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
  });
});
