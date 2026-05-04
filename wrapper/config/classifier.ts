/**
 * Inbound content classifier configuration.
 *
 * The classifier (wrapper/security/inbound-content-classifier.ts) routes its
 * scoring calls through the cheap variant of the user's configured model
 * provider. This keeps the classifier always-on at low cost (~$1/month at
 * the $20 default budget on Anthropic).
 *
 * Thresholds are placeholders for v1 calibration. The integration test
 * tests/integration/classifier-calibration.test.ts asserts that the fixture
 * sets separate cleanly at these defaults; tune both fixtures and thresholds
 * together if calibration drifts.
 */

import type { ProviderName } from "../lib/model-adapter.ts";

/**
 * Provider → cheap-variant model identifier. The classifier picks the entry
 * matching the active provider; if none is set the classifier short-circuits.
 *
 * Pricing (per 1M tokens, ref wrapper/token-tracker/pricing.ts):
 *   claude-haiku-4-5-20251001 → $0.80 in / $4.00 out
 *   gpt-4o-mini               → $0.15 in / $0.60 out
 *   llama3.2:1b               → $0 (local)
 */
export const CLASSIFIER_MODEL_BY_PROVIDER: Readonly<Record<ProviderName, string>> = Object.freeze({
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  ollama: "llama3.2:1b",
});

export interface ClassifierThresholds {
  readonly reject: number;
  readonly warn: number;
}

/**
 * Score buckets:
 *   score >= reject : "HIGH-RISK CONTENT REJECTED" — model instructed to treat
 *                     as data only and refuse user requests acting on it.
 *   warn ≤ score < reject : "ELEVATED-RISK" — softer guidance.
 *   score < warn   : no system-context entry.
 */
export const CLASSIFIER_THRESHOLDS: ClassifierThresholds = Object.freeze({
  reject: 0.7,
  warn: 0.4,
});

/**
 * The classifier is always-on by default. Setting
 * `ARMORCLAW_CLASSIFIER_DISABLED=true` in the launcher env file (settable from
 * the dashboard's Advanced view) short-circuits the handler before any API
 * call, audit entry, or system-context mutation. The source-tagger framing
 * remains; only the hard mitigation is removed.
 */
export function isClassifierEnabled(): boolean {
  return process.env["ARMORCLAW_CLASSIFIER_DISABLED"]?.trim()?.toLowerCase() !== "true";
}
