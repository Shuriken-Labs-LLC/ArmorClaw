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

const ENV_KEYS = [
  "ARMORCLAW_MODEL_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OLLAMA_BASE_URL",
] as const;
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

// ── completeTagged options (modelOverride / timeoutMs) ───────────────────────

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  const init = call?.[1] as { body: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

describe("completeTagged options — modelOverride", () => {
  it("uses default anthropic model when no override is provided", async () => {
    const fetchMock = mockOk();
    await completeTagged([userDirect("hi")]);
    expect(sentBody(fetchMock).model).toBe("claude-sonnet-4-6");
  });

  it("honors modelOverride on anthropic", async () => {
    const fetchMock = mockOk();
    await completeTagged([userDirect("hi")], { modelOverride: "claude-haiku-4-5-20251001" });
    expect(sentBody(fetchMock).model).toBe("claude-haiku-4-5-20251001");
  });

  it("honors modelOverride on openai", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await completeTagged([userDirect("hi")], { modelOverride: "gpt-4o-mini" });
    expect(sentBody(fetchMock).model).toBe("gpt-4o-mini");
  });

  it("uses default openai model when no override is provided", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        model: "gpt-4o",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await completeTagged([userDirect("hi")]);
    expect(sentBody(fetchMock).model).toBe("gpt-4o");
  });

  it("honors modelOverride on ollama", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    delete process.env["OLLAMA_BASE_URL"]; // exercise the default URL branch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: "ok",
        model: "llama3.2:1b",
        prompt_eval_count: 1,
        eval_count: 1,
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await completeTagged([userDirect("hi")], { modelOverride: "llama3.2:1b" });
    expect(sentBody(fetchMock).model).toBe("llama3.2:1b");
  });

  it("falls back to llama3.2:latest on ollama when no override and no probed models", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    process.env["OLLAMA_BASE_URL"] = "http://localhost:11434/";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: "ok",
        model: "llama3.2:latest",
        prompt_eval_count: 0,
        eval_count: 0,
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await completeTagged([userDirect("hi")]);
    expect(sentBody(fetchMock).model).toBe("llama3.2:latest");
  });
});

describe("completeTagged options — timeoutMs", () => {
  it("forwards a custom timeout to AbortSignal.timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = mockOk();
    await completeTagged([userDirect("hi")], { timeoutMs: 1234 });
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses 60s default on cloud providers when timeoutMs is omitted", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mockOk();
    await completeTagged([userDirect("hi")]);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it("uses 120s default on ollama when timeoutMs is omitted", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: "ok",
        model: "llama3.2:latest",
        prompt_eval_count: 0,
        eval_count: 0,
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await completeTagged([userDirect("hi")]);
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
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

// ── Provider error paths ─────────────────────────────────────────────────────

describe("provider error paths — anthropic", () => {
  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    await expect(complete("hi")).rejects.toThrow(/ANTHROPIC_API_KEY not configured/);
  });

  it("surfaces non-OK response with status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/Anthropic API error \(401\): unauthorized/);
  });

  it("tolerates a failing res.text() on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("read body failed");
        },
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/Anthropic API error \(500\):/);
  });
});

describe("provider error paths — openai", () => {
  beforeEach(() => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    delete process.env["OPENAI_API_KEY"];
    await expect(complete("hi")).rejects.toThrow(/OPENAI_API_KEY not configured/);
  });

  it("surfaces non-OK response with status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/OpenAI API error \(429\): rate limited/);
  });

  it("tolerates a failing res.text() on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("read body failed");
        },
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/OpenAI API error \(500\):/);
  });
});

describe("provider response fallbacks — branch coverage", () => {
  it("openai falls back to empty string when choices[0].message.content is missing", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [],
          model: "gpt-4o",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      }),
    );
    const result = await complete("hi");
    expect(result.text).toBe("");
  });

  it("ollama falls back to 0 when prompt_eval_count and eval_count are missing", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: "ok",
          model: "llama3.2:latest",
          // prompt_eval_count and eval_count intentionally absent
        }),
        text: async () => "",
      }),
    );
    const result = await complete("hi");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe("provider error paths — ollama", () => {
  beforeEach(() => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
  });

  it("surfaces non-OK response with status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "model not loaded",
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/Ollama error \(503\): model not loaded/);
  });

  it("tolerates a failing res.text() on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("read body failed");
        },
      }),
    );
    await expect(complete("hi")).rejects.toThrow(/Ollama error \(500\):/);
  });
});

// ── Module-state functions (fresh module per test) ───────────────────────────
//
// The functions below mutate module-level state (_activeProvider, _listeners,
// _ollamaReachable, _ollamaModels). vi.resetModules() + dynamic import gives
// each test a fresh copy of the module so state from one test cannot leak
// into another. Static imports above this line continue to reference the
// originally-loaded module instance and are unaffected.

