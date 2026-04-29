/**
 * Unit tests for completeTagged + complete shim in wrapper/lib/model-adapter.ts.
 *
 * We mock fetch at the global boundary so no real network calls are made.
 * The goal is verifying the prompt the provider receives — not the provider
 * SDK internals — so we use a single provider (anthropic) for these tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, completeTagged } from "../../../lib/model-adapter.ts";
import { tag, userDirect } from "../../../lib/source-tag.ts";

const ENV_KEYS = ["ARMORCLAW_MODEL_PROVIDER", "ANTHROPIC_API_KEY"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
  }
  process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
  process.env["ANTHROPIC_API_KEY"] = "sk-test-fake-key";
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
});

function mockOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text: "model reply" }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentPrompt(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls[0];
  expect(call).toBeDefined();
  const init = call?.[1] as { body: string } | undefined;
  expect(typeof init?.body).toBe("string");
  const body = JSON.parse(init?.body ?? "{}") as { messages: Array<{ content: string }> };
  return body.messages[0]?.content ?? "";
}

// ── completeTagged ───────────────────────────────────────────────────────────

describe("completeTagged", () => {
  it("sends an empty string when input array is empty", async () => {
    const fetchMock = mockOk();
    await completeTagged([]);
    expect(sentPrompt(fetchMock)).toBe("");
  });

  it("sends raw content for a single user-direct input (no framing)", async () => {
    const fetchMock = mockOk();
    await completeTagged([userDirect("hi")]);
    expect(sentPrompt(fetchMock)).toBe("hi");
  });

  it("wraps an external-email input in framing including description", async () => {
    const fetchMock = mockOk();
    await completeTagged([tag("body text", "external-email", "from: a@b.c")]);
    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain('<external-content source="external-email"');
    expect(prompt).toContain('description="from: a@b.c"');
    expect(prompt).toContain("body text");
    expect(prompt).toContain("</external-content>");
  });

  it("preserves order across mixed trusted and untrusted inputs", async () => {
    const fetchMock = mockOk();
    await completeTagged([
      userDirect("preamble"),
      tag("external content", "external-web"),
      userDirect("postamble"),
    ]);
    const prompt = sentPrompt(fetchMock);
    const idxA = prompt.indexOf("preamble");
    const idxFraming = prompt.indexOf("<external-content");
    const idxC = prompt.indexOf("postamble");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxFraming).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxFraming);
  });

  it("throws when ARMORCLAW_MODEL_PROVIDER is unset", async () => {
    delete process.env["ARMORCLAW_MODEL_PROVIDER"];
    await expect(completeTagged([userDirect("hi")])).rejects.toThrow(
      /No model provider configured/,
    );
  });
});

// ── complete (backward-compat shim) ──────────────────────────────────────────

describe("complete (backward-compat shim)", () => {
  it("produces the same provider call as completeTagged([userDirect(prompt)])", async () => {
    const fetchA = mockOk();
    await complete("hello world");
    const promptA = sentPrompt(fetchA);

    vi.unstubAllGlobals();

    const fetchB = mockOk();
    await completeTagged([userDirect("hello world")]);
    const promptB = sentPrompt(fetchB);

    expect(promptA).toBe(promptB);
    expect(promptA).toBe("hello world");
  });

  it("auto-tags a raw string as user-direct (no framing)", async () => {
    const fetchMock = mockOk();
    await complete("hello");
    const prompt = sentPrompt(fetchMock);
    expect(prompt).toBe("hello");
    expect(prompt).not.toContain("<external-content");
  });

  it("throws when ARMORCLAW_MODEL_PROVIDER is unset", async () => {
    delete process.env["ARMORCLAW_MODEL_PROVIDER"];
    await expect(complete("hi")).rejects.toThrow(/No model provider configured/);
  });
});
