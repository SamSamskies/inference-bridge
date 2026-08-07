import { describe, expect, it } from "vitest";
import {
  normalizeCompatBaseUrl,
  originPatternFromBaseUrl,
} from "../src/host-permissions.js";

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
});
