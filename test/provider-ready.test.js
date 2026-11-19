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

  it("requires on-device Prompt API model to be installed", () => {
    expect(
      isApprovalProviderReady(
        { id: "on-device", requiresApiKey: false },
        { onDeviceAvailable: false }
      )
    ).toBe(false);
    expect(
      isApprovalProviderReady(
        { id: "on-device", requiresApiKey: false },
        { onDeviceAvailable: true }
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
    ).toEqual({ message: "Ollama is unavailable at http://localhost:11434." });

    expect(
      approvalProviderSetupHint(
        { id: "on-device", label: "On-device" },
        { onDeviceAvailable: false }
      )
    ).toEqual({ message: "Install the on-device model in Options before allowing this site." });

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
        hasApiKey: false,
      })
    ).toEqual({ message: "Anthropic needs an API key.", needsApiKey: true });

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
        hasApiKey: true,
      })
    ).toBeNull();

    expect(
      approvalProviderSetupHint({
        id: "openai",
        label: "OpenAI",
        requiresApiKey: true,
        hasApiKey: true,
      })
    ).toBeNull();

    expect(
      approvalProviderSetupHint({
        id: "anthropic",
        label: "Anthropic",
        requiresApiKey: true,
      })
    ).toBeNull();
  });
});
