/**
 * Phase 4 red-team finding: Protection 7 (Budget hard-stop) was BROKEN
 * because `wrapper/lib/model-adapter.ts:completeTagged()` made the API call
 * without consulting `isHardStopped()`. The marketing claim on
 * `site/security/index.html` says the model adapter "refuses further API
 * calls once monthly spend exceeds your cap", but until this fix that
 * statement was false — only `wrapper/digest/composer.ts` honored the flag.
 *
 * The fix imports `isHardStopped` and throws before the network call. This
 * test demonstrates the bypass is now closed: with the flag set, fetch is
 * never invoked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTagged } from "../../../lib/model-adapter.ts";
import { userDirect } from "../../../lib/source-tag.ts";
import { clearStoreForTesting, recordTokenEvent } from "../../../token-tracker/store.ts";

const ENV_KEYS = ["ARMORCLAW_MODEL_PROVIDER", "ANTHROPIC_API_KEY"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
  }
  process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
  process.env["ANTHROPIC_API_KEY"] = "sk-test-fake-key";
  clearStoreForTesting();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = SAVED_ENV[k];
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearStoreForTesting();
});

describe("Protection 7 — model adapter refuses API calls when hard-stopped", () => {
  it("does NOT call fetch once isHardStopped() returns true", async () => {
    // Push spend above the $20 default budget so the hard-stop flag flips.
    // recordTokenEvent.checkBudgetAlerts sets hardStoppedFlag = true at >=100%.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await recordTokenEvent({
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      skill: "test",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUSD: 25, // exceeds $20 default
    });

    await expect(completeTagged([userDirect("hi")])).rejects.toThrow(/monthly budget exhausted/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permits the call when the budget is intact", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: "ok" }],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeTagged([userDirect("hi")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
