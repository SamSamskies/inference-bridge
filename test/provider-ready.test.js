import { describe, expect, it } from "vitest";
import {
  approvalProviderSetupHint,
  isApprovalProviderReady,
} from "../src/provider-ready.js";

describe("isApprovalProviderReady", () => {
  it("requires Ollama to be available", () => {
    expect(
      isApprovalProviderReady(
        { id: "ollama", requiresApiKey: false },
        { ollamaAvailable: false }
      )
    ).toBe(false);
    expect(
      isApprovalProviderReady(
        { id: "ollama", requiresApiKey: false },
        { ollamaAvailable: true }
      )
    ).toBe(true);
  });

  it("requires a saved API key for BYOK providers", () => {
    expect(
      isApprovalProviderReady({
        id: "anthropic",
        requiresApiKey: true,
        hasApiKey: false,
      })
    ).toBe(false);
    expect(
      isApprovalProviderReady({
        id: "anthropic",
        requiresApiKey: true,
        hasApiKey: true,
      })
    ).toBe(true);
    expect(
      isApprovalProviderReady({
        id: "openai",
        requiresApiKey: true,
        hasApiKey: false,
      })
    ).toBe(false);
  });

  it("does not block Allow when hasApiKey is unknown", () => {
    expect(
      isApprovalProviderReady({
        id: "anthropic",
        requiresApiKey: true,
      })
    ).toBe(true);
  });

  it("allows optionalApiKey compat endpoints without a key", () => {
    expect(
      isApprovalProviderReady({
        id: "compat:lm",
        requiresApiKey: true,
        optionalApiKey: true,
        hasApiKey: false,
      })
    ).toBe(true);
  });
});

describe("approvalProviderSetupHint", () => {
  it("returns a hint only when the selected provider is not ready", () => {
    expect(
      approvalProviderSetupHint(
        { id: "ollama", label: "Ollama" },
        {
          ollamaAvailable: false,
          ollamaMessage: "Ollama is unavailable at http://localhost:11434.",
        }
      )
    ).toBe("Ollama is unavailable at http://localhost:11434.");

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
        hasApiKey: false,
      })
    ).toBe(
      "Anthropic needs an API key — add one in Options to enable it."
    );

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
        hasApiKey: true,
      })
    ).toBe("");

    expect(
      approvalProviderSetupHint({
        id: "openai",
        label: "OpenAI",
        requiresApiKey: true,
        hasApiKey: true,
      })
    ).toBe("");

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
      })
    ).toBe("");
  });
});