describe("setActiveProvider + onModelAdapterChange (fresh module)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("setActiveProvider updates active and fires the listener", async () => {
    const { setActiveProvider, getModelAdapterState, onModelAdapterChange } =
      await import("../../../lib/model-adapter.ts");
    const listener = vi.fn();
    onModelAdapterChange(listener);
    setActiveProvider("openai");
    expect(getModelAdapterState().active).toBe("openai");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops the listener from being called", async () => {
    const { setActiveProvider, onModelAdapterChange } =
      await import("../../../lib/model-adapter.ts");
    const listener = vi.fn();
    const unsubscribe = onModelAdapterChange(listener);
    unsubscribe();
    setActiveProvider("anthropic");
    expect(listener).not.toHaveBeenCalled();
  });

  it("a throwing listener does not break notify or other listeners", async () => {
    const { setActiveProvider, onModelAdapterChange } =
      await import("../../../lib/model-adapter.ts");
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    onModelAdapterChange(throwing);
    onModelAdapterChange(good);
    expect(() => setActiveProvider("openai")).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("getModelAdapterState (fresh module)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("primary reflects ARMORCLAW_MODEL_PROVIDER when set", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().primary).toBe("anthropic");
  });

  it("primary is null when ARMORCLAW_MODEL_PROVIDER is unset", async () => {
    delete process.env["ARMORCLAW_MODEL_PROVIDER"];
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().primary).toBeNull();
  });

  it("primary is null for an unrecognized provider value", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "not-a-provider";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().primary).toBeNull();
  });

  it("isLocal is true when primary is ollama", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().isLocal).toBe(true);
  });

  it("isLocal is false when primary is anthropic", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().isLocal).toBe(false);
  });

  it("isLocal is false when primary is openai", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().isLocal).toBe(false);
  });

  it("ollamaModels starts as [] and ollamaReachable starts false on a fresh module", async () => {
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    const state = getModelAdapterState();
    expect(state.ollamaModels).toEqual([]);
    expect(state.ollamaReachable).toBe(false);
  });

  it("active falls back to primary when setActiveProvider has not been called", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    const { getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(getModelAdapterState().active).toBe("openai");
  });

  it("active reflects setActiveProvider call", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
    const { setActiveProvider, getModelAdapterState } =
      await import("../../../lib/model-adapter.ts");
    setActiveProvider("openai");
    expect(getModelAdapterState().active).toBe("openai");
  });
});

describe("probeOllama (fresh module)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns reachable + model list on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.2:latest" }] }),
      }),
    );
    const { probeOllama, getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(await probeOllama()).toEqual({ reachable: true, models: ["llama3.2:latest"] });
    const state = getModelAdapterState();
    expect(state.ollamaReachable).toBe(true);
    expect(state.ollamaModels).toEqual(["llama3.2:latest"]);
  });

  it("returns reachable with empty model list when none installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      }),
    );
    const { probeOllama } = await import("../../../lib/model-adapter.ts");
    expect(await probeOllama()).toEqual({ reachable: true, models: [] });
  });

  it("treats undefined models field as empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
    const { probeOllama } = await import("../../../lib/model-adapter.ts");
    expect(await probeOllama()).toEqual({ reachable: true, models: [] });
  });

  it("returns unreachable on non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { probeOllama, getModelAdapterState } = await import("../../../lib/model-adapter.ts");
    expect(await probeOllama()).toEqual({ reachable: false, models: [] });
    expect(getModelAdapterState().ollamaReachable).toBe(false);
  });

  it("returns unreachable when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { probeOllama } = await import("../../../lib/model-adapter.ts");
    expect(await probeOllama()).toEqual({ reachable: false, models: [] });
  });

  it("uses custom OLLAMA_BASE_URL when set", async () => {
    process.env["OLLAMA_BASE_URL"] = "http://my-server:11434";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { probeOllama } = await import("../../../lib/model-adapter.ts");
    await probeOllama();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url.startsWith("http://my-server:11434")).toBe(true);
  });

  it("strips trailing slash from custom OLLAMA_BASE_URL", async () => {
    process.env["OLLAMA_BASE_URL"] = "http://x:1/";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { probeOllama } = await import("../../../lib/model-adapter.ts");
    await probeOllama();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://x:1/api/tags");
  });
});

describe("initModelAdapter (fresh module)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets active provider from env", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
    const { initModelAdapter, getModelAdapterState } =
      await import("../../../lib/model-adapter.ts");
    await initModelAdapter();
    expect(getModelAdapterState().active).toBe("anthropic");
  });

  it("calls probeOllama (fetch) when provider is ollama", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "ollama";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { initModelAdapter } = await import("../../../lib/model-adapter.ts");
    await initModelAdapter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch when provider is anthropic", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "anthropic";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { initModelAdapter } = await import("../../../lib/model-adapter.ts");
    await initModelAdapter();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call fetch when provider is openai", async () => {
    process.env["ARMORCLAW_MODEL_PROVIDER"] = "openai";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { initModelAdapter } = await import("../../../lib/model-adapter.ts");
    await initModelAdapter();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets active to null when env unset", async () => {
    delete process.env["ARMORCLAW_MODEL_PROVIDER"];
    const { initModelAdapter, getModelAdapterState } =
      await import("../../../lib/model-adapter.ts");
    await initModelAdapter();
    expect(getModelAdapterState().active).toBeNull();
  });
});
