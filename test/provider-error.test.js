import { describe, expect, it } from "vitest";
import {
  formatProviderApiError,
  readProviderErrorDetail,
} from "../src/providers/provider-error.js";

describe("formatProviderApiError", () => {
  it("returns string errors unchanged", () => {
    expect(formatProviderApiError("plain failure")).toBe("plain failure");
  });

  it("returns the outer message when metadata is absent", () => {
    expect(
      formatProviderApiError({ message: "OpenRouter HTTP 400" }, "fallback")
    ).toBe("OpenRouter HTTP 400");
  });

  it("appends nested metadata.raw detail for OpenRouter provider errors", () => {
    expect(
      formatProviderApiError({
        message: "Provider returned error",
        code: 400,
        metadata: {
          provider_name: "Nex AGI",
          raw: JSON.stringify({
            error: { message: "Failed to extract 1 image(s)" },
          }),
        },
      })
    ).toBe(
      "Provider returned error (Nex AGI): Failed to extract 1 image(s)"
    );
  });

  it("surfaces server tool failures with nested detail", () => {
    expect(
      formatProviderApiError({
        message: "Server tool request failed",
        metadata: {
          provider_name: "OpenRouter",
          raw: '{"error":{"message":"Insufficient credits"}}',
        },
      })
    ).toBe(
      "Server tool request failed (OpenRouter): Insufficient credits"
    );
  });

  it("uses raw string metadata when it is not JSON", () => {
    expect(
      formatProviderApiError({
        message: "Provider returned error",
        metadata: { raw: "upstream timeout" },
      })
    ).toBe("Provider returned error: upstream timeout");
  });

  it("does not duplicate detail already present in the outer message", () => {
    expect(
      formatProviderApiError({
        message: "Failed to extract 1 image(s)",
        metadata: {
          raw: JSON.stringify({
            error: { message: "Failed to extract 1 image(s)" },
          }),
        },
      })
    ).toBe("Failed to extract 1 image(s)");
  });

  it("falls back when the error body is empty", () => {
    expect(formatProviderApiError(null, "OpenRouter HTTP 502")).toBe(
      "OpenRouter HTTP 502"
    );
    expect(formatProviderApiError({}, "OpenRouter HTTP 502")).toBe(
      "OpenRouter HTTP 502"
    );
  });
});

describe("readProviderErrorDetail", () => {
  it("formats OpenRouter-style HTTP error bodies", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Provider returned error",
          metadata: {
            provider_name: "Nex AGI",
            raw: '{"error":{"message":"image too large"}}',
          },
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
    await expect(
      readProviderErrorDetail(response, "OpenRouter HTTP 400")
    ).resolves.toBe("Provider returned error (Nex AGI): image too large");
  });

  it("returns the fallback when the body is not JSON", async () => {
    const response = new Response("not-json", { status: 500 });
    await expect(
      readProviderErrorDetail(response, "OpenRouter HTTP 500")
    ).resolves.toBe("OpenRouter HTTP 500");
  });
});
