import { describe, expect, it } from "vitest";
import { PRICING, calculateCost, isPricingKnown } from "../../../token-tracker/pricing.ts";

// ── PRICING table ─────────────────────────────────────────────────────────────

describe("PRICING table", () => {
  it("contains anthropic models", () => {
    expect("claude-sonnet-4-6" in PRICING).toBe(true);
    expect("claude-opus-4-6" in PRICING).toBe(true);
    expect("claude-haiku-4-5-20251001" in PRICING).toBe(true);
  });

  it("contains openai models", () => {
    expect("gpt-4o" in PRICING).toBe(true);
    expect("gpt-4o-mini" in PRICING).toBe(true);
  });

  it("does not contain ollama models (they have no fixed price)", () => {
    // Ollama is handled by provider check, not by model entry
    expect("llama3" in PRICING).toBe(false);
  });

  it("all entries have positive inputPer1M and outputPer1M", () => {
    for (const [_model, pricing] of Object.entries(PRICING)) {
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it("outputPer1M is always >= inputPer1M (output tokens cost more)", () => {
    for (const [, pricing] of Object.entries(PRICING)) {
      expect(pricing.outputPer1M).toBeGreaterThanOrEqual(pricing.inputPer1M);
    }
  });
});

// ── calculateCost ─────────────────────────────────────────────────────────────

describe("calculateCost", () => {
  it("returns 0 for ollama regardless of model or token count", () => {
    expect(calculateCost("ollama", "llama3", 10_000, 5_000)).toBe(0);
    expect(calculateCost("ollama", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(0);
  });

  it("returns 0 for unknown anthropic model", () => {
    expect(calculateCost("anthropic", "claude-unknown-99", 1_000_000, 1_000_000)).toBe(0);
  });

  it("returns 0 for unknown openai model", () => {
    expect(calculateCost("openai", "gpt-99-turbo", 1_000_000, 1_000_000)).toBe(0);
  });

  it("calculates correct cost for claude-sonnet-4-6 (1M input + 1M output)", () => {
    // inputPer1M: $3.00, outputPer1M: $15.00
    expect(calculateCost("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18.0);
  });

  it("calculates correct cost for claude-sonnet-4-6 (500k input + 200k output)", () => {
    // (500_000 / 1_000_000) * 3.00 + (200_000 / 1_000_000) * 15.00
    // = 1.50 + 3.00 = 4.50
    expect(calculateCost("anthropic", "claude-sonnet-4-6", 500_000, 200_000)).toBeCloseTo(4.5);
  });

  it("calculates correct cost for gpt-4o-mini (1M input + 1M output)", () => {
    // inputPer1M: $0.15, outputPer1M: $0.60
    expect(calculateCost("openai", "gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75);
  });

  it("calculates correct cost for gpt-4o (1M input + 1M output)", () => {
    // inputPer1M: $5.00, outputPer1M: $15.00
    expect(calculateCost("openai", "gpt-4o", 1_000_000, 1_000_000)).toBeCloseTo(20.0);
  });

  it("returns 0 when both token counts are 0", () => {
    expect(calculateCost("anthropic", "claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("scales linearly — doubling tokens doubles cost", () => {
    const half = calculateCost("anthropic", "claude-opus-4-6", 100_000, 50_000);
    const full = calculateCost("anthropic", "claude-opus-4-6", 200_000, 100_000);
    expect(full).toBeCloseTo(half * 2, 10);
  });

  it("calculates correct cost for claude-opus-4-6 (1M + 1M)", () => {
    // inputPer1M: $15.00, outputPer1M: $75.00
    expect(calculateCost("anthropic", "claude-opus-4-6", 1_000_000, 1_000_000)).toBeCloseTo(90.0);
  });
});

// ── isPricingKnown ────────────────────────────────────────────────────────────

describe("isPricingKnown", () => {
  it("returns true for a known anthropic model", () => {
    expect(isPricingKnown("anthropic", "claude-sonnet-4-6")).toBe(true);
  });

  it("returns true for a known openai model", () => {
    expect(isPricingKnown("openai", "gpt-4o")).toBe(true);
  });

  it("returns false for an unknown anthropic model", () => {
    expect(isPricingKnown("anthropic", "claude-unknown-99")).toBe(false);
  });

  it("returns false for an unknown openai model", () => {
    expect(isPricingKnown("openai", "gpt-99")).toBe(false);
  });

  it("returns true for any ollama model (always free)", () => {
    expect(isPricingKnown("ollama", "llama3")).toBe(true);
    expect(isPricingKnown("ollama", "mistral")).toBe(true);
    expect(isPricingKnown("ollama", "completely-unknown-model")).toBe(true);
  });
});
