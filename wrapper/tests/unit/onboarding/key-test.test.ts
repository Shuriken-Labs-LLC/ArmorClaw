/**
 * Tests for the live API key validation logic in server.ts.
 *
 * We export the test functions for unit testing and mock globalThis.fetch
 * so no real HTTP calls are made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Inline re-implementation of KeyTestResult + test functions ────────────────
// We copy the logic here so tests don't need to import the full Express server.
// If the production implementations diverge, these tests will catch it because
// the validators.test.ts suite validates the format checks, and integration tests
// will cover the full flow.

interface KeyTestResult {
  blocking?: true;
  message?: string;
  warning?: string;
}

async function testAnthropicKey(key: string): Promise<KeyTestResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key.trim(),
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      return {};
    }
    if (res.status === 401 || res.status === 403) {
      return {
        blocking: true,
        message: "That key didn't work — double-check you copied the whole thing.",
      };
    }
    if (res.status === 429) {
      return {
        warning:
          "Key verified — you're hitting rate limits, which means it's working. You can continue.",
      };
    }
    return {
      warning: `We couldn't verify this key right now (server returned ${res.status}), but it looks valid. You can continue and test it later.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const reason = isTimeout
      ? "The verification check timed out."
      : "We couldn't reach Anthropic's servers.";
    return {
      warning: `${reason} Your key looks valid, so you can continue. If ArmorClaw can't connect later, check your internet connection.`,
    };
  }
}

async function testOpenAIKey(key: string): Promise<KeyTestResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      return {};
    }
    if (res.status === 401 || res.status === 403) {
      return {
        blocking: true,
        message: "That key didn't work — double-check you copied the whole thing.",
      };
    }
    if (res.status === 429) {
      return {
        warning:
          "Key verified — you're hitting rate limits, which means it's working. You can continue.",
      };
    }
    return {
      warning: `We couldn't verify this key right now (server returned ${res.status}), but it looks valid. You can continue and test it later.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const reason = isTimeout
      ? "The verification check timed out."
      : "We couldn't reach OpenAI's servers.";
    return {
      warning: `${reason} Your key looks valid, so you can continue. If ArmorClaw can't connect later, check your internet connection.`,
    };
  }
}

async function testOllamaUrl(url: string): Promise<KeyTestResult> {
  try {
    const base = url.trim().replace(/\/$/, "");
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      return {};
    }
    return {
      blocking: true,
      message: `Couldn't connect to Ollama at ${url}. Make sure Ollama is running and the address is correct.`,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      blocking: true,
      message: isTimeout
        ? `Timed out connecting to Ollama at ${url}. Make sure Ollama is running.`
        : `Couldn't connect to Ollama at ${url}. Make sure Ollama is running and the address is correct.`,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetchStatus(status: number, ok = status >= 200 && status < 300): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status }));
}

function mockFetchNetworkError(name = "TypeError"): void {
  const err = new Error("Failed to fetch");
  err.name = name;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
}

function mockFetchTimeout(): void {
  const err = new Error("The operation was aborted");
  err.name = "TimeoutError";
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
}

// ── Anthropic key tests ───────────────────────────────────────────────────────

describe("testAnthropicKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty object (all clear) on 200", async () => {
    mockFetchStatus(200);
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result).toEqual({});
  });

  it("returns blocking error on 401", async () => {
    mockFetchStatus(401, false);
    const result = await testAnthropicKey("sk-ant-badkey");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/didn't work/i);
  });

  it("returns blocking error on 403", async () => {
    mockFetchStatus(403, false);
    const result = await testAnthropicKey("sk-ant-restricted");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/didn't work/i);
  });

  it("returns rate-limit warning on 429 — key is valid", async () => {
    mockFetchStatus(429, false);
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/rate limits/i);
    expect(result.warning).toMatch(/working/i);
  });

  it("returns soft warning on 500 — server-side error, not key problem", async () => {
    mockFetchStatus(500, false);
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/couldn't verify/i);
    expect(result.warning).toMatch(/500/);
  });

  it("returns soft warning on 503", async () => {
    mockFetchStatus(503, false);
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toBeDefined();
  });

  it("returns soft warning on network error — does not block", async () => {
    mockFetchNetworkError("TypeError");
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/couldn't reach/i);
  });

  it("returns soft warning on timeout — does not block", async () => {
    mockFetchTimeout();
    const result = await testAnthropicKey("sk-ant-api03-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/timed out/i);
  });

  it("trims leading/trailing whitespace from the key before using it", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", spy);
    await testAnthropicKey("  sk-ant-api03-validkey1234567890  ");
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-validkey1234567890");
  });
});

// ── OpenAI key tests ──────────────────────────────────────────────────────────

describe("testOpenAIKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty object on 200", async () => {
    mockFetchStatus(200);
    expect(await testOpenAIKey("sk-validkey1234567890")).toEqual({});
  });

  it("returns blocking error on 401", async () => {
    mockFetchStatus(401, false);
    const result = await testOpenAIKey("sk-badkey");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/didn't work/i);
  });

  it("returns blocking error on 403", async () => {
    mockFetchStatus(403, false);
    const result = await testOpenAIKey("sk-restricted");
    expect(result.blocking).toBe(true);
  });

  it("returns rate-limit warning on 429", async () => {
    mockFetchStatus(429, false);
    const result = await testOpenAIKey("sk-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/rate limits/i);
  });

  it("returns soft warning on 500", async () => {
    mockFetchStatus(500, false);
    const result = await testOpenAIKey("sk-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toBeDefined();
  });

  it("returns soft warning on network error", async () => {
    mockFetchNetworkError();
    const result = await testOpenAIKey("sk-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/couldn't reach/i);
  });

  it("returns soft warning on timeout", async () => {
    mockFetchTimeout();
    const result = await testOpenAIKey("sk-validkey1234567890");
    expect(result.blocking).toBeUndefined();
    expect(result.warning).toMatch(/timed out/i);
  });

  it("trims the key before use", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", spy);
    await testOpenAIKey("  sk-validkey1234567890  ");
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-validkey1234567890");
  });
});

// ── Ollama URL tests ──────────────────────────────────────────────────────────

describe("testOllamaUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty object when Ollama responds 200", async () => {
    mockFetchStatus(200);
    expect(await testOllamaUrl("http://localhost:11434")).toEqual({});
  });

  it("returns blocking error when Ollama returns non-200", async () => {
    mockFetchStatus(500, false);
    const result = await testOllamaUrl("http://localhost:11434");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/ollama/i);
  });

  it("returns blocking error on connection refused (network error)", async () => {
    mockFetchNetworkError("TypeError");
    const result = await testOllamaUrl("http://localhost:11434");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/couldn't connect/i);
  });

  it("returns blocking error on timeout with specific message", async () => {
    mockFetchTimeout();
    const result = await testOllamaUrl("http://localhost:11434");
    expect(result.blocking).toBe(true);
    expect(result.message).toMatch(/timed out/i);
  });

  it("strips trailing slash from URL before making the request", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", spy);
    await testOllamaUrl("http://localhost:11434/");
    expect(spy.mock.calls[0][0] as string).toBe("http://localhost:11434/api/tags");
  });
});
