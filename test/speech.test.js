import { describe, expect, it } from "vitest";
import {
  AUDIO_TRANSFER_CHUNK_BYTES,
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
  countUnicodeCodePoints,
  isStructurallyValidLanguageTag,
  isValidSynthesisText,
  isValidTranscriptionByteLength,
  normalizeTranscriptionMediaType,
  rawBase64ByteLength,
} from "../src/speech.js";

describe("experimental speech limits", () => {
  it("centralizes the incubation and transfer bounds", () => {
    expect(TRANSCRIPTION_INPUT_MAX_BYTES).toBe(24_000_000);
    expect(SYNTHESIS_TEXT_MAX_CODE_POINTS).toBe(4_096);
    expect(SYNTHESIS_OUTPUT_MAX_BYTES).toBe(32_000_000);
    expect(AUDIO_TRANSFER_CHUNK_BYTES).toBe(256 * 1024);
  });

  it("accepts the exact transcription byte limit and rejects empty or over-limit input", () => {
    expect(isValidTranscriptionByteLength(1)).toBe(true);
    expect(isValidTranscriptionByteLength(TRANSCRIPTION_INPUT_MAX_BYTES)).toBe(
      true
    );
    expect(
      isValidTranscriptionByteLength(TRANSCRIPTION_INPUT_MAX_BYTES + 1)
    ).toBe(false);
    expect(isValidTranscriptionByteLength(0)).toBe(false);
  });
});

describe("transcription media types", () => {
  it.each([
    ["audio/mpeg", "audio/mpeg"],
    ["Audio/MP3; codecs=mp3", "audio/mpeg"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/x-wav; charset=binary", "audio/wav"],
    ["audio/vnd.wave", "audio/wav"],
    ["audio/webm; codecs=opus", "audio/webm"],
    ["video/mp4", "video/mp4"],
    ["video/webm", "video/webm"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeTranscriptionMediaType(input)).toBe(expected);
  });

  it.each(["audio/ogg", "audio/flac", "video/quicktime", "", null])(
    "rejects unsupported type %s",
    (input) => {
      expect(normalizeTranscriptionMediaType(input)).toBe("");
    }
  );
});

describe("raw transcription base64", () => {
  it.each([
    ["Zg==", 1],
    ["Zm8=", 2],
    ["Zm9v", 3],
    ["AAECAwQ=", 5],
  ])("computes the decoded size for %s", (input, expected) => {
    expect(rawBase64ByteLength(input)).toBe(expected);
  });

  it.each([
    "",
    "Zg",
    "Zg===",
    "Zm=v",
    "Zm9v\n",
    "data:audio/mpeg;base64,Zg==",
  ])("rejects malformed or non-raw base64 %s", (input) => {
    expect(rawBase64ByteLength(input)).toBe(-1);
  });
});

describe("speech language and text", () => {
  it.each(["en", "en-US", "zh-Hant-TW", "de-CH-1901"])(
    "accepts structurally valid language tag %s",
    (tag) => {
      expect(isStructurallyValidLanguageTag(tag)).toBe(true);
    }
  );

  it.each(["", " en", "en_US", "not a tag", 42])(
    "rejects invalid language tag %s",
    (tag) => {
      expect(isStructurallyValidLanguageTag(tag)).toBe(false);
    }
  );

  it("counts astral characters as one code point", () => {
    expect(countUnicodeCodePoints("a😀b")).toBe(3);
  });

  it("enforces non-empty synthesis text at the exact code-point limit", () => {
    expect(isValidSynthesisText("hello")).toBe(true);
    expect(isValidSynthesisText(" \n ")).toBe(false);
    expect(isValidSynthesisText("😀".repeat(SYNTHESIS_TEXT_MAX_CODE_POINTS))).toBe(
      true
    );
    expect(
      isValidSynthesisText("😀".repeat(SYNTHESIS_TEXT_MAX_CODE_POINTS + 1))
    ).toBe(false);
  });
});
