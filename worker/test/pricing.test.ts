import { describe, expect, it } from "vitest";
import { chargeableSeconds, chatMicros, transcriptionMicros } from "../src/usage/pricing";

describe("chargeableSeconds", () => {
  it("applies Groq's ten-second minimum", () => {
    expect(chargeableSeconds(1)).toBe(10);
    expect(chargeableSeconds(9.4)).toBe(10);
    expect(chargeableSeconds(10)).toBe(10);
  });

  it("rounds partial seconds up, so metering never under-charges", () => {
    expect(chargeableSeconds(12.1)).toBe(13);
    expect(chargeableSeconds(59.9)).toBe(60);
  });

  it("falls back to the minimum when the duration is missing or nonsense", () => {
    expect(chargeableSeconds(0)).toBe(10);
    expect(chargeableSeconds(Number.NaN)).toBe(10);
    expect(chargeableSeconds(-5)).toBe(10);
  });
});

describe("transcriptionMicros", () => {
  it("prices an hour of audio at the configured rate", () => {
    expect(transcriptionMicros(3600, 40_000)).toBe(40_000);
  });

  it("rounds up, so a rounding error never favours spending more", () => {
    expect(transcriptionMicros(10, 40_000)).toBe(112);
  });

  it("prices a full five-minute dictation at well under a cent", () => {
    expect(transcriptionMicros(300, 40_000)).toBe(3_334);
  });
});

describe("chatMicros", () => {
  it("prices input and output tokens separately", () => {
    expect(chatMicros(1_000_000, 0, 75_000, 300_000)).toBe(75_000);
    expect(chatMicros(0, 1_000_000, 75_000, 300_000)).toBe(300_000);
  });

  it("rounds a typical cleanup up to a whole micro-dollar", () => {
    expect(chatMicros(5_000, 5_000, 75_000, 300_000)).toBe(1_875);
  });
});
