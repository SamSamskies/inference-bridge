import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  filterProvidersForMethod,
  getDefaultProvider,
  getProvider,
  getProviderAsync,
  listAllProviders,
  listProviders,
  providerSupportsMethod,
  resolveProviderModels,
  resolveProviderVoices,
  resolveTranscriptionMediaTypes,
} from "../src/providers/registry.js";
import { saveCompatEndpoints } from "../src/storage.js";

const chromeMock = installChromeMock();

beforeEach(() => {
  chromeMock.reset();
});

describe("provider registry", () => {
  it("registers openai, anthropic, openrouter, ollama, and on-device", () => {
    const ids = listProviders().map((p) => p.id).sort();
    expect(ids).toEqual([
      "anthropic",
      "ollama",
      "on-device",
      "openai",
      "openrouter",
    ]);
    expect(getDefaultProvider().id).toBe("openai");
    expect(getProvider("missing")).toBeUndefined();
  });

  it("merges saved compat endpoints into listAllProviders", async () => {
    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    const all = await listAllProviders();
    const ids = all.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("compat:lm");
    const compat = await getProviderAsync("compat:lm");
    expect(compat?.label).toContain("LM Studio");
    expect(getProvider("compat:lm")).toBeUndefined();
  });

  it("still returns built-ins when settings fail to load", async () => {
    const originalGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = async () => {
      throw new Error("storage unavailable");
    };
    try {
      const all = await listAllProviders();
      expect(all.map((p) => p.id).sort()).toEqual([
        "anthropic",
        "ollama",
        "on-device",
        "openai",
        "openrouter",
      ]);
    } finally {
      globalThis.chrome.storage.local.get = originalGet;
    }
  });

  it("resolves static OpenAI models as ModelInfo entries", async () => {
    const openai = getProvider("openai");
    expect(openai).toBeDefined();
    expect(openai.defaultModel).toBe("gpt-5.6-luna");
    const models = await resolveProviderModels(openai);
    expect(models).toContainEqual({ id: "gpt-6-astra" });
    expect(models).toContainEqual({ id: "gpt-5.6-luna" });
    expect(models).toContainEqual({ id: "gpt-5-nano" });
    expect(models).toContainEqual({ id: "gpt-4.1" });
    expect(models).toEqual(openai.models.map((id) => ({ id })));
  });

  it("exposes OpenRouter with listModels and requiresApiKey", () => {
    const openrouter = getProvider("openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.requiresApiKey).toBe(true);
    expect(openrouter.label).toBe("OpenRouter");
    expect(typeof openrouter.listModels).toBe("function");
    expect(openrouter.defaultModel).toBe("openrouter/auto");
  });

  it("marks OpenAI, OpenRouter, Ollama, Anthropic, and compat endpoints as supporting function tools", async () => {
    expect(getProvider("openai")?.supportsFunctionTools).toBe(true);
    expect(getProvider("openrouter")?.supportsFunctionTools).toBe(true);
    expect(getProvider("ollama")?.supportsFunctionTools).toBe(true);
    expect(getProvider("anthropic")?.supportsFunctionTools).toBe(true);
    expect(getProvider("on-device")?.supportsFunctionTools).toBe(false);
    expect(getProvider("openai")?.hostedTools).toEqual(["web_search"]);
    expect(getProvider("openrouter")?.hostedTools).toEqual(["web_search"]);
    expect(getProvider("ollama")?.hostedTools).toEqual(["web_search"]);
    expect(getProvider("ollama")?.optionalApiKey).toBe(true);
    expect(getProvider("anthropic")?.hostedTools).toEqual(["web_search"]);
    expect(getProvider("on-device")?.hostedTools).toEqual([]);

    await saveCompatEndpoints([
      {
        id: "compat:lm",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);
    const compat = await getProviderAsync("compat:lm");
    expect(compat?.supportsFunctionTools).toBe(true);
    expect(compat?.hostedTools).toEqual([]);
  });

  it("exposes Anthropic with curated models and requiresApiKey", async () => {
    const anthropic = getProvider("anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.requiresApiKey).toBe(true);
    expect(anthropic.label).toBe("Anthropic");
    expect(anthropic.defaultModel).toBe("claude-sonnet-5");
    expect(typeof anthropic.listModels).toBe("undefined");
    const models = await resolveProviderModels(anthropic);
    expect(models).toContainEqual({ id: "claude-fable-5-1" });
    expect(models).toContainEqual({ id: "claude-fable-5" });
    expect(models).toContainEqual({ id: "claude-sonnet-5" });
    expect(models).toContainEqual({ id: "claude-opus-5" });
  });
});

describe("operation-scoped provider capabilities", () => {
  const streamChat = async () => ({
    model: "chat-model",
    message: { role: "assistant", content: "" },
  });
  const transcribe = async () => ({
    model: "stt-model",
    transcript: { text: "" },
  });
  const synthesize = async () => ({
    model: "tts-model",
    audio: { mediaType: "audio/mpeg", byteLength: 1 },
  });

  it("does not advertise partial or chat-only speech adapters", () => {
    const chatOnly = { id: "chat", streamChat };
    const descriptorOnly = {
      id: "descriptor",
      streamChat,
      transcription: {
        defaultModel: "stt-model",
        acceptedMediaTypes: ["audio/wav"],
      },
    };
    const methodOnly = { id: "method", streamChat, transcribe };

    expect(providerSupportsMethod(chatOnly, "chat")).toBe(true);
    expect(providerSupportsMethod(chatOnly, "transcribe")).toBe(false);
    expect(providerSupportsMethod(descriptorOnly, "transcribe")).toBe(false);
    expect(providerSupportsMethod(methodOnly, "transcribe")).toBe(false);
    expect(filterProvidersForMethod(listProviders(), "transcribe")).toEqual([]);
    expect(filterProvidersForMethod(listProviders(), "synthesize")).toEqual([]);
  });

  it("filters transcription providers by normalized declared media type", () => {
    const wav = {
      id: "wav",
      streamChat,
      transcribe,
      transcription: {
        defaultModel: "stt-model",
        models: ["stt-model"],
        acceptedMediaTypes: ["audio/x-wav", "video/mp4"],
      },
    };
    const mp3 = {
      id: "mp3",
      streamChat,
      transcribe,
      transcription: {
        defaultModel: "stt-model",
        models: ["stt-model"],
        acceptedMediaTypes: ["audio/mpeg"],
      },
    };

    expect(
      filterProvidersForMethod([wav, mp3], "transcribe", {
        mediaType: "audio/wav; codecs=1",
      }).map((provider) => provider.id)
    ).toEqual(["wav"]);
    expect(
      filterProvidersForMethod([wav, mp3], "transcribe", {
        mediaType: "video/mp4",
      }).map((provider) => provider.id)
    ).toEqual(["wav"]);
    expect(
      filterProvidersForMethod([wav, mp3], "transcribe", {
        mediaType: "audio/ogg",
      })
    ).toEqual([]);
  });

  it("resolves operation models and synthesis voices independently", async () => {
    const provider = {
      id: "speech",
      streamChat,
      models: ["chat-model"],
      transcribe,
      transcription: {
        defaultModel: "stt-default",
        models: [{ id: "stt-model", label: "Transcriber" }],
        acceptedMediaTypes: ["audio/wav"],
      },
      synthesize,
      synthesis: {
        defaultModel: "tts-default",
        defaultVoice: "alloy",
        models: ["tts-model"],
        voices: ["alloy", { id: "coral", label: "Coral" }],
        outputMediaTypes: ["audio/mpeg"],
      },
    };

    expect(await resolveProviderModels(provider)).toEqual([
      { id: "chat-model" },
    ]);
    expect(
      await resolveProviderModels(provider, { method: "transcribe" })
    ).toEqual([{ id: "stt-model", label: "Transcriber" }]);
    expect(
      await resolveProviderModels(provider, { method: "synthesize" })
    ).toEqual([{ id: "tts-model" }]);
    expect(await resolveProviderVoices(provider)).toEqual([
      { id: "alloy" },
      { id: "coral", label: "Coral" },
    ]);
    expect(
      providerSupportsMethod(provider, "synthesize", {
        mediaType: "audio/mpeg",
      })
    ).toBe(true);
  });

  it("intersects model-probed transcription MIME types with the descriptor", async () => {
    const provider = {
      id: "probed",
      streamChat,
      transcribe,
      transcription: {
        defaultModel: "stt-model",
        acceptedMediaTypes: ["audio/wav", "video/mp4"],
        async listAcceptedMediaTypesForModel() {
          return ["audio/x-wav", "audio/mpeg"];
        },
      },
    };

    expect(
      await resolveTranscriptionMediaTypes(provider, { model: "stt-model" })
    ).toEqual(["audio/wav"]);
  });
});
