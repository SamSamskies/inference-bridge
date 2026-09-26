import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import {
  hasBuiltInHostPermission,
  normalizeCompatBaseUrl,
  originPatternFromBaseUrl,
} from "../src/host-permissions.js";

const chromeMock = installChromeMock();
beforeEach(() => chromeMock.reset());

describe("normalizeCompatBaseUrl", () => {
  it("trims, strips trailing slash, and keeps an existing /v1 path", () => {
    expect(normalizeCompatBaseUrl("  http://127.0.0.1:1234/v1/  ")).toBe(
      "http://127.0.0.1:1234/v1"
    );
  });

  it("appends /v1 when the user enters an origin only", () => {
    expect(normalizeCompatBaseUrl("http://localhost:1234")).toBe(
      "http://localhost:1234/v1"
    );
    expect(normalizeCompatBaseUrl("https://llm.example.com")).toBe(
      "https://llm.example.com/v1"
    );
  });

  it("preserves a deeper /v1 path prefix", () => {
    expect(normalizeCompatBaseUrl("http://127.0.0.1:8080/openai/v1")).toBe(
      "http://127.0.0.1:8080/openai/v1"
    );
  });

  it("truncates pasted /v1 endpoint paths to the /v1 base", () => {
    expect(normalizeCompatBaseUrl("http://127.0.0.1:1234/v1/models")).toBe(
      "http://127.0.0.1:1234/v1"
    );
    expect(
      normalizeCompatBaseUrl("https://api.example.com/v1/chat/completions")
    ).toBe("https://api.example.com/v1");
    expect(
      normalizeCompatBaseUrl("http://127.0.0.1:8080/openai/v1/models")
    ).toBe("http://127.0.0.1:8080/openai/v1");
  });

  it("rejects blank, non-http(s), and invalid URLs", () => {
    expect(normalizeCompatBaseUrl("")).toBeNull();
    expect(normalizeCompatBaseUrl("   ")).toBeNull();
    expect(normalizeCompatBaseUrl("ftp://127.0.0.1:1234")).toBeNull();
    expect(normalizeCompatBaseUrl("not a url")).toBeNull();
    expect(normalizeCompatBaseUrl("http://")).toBeNull();
  });
});

describe("originPatternFromBaseUrl", () => {
  it("returns scheme://host:port/* for the normalized base URL", () => {
    expect(originPatternFromBaseUrl("http://127.0.0.1:1234/v1")).toBe(
      "http://127.0.0.1:1234/*"
    );
    expect(originPatternFromBaseUrl("https://llm.example.com/v1")).toBe(
      "https://llm.example.com/*"
    );
    expect(originPatternFromBaseUrl("http://localhost:8080/v1")).toBe(
      "http://localhost:8080/*"
    );
  });

  it("includes the default port only when non-default was explicit", () => {
    expect(originPatternFromBaseUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/*"
    );
  });

  it("returns null for invalid base URLs", () => {
    expect(originPatternFromBaseUrl("")).toBeNull();
    expect(originPatternFromBaseUrl("not-a-url")).toBeNull();
  });

  it("uses portless host patterns in Firefox and rejects remote HTTP", () => {
    const firefox = { firefox: true };
    expect(originPatternFromBaseUrl("http://127.0.0.1:1234/v1", firefox)).toBe(
      "http://127.0.0.1/*"
    );
    expect(originPatternFromBaseUrl("http://localhost:8080/v1", firefox)).toBe(
      "http://localhost/*"
    );
    expect(originPatternFromBaseUrl("http://[::1]:8080/v1", firefox)).toBe(
      "http://[::1]/*"
    );
    expect(originPatternFromBaseUrl("https://llm.example.com:8443/v1", firefox)).toBe(
      "https://llm.example.com/*"
    );
    expect(originPatternFromBaseUrl("http://192.168.1.3:1234/v1", firefox)).toBeNull();
    expect(originPatternFromBaseUrl("http://remote.example:1234/v1", firefox)).toBeNull();
  });
});

describe("Firefox built-in host grants", () => {
  it("checks the selected provider host and fails when revoked", async () => {
    chromeMock.setManifest({ browser_specific_settings: { gecko: {} } });
    const contains = vi.fn(async () => false);
    globalThis.chrome.permissions = { contains };
    expect(await hasBuiltInHostPermission("openai")).toBe(false);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
  });

  it("does not block Chrome built-ins or custom endpoints", async () => {
    expect(await hasBuiltInHostPermission("openai")).toBe(true);
    chromeMock.setManifest({ browser_specific_settings: { gecko: {} } });
    expect(await hasBuiltInHostPermission("compat:local")).toBe(true);
  });
});
