import { expect, it } from "vitest";
import { formatBytes, byteLimitMessage } from "../src/format-bytes.js";

it.each([[0, "0 B"], [73, "73 B"], [1000, "1 kB"], [65_536, "65.5 kB"], [1_000_000, "1 MB"], [4_194_304, "4.2 MB"], [20_000_000, "20 MB"]])
  ("formats %i bytes as %s", (size, expected) => expect(formatBytes(size)).toBe(expected));
it("includes both actual size and maximum, and disambiguates rounded boundary values", () => {
  expect(byteLimitMessage("Image", 6_300_000, 4_194_304)).toBe("Image is 6.3 MB; the limit is 4.2 MB.");
  expect(byteLimitMessage("Image", 20_000_001, 20_000_000)).toContain("20,000,001 > 20,000,000 bytes");
});
