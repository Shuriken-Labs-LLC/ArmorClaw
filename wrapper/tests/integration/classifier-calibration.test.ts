/**
 * Classifier calibration test.
 *
 * Asserts that the v1 default thresholds in wrapper/config/classifier.ts
 * separate the injection corpus from the clean corpus cleanly. Operates on
 * the fixture-declared `expectedScore` values (no real API calls).
 *
 * The bar:
 *   - ≥80% of INJECTION_FIXTURES at-or-above CLASSIFIER_THRESHOLDS.reject
 *   - ≥85% of CLEAN_FIXTURES strictly below CLASSIFIER_THRESHOLDS.warn
 *
 * If a real-API calibration run reports drift, the fix is to tune the
 * fixture set OR the thresholds — not to lower the assertion bar here.
 */

import { describe, expect, it } from "vitest";
import { CLASSIFIER_THRESHOLDS } from "../../config/classifier.ts";
import { CLEAN_FIXTURES } from "../fixtures/external-content-clean.ts";
import { INJECTION_FIXTURES } from "../fixtures/external-content-injection.ts";

describe("classifier calibration", () => {
  it("INJECTION_FIXTURES has at least 20 samples", () => {
    expect(INJECTION_FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("CLEAN_FIXTURES has at least 20 samples", () => {
    expect(CLEAN_FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("≥80% of injection fixtures expected at or above the reject threshold", () => {
    const aboveReject = INJECTION_FIXTURES.filter(
      (f) => f.expectedScore >= CLASSIFIER_THRESHOLDS.reject,
    ).length;
    const ratio = aboveReject / INJECTION_FIXTURES.length;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("≥85% of clean fixtures expected below the warn threshold", () => {
    const belowWarn = CLEAN_FIXTURES.filter(
      (f) => f.expectedScore < CLASSIFIER_THRESHOLDS.warn,
    ).length;
    const ratio = belowWarn / CLEAN_FIXTURES.length;
    expect(ratio).toBeGreaterThanOrEqual(0.85);
  });

  it("expected scores are bounded to [0, 1]", () => {
    for (const f of [...INJECTION_FIXTURES, ...CLEAN_FIXTURES]) {
      expect(f.expectedScore).toBeGreaterThanOrEqual(0);
      expect(f.expectedScore).toBeLessThanOrEqual(1);
    }
  });

  it("fixture names are unique within each corpus", () => {
    const injectionNames = new Set(INJECTION_FIXTURES.map((f) => f.name));
    expect(injectionNames.size).toBe(INJECTION_FIXTURES.length);
    const cleanNames = new Set(CLEAN_FIXTURES.map((f) => f.name));
    expect(cleanNames.size).toBe(CLEAN_FIXTURES.length);
  });
});
