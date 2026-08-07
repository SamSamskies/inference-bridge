import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {string} text
 * @param {number} [status]
 */
function sseResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
  globalThis.chrome.permissions = {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createOpenAICompatProvider", () => {
  const endpoint = {
    id: "compat:test-id",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
  };

  it("builds a provider with optional API key and experimental label", () => {
    const provider = createOpenAICompatProvider(endpoint);
    expect(provider.id).toBe("compat:test-id");
    expect(provider.label).toContain("LM Studio");
    expect(provider.label.toLowerCase()).toContain("experimental");
    expect(provider.requiresApiKey).toBe(false);
    expect(provider.optionalApiKey).toBe(true);
    expect(typeof provider.listModels).toBe("function");
    expect(typeof provider.streamChat).toBe("function");
  });

  it("lists models from GET /models and sorts by id", async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/models");
      return jsonResponse({
        data: [
          { id: "zeta", name: "Zeta" },
          { id: "alpha" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["alpha", "zeta"]);
    expect(models).toContainEqual({ id: "zeta", label: "Zeta" });
    expect(models).toContainEqual({ id: "alpha" });
  });

  it("returns an empty list when /models fails so free-text can degrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const provider = createOpenAICompatProvider(endpoint);
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it("rejects listModels when host permission is missing", async () => {
    globalThis.chrome.permissions.contains = vi.fn(async () => false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await expect(provider.listModels()).rejects.toMatchObject({
      name: "InferenceError",
      code: "unavailable",
      message: expect.stringMatching(/host permission/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams chat to /chat/completions without Authorization when no key", async () => {
    const sse = [
      'data: {"id":"1","model":"local","choices":[{"delta":{"content":"Hi"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(init.headers.Authorization).toBeUndefined();
      return sseResponse(sse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    /** @type {string[]} */
    const deltas = [];
    const result = await provider.streamChat({
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: (c) => deltas.push(c),
    });

    expect(deltas).toEqual(["Hi"]);
    expect(result.message.content).toBe("Hi");
  });

  it("sends Bearer auth when an API key is provided", async () => {
    const sse = ["data: [DONE]", ""].join("\n");
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe("Bearer secret");
      return sseResponse(sse);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatProvider(endpoint);
    await provider.streamChat({
      apiKey: "secret",
      model: "local",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
  });
});
