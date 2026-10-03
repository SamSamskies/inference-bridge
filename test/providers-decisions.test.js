import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import fixture from "./fixtures/system-one-response.json";
import request from "./fixtures/system-one-request.json";
import catalog from "./fixtures/openrouter-decisions-models.json";
import {
  openrouterProvider,
  listOpenRouterModels,
  listOpenRouterDecisionModels,
  resetOpenRouterDecisionCatalog,
} from "../src/providers/openrouter.js";
import {
  ollamaProvider,
  listOllamaDecisionModels,
  ollamaModelHasDecision,
} from "../src/providers/ollama.js";
import {
  filterProvidersForMethod,
  listProviders,
  providerSupportsMethod,
  resolveProviderModels,
} from "../src/providers/registry.js";

const decisionCatalogUrl =
  "https://openrouter.ai/api/v1/models?output_modalities=decisions";
let decisionResponse;
const decisionCalls = () =>
  fetch.mock.calls.filter(
    ([url]) => url.endsWith("/alpha/decisions") || url.endsWith("/v1/systemone")
  );
function ollamaMetadata(model) {
  return {
    capabilities:
      model === "chat-model" || model.startsWith("gemma4")
        ? ["completion"]
        : ["decision"],
    details: { format: "gguf" },
  };
}
beforeEach(() => {
  installChromeMock();
  resetOpenRouterDecisionCatalog();
  decisionResponse = () => Response.json(fixture);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (url === decisionCatalogUrl) return Response.json(catalog);
      if (url.endsWith("/api/show"))
        return Response.json(ollamaMetadata(JSON.parse(options.body).model));
      return decisionResponse(url, options);
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("decisions catalogs", () => {
  it("advertises exactly the two complete adapters and resolves an independent cloud catalog", async () => {
    expect(
      filterProvidersForMethod(listProviders(), "decide").map(
        (provider) => provider.id
      )
    ).toEqual(["openrouter", "ollama"]);
    expect(providerSupportsMethod({ decisions: {} }, "decide")).toBe(false);
    expect(providerSupportsMethod({ decide() {} }, "decide")).toBe(false);
    expect(
      await resolveProviderModels(openrouterProvider, { method: "decide" })
    ).toEqual(
      catalog.data
        .map((model) => ({
          id: model.id,
          label: model.name,
          inputModalities: model.architecture.input_modalities,
          outputModalities: ["decisions"],
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(
      await resolveProviderModels(listProviders()[0], { method: "decide" })
    ).toEqual([]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(decisionCatalogUrl, {
      signal: undefined,
    });
  });
  it("offers installed GGUF decision models, including Clef and custom names", async () => {
    const names = [
      "gemma4:latest",
      "nimble:latest",
      "tev1:0.8b",
      "library/tev1:latest",
      "clef:latest",
      "clef-flash:latest",
      "my-decider:latest",
      "my-cloud-check:latest",
      "remote-alias:latest",
      "nimble-imposter:latest",
      "tev1:cloud",
      "clef:mlx",
      "broken:latest",
    ];
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("/api/tags"))
        return Response.json({
          models: names.map((name) => ({ name })),
        });
      const model = JSON.parse(options.body).model;
      if (model === "broken:latest")
        return new Response("missing", { status: 404 });
      return Response.json({
        capabilities:
          model === "gemma4:latest" || model === "nimble-imposter:latest"
            ? ["completion"]
            : ["decision"],
        details: { format: model === "clef:mlx" ? "safetensors" : "gguf" },
        ...(model === "remote-alias:latest"
          ? { remote_host: "https://ollama.com" }
          : {}),
      });
    });
    expect((await listOllamaDecisionModels()).map((model) => model.id)).toEqual(
      [
        "clef-flash:latest",
        "clef:latest",
        "library/tev1:latest",
        "my-cloud-check:latest",
        "my-decider:latest",
        "nimble:latest",
        "tev1:0.8b",
      ]
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything()
    );
    expect(
      fetch.mock.calls
        .filter(([url]) => url.endsWith("/api/show"))
        .map(([, options]) => JSON.parse(options.body).model)
    ).not.toContain("tev1:cloud");
    fetch.mockResolvedValue(
      Response.json({ models: [{ name: "gemma4:latest" }] })
    );
    expect(await listOllamaDecisionModels()).toEqual([]);
  });
  it("fails closed on invalid decision metadata and forwards cancellation", async () => {
    fetch.mockResolvedValue(new Response("bad JSON"));
    expect(await ollamaModelHasDecision("custom:latest")).toBe(false);
    fetch.mockResolvedValue(Response.json({ capabilities: ["decision"] }));
    expect(await ollamaModelHasDecision("custom:latest")).toBe(false);
    fetch.mockRejectedValue(new TypeError("offline"));
    expect(await ollamaModelHasDecision("custom:latest")).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      ollamaModelHasDecision("custom:latest", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "aborted" });
  });
  it("does not admit text or batch entries even when returned by the decisions endpoint", async () => {
    fetch.mockResolvedValue(
      Response.json({
        data: [
          ...catalog.data,
          { id: "chat-model", architecture: { output_modalities: ["text"] } },
          {
            id: "liquid/d1:batch",
            architecture: { output_modalities: ["decisions"] },
          },
        ],
      })
    );
    const models = await listOpenRouterDecisionModels();
    expect(models).toHaveLength(catalog.data.length);
    fetch.mockResolvedValue(Response.json({ data: [] }));
    expect(await listOpenRouterDecisionModels()).toEqual([]);
    await expect(
      openrouterProvider.decide({
        ...request,
        apiKey: "key",
        model: "typesafe/jev-1.13",
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(decisionCalls()).toEqual([]);
  });
  it("accepts non-Jev models from the current decisions catalog", async () => {
    const models = await listOpenRouterDecisionModels();
    fetch.mockClear();
    for (const { id } of models) {
      await expect(
        openrouterProvider.decide({ ...request, apiKey: "key", model: id })
      ).resolves.toHaveProperty("answers");
    }
    expect(decisionCalls()).toHaveLength(catalog.data.length);
    expect(fetch).toHaveBeenCalledTimes(catalog.data.length);
  });
  it("refreshes expired catalog validation and rejects retired models", async () => {
    const now = Date.now();
    await listOpenRouterDecisionModels();
    fetch.mockResolvedValue(Response.json({ data: [] }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      await expect(
        openrouterProvider.decide({
          ...request,
          apiKey: "key",
          model: "liquid/d1",
        })
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(decisionCalls()).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it("omits decision models from the chat catalogs", async () => {
    await listOpenRouterDecisionModels();
    fetch.mockResolvedValue(
      Response.json({
        data: [
          { id: "typesafe/jev-1.13" },
          { id: "liquid/d1" },
          { id: "typesafe/jev-router" },
          {
            id: "other/decider",
            architecture: { output_modalities: ["decisions"] },
          },
          { id: "openrouter/auto" },
        ],
      })
    );
    expect(await listOpenRouterModels()).toEqual([
      { id: "openrouter/auto" },
      { id: "typesafe/jev-router" },
    ]);
    fetch.mockClear();
    await expect(
      openrouterProvider.streamChat({
        model: "other/decider",
        messages: [],
        onDelta() {},
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("/api/show"))
        return Response.json(ollamaMetadata(JSON.parse(options.body).model));
      return Response.json({
        models: [
          { name: "nimble:latest" },
          { name: "tev1:0.8b" },
          { name: "clef:latest" },
          { name: "clef-flash:latest" },
          { name: "my-decider:latest" },
          { name: "gemma4:latest" },
        ],
      });
    });
    expect(await ollamaProvider.listModels()).toEqual([
      { id: "gemma4:latest" },
    ]);
  });
});

describe.each([
  [
    openrouterProvider,
    "typesafe/jev-1.13",
    "https://openrouter.ai/api/alpha/decisions",
  ],
  [ollamaProvider, "nimble:latest", "http://localhost:11434/v1/systemone"],
])("%s decision adapter", (provider, model, url) => {
  const args = () => ({
    ...request,
    apiKey: "stored-key",
    model,
    signal: new AbortController().signal,
  });
  it("posts System One JSON and maps typed answers and snake_case usage", async () => {
    const input = args();
    expect(await provider.decide(input)).toEqual({
      model: fixture.model,
      answers: fixture.answers,
      usage: { inputTokens: 476, outputTokens: 70 },
    });
    expect(decisionCalls()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.id === "openrouter"
          ? { Authorization: "Bearer stored-key" }
          : {}),
      },
      body: JSON.stringify({ model, ...request }),
      signal: input.signal,
    });
  });
  it("rejects chat models and never falls back to chat", async () => {
    await expect(
      provider.decide({ ...args(), model: "chat-model" })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(decisionCalls()).toEqual([]);
  });
  it("rejects decision models passed to streamChat before networking", async () => {
    await expect(
      provider.streamChat({ ...args(), messages: [], onDelta() {} })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [400, "invalid_request"],
    [413, "invalid_request"],
    [422, "invalid_request"],
    [401, "provider_error"],
    [429, "provider_error"],
    [503, "unavailable"],
  ])("maps HTTP %s without fallback", async (status, code) => {
    decisionResponse = () =>
      Response.json({ error: { message: "Upstream detail" } }, { status });
    await expect(provider.decide(args())).rejects.toMatchObject({
      code,
      message: "Upstream detail",
    });
    expect(decisionCalls()).toHaveLength(1);
  });
  it("handles invalid JSON and malformed answer maps", async () => {
    decisionResponse = () => new Response("not JSON");
    await expect(provider.decide(args())).rejects.toMatchObject({
      code: "provider_error",
    });
    decisionResponse = () => Response.json({ model, answers: {} });
    await expect(provider.decide(args())).rejects.toMatchObject({
      code: "provider_error",
    });
  });
  it("maps unavailable networking and aborts the in-flight fetch", async () => {
    decisionResponse = () => Promise.reject(new TypeError("offline"));
    await expect(provider.decide(args())).rejects.toMatchObject({
      code: "unavailable",
    });
    const controller = new AbortController();
    decisionResponse = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    const pending = provider.decide({ ...args(), signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "aborted",
    });
    await vi.waitFor(() =>
      expect(fetch.mock.calls.at(-1)[1].signal).toBe(controller.signal)
    );
    controller.abort();
    await assertion;
  });
});

it("reports missing Ollama System One with an upgrade hint", async () => {
  decisionResponse = () => new Response("404 page not found", { status: 404 });
  await expect(
    ollamaProvider.decide({
      ...request,
      model: "nimble",
      signal: new AbortController().signal,
    })
  ).rejects.toMatchObject({
    code: "unavailable",
    message: expect.stringContaining("0.35+"),
  });
});
it("requires the existing OpenRouter key", async () => {
  await expect(
    openrouterProvider.decide({ ...request, model: "typesafe/jev-1.13" })
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});
