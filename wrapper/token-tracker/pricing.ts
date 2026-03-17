// ── Types ────────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "ollama";

/** Per-million-token input and output prices in USD. */
export type ModelPricing = {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
};

// ── Pricing table ─────────────────────────────────────────────────────────────
//
// Prices are per 1 million tokens, in USD.
// Update this table when providers adjust their pricing.
// When a model is absent, calculateCost() returns 0 and isPricingKnown() returns false.

export const PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4.0 },
  // Legacy Anthropic aliases
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  "gpt-4o": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4": { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  o1: { inputPer1M: 15.0, outputPer1M: 60.0 },
  "o1-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },

  // Ollama models are intentionally absent — they are always free (cost = 0).
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calculate the estimated cost in USD for a model API call.
 *
 * - Ollama always returns `0` (local model, no cost).
 * - Unknown models return `0`; callers should use `isPricingKnown()` to surface a
 *   "cost unknown" indicator in the UI.
 */
export function calculateCost(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === "ollama") {
    return 0;
  }
  const pricing = PRICING[model];
  if (!pricing) {
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * Returns `true` when the tracker knows the price for this provider/model pair.
 * Ollama is always "known" (free by definition).
 * Returns `false` for any unrecognised model — the UI should show "cost unknown".
 */
export function isPricingKnown(provider: Provider, model: string): boolean {
  if (provider === "ollama") {
    return true;
  }
  return model in PRICING;
}
