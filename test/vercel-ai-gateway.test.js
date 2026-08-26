import { describe, expect, it } from "vitest";
import {
  VERCEL_DEFAULT_MODEL,
  isVercelAiGatewayBaseUrl,
  isVercelAiGatewayCompatProvider,
  providerDropdownLabel,
  shouldNudgeVercelAiGatewayCompat,
  vercelAiGatewayCompatDropdownLabel,
  vercelAiGatewayFromCompatPatch,
} from "../src/vercel-ai-gateway.js";

describe("isVercelAiGatewayBaseUrl", () => {
  it("matches the Gateway hostname and ignores path", () => {
    expect(isVercelAiGatewayBaseUrl("https://ai-gateway.vercel.sh/v1")).toBe(
      true
    );
    expect(isVercelAiGatewayBaseUrl("https://ai-gateway.vercel.sh/v1/")).toBe(
      true
    );
    expect(isVercelAiGatewayBaseUrl("https://AI-GATEWAY.VERCEL.SH/v1")).toBe(
      true
    );
  });

  it("does not match other hosts or query-string lookalikes", () => {
    expect(isVercelAiGatewayBaseUrl("https://openrouter.ai/api/v1")).toBe(
      false
    );
    expect(
      isVercelAiGatewayBaseUrl("https://example.com/?host=ai-gateway.vercel.sh")
    ).toBe(false);
    expect(
      isVercelAiGatewayBaseUrl("https://ai-gateway.vercel.sh.evil.example/v1")
    ).toBe(false);
    expect(isVercelAiGatewayBaseUrl("not a url")).toBe(false);
    expect(isVercelAiGatewayBaseUrl("")).toBe(false);
  });
});

describe("providerDropdownLabel", () => {
  it("suffixes leftover Gateway compat rows so they do not collide with the built-in", () => {
    expect(
      providerDropdownLabel({
        id: "compat:gw",
        label: "Vercel AI Gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
      })
    ).toBe("Vercel AI Gateway (OpenAI-compatible)");
    expect(
      vercelAiGatewayCompatDropdownLabel("Vercel AI Gateway (OpenAI-compatible)")
    ).toBe("Vercel AI Gateway (OpenAI-compatible)");
    expect(
      isVercelAiGatewayCompatProvider({
        id: "vercel",
        label: "Vercel AI Gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
      })
    ).toBe(false);
    expect(
      providerDropdownLabel({
        id: "compat:ppq",
        label: "PPQ",
        baseUrl: "https://api.ppq.ai/v1",
      })
    ).toBe("PPQ");
  });
});

describe("shouldNudgeVercelAiGatewayCompat", () => {
  it("skips when the built-in key or provider is already set", () => {
    expect(
      shouldNudgeVercelAiGatewayCompat({ apiKeys: { vercel: "vck" } })
    ).toBe(false);
    expect(
      shouldNudgeVercelAiGatewayCompat({ defaultProviderId: "vercel" })
    ).toBe(false);
    expect(
      shouldNudgeVercelAiGatewayCompat({ selectedProviderId: "vercel" })
    ).toBe(false);
  });

  it("nudges when Vercel is unset", () => {
    expect(
      shouldNudgeVercelAiGatewayCompat({
        apiKeys: {},
        defaultProviderId: "openai",
        selectedProviderId: "compat:gw",
      })
    ).toBe(true);
  });
});

describe("vercelAiGatewayFromCompatPatch", () => {
  it("copies key and plausible model when Vercel slots are empty", () => {
    expect(
      vercelAiGatewayFromCompatPatch({
        endpointId: "compat:gw",
        apiKeys: { "compat:gw": " vck-from-compat " },
        defaultModels: { "compat:gw": "openai/gpt-5.6-luna" },
      })
    ).toEqual({
      defaultProviderId: "vercel",
      apiKeys: { vercel: "vck-from-compat" },
      defaultModels: { vercel: "openai/gpt-5.6-luna" },
    });
  });

  it("does not overwrite an existing Vercel key or model", () => {
    expect(
      vercelAiGatewayFromCompatPatch({
        endpointId: "compat:gw",
        apiKeys: { vercel: "vck-existing", "compat:gw": "vck-compat" },
        defaultModels: {
          vercel: "anthropic/claude-sonnet-5",
          "compat:gw": "openai/gpt-5.6-luna",
        },
      })
    ).toEqual({
      defaultProviderId: "vercel",
      apiKeys: {},
      defaultModels: {},
    });
  });

  it("falls back to the default Gateway model when the compat model is implausible", () => {
    expect(
      vercelAiGatewayFromCompatPatch({
        endpointId: "compat:gw",
        apiKeys: {},
        defaultModels: { "compat:gw": "gpt-5.6-luna" },
      })
    ).toEqual({
      defaultProviderId: "vercel",
      apiKeys: {},
      defaultModels: { vercel: VERCEL_DEFAULT_MODEL },
    });
  });
});
