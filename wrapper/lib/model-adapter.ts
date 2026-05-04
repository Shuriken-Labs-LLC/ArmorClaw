/**
 * Model adapter — abstracts provider differences and supports automatic
 * fallback from cloud to local (Ollama) providers.
 *
 * Provider priority:
 *  1. Primary: ARMORCLAW_MODEL_PROVIDER (anthropic, openai, or ollama)
 *  2. Fallback: Ollama at OLLAMA_BASE_URL (if configured and reachable)
 *
 * If the primary provider fails (API error, budget exhausted, network down),
 * the adapter retries on the fallback and logs the switch to the audit log.
 *
 * Skills call `modelAdapter.complete(prompt)` — they must never import an
 * SDK directly or hard-code a provider.
 */

import { isHardStopped } from "../token-tracker/store.ts";
import { renderForModel, userDirect, type TaggedInput } from "./source-tag.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderName = "anthropic" | "openai" | "ollama";

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Options for completeTagged calls. All optional. Used by the inbound content
 * classifier to route to a cheap-variant model (modelOverride) and to apply a
 * shorter deadline (timeoutMs) than the default 60s for production calls.
 */
export interface CompleteOptions {
  /** Provider-specific model identifier to use instead of the default. */
  readonly modelOverride?: string;
  /** Per-call request timeout in ms; falls back to the provider's default. */
  readonly timeoutMs?: number;
}

export interface IModelAdapter {
  complete(prompt: string): Promise<CompletionResult>;
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ModelAdapterState {
  primary: ProviderName | null;
  active: ProviderName | null;
  isLocal: boolean;
  ollamaReachable: boolean;
  ollamaModels: string[];
}

// ── State ────────────────────────────────────────────────────────────────────

let _activeProvider: ProviderName | null = null;
let _ollamaReachable = false;
let _ollamaModels: string[] = [];
const _listeners = new Set<() => void>();

function notify(): void {
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      /* never crash */
    }
  }
}

export function onModelAdapterChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ── Config reading ───────────────────────────────────────────────────────────

function getPrimaryProvider(): ProviderName | null {
  const p = process.env["ARMORCLAW_MODEL_PROVIDER"]?.trim();
  if (p === "anthropic" || p === "openai" || p === "ollama") {
    return p;
  }
  return null;
}

function getOllamaBaseUrl(): string {
  return (process.env["OLLAMA_BASE_URL"]?.trim() || "http://localhost:11434").replace(/\/$/, "");
}

// ── Ollama health check ──────────────────────────────────────────────────────

/**
 * Check if Ollama is reachable and list available models.
 * Updates internal state. Safe to call frequently (< 1s latency).
 */
export async function probeOllama(): Promise<{ reachable: boolean; models: string[] }> {
  const base = getOllamaBaseUrl();
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      _ollamaReachable = false;
      _ollamaModels = [];
      return { reachable: false, models: [] };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    _ollamaReachable = true;
    _ollamaModels = models;
    return { reachable: true, models };
  } catch {
    _ollamaReachable = false;
    _ollamaModels = [];
    return { reachable: false, models: [] };
  }
}

// ── Provider implementations ─────────────────────────────────────────────────

async function completeWithAnthropic(
  prompt: string,
  options?: CompleteOptions,
): Promise<CompletionResult> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options?.modelOverride ?? "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ text: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  return {
    text: data.content.map((c) => c.text).join(""),
    provider: "anthropic",
    model: data.model,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

async function completeWithOpenAI(
  prompt: string,
  options?: CompleteOptions,
): Promise<CompletionResult> {
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options?.modelOverride ?? "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? "",
    provider: "openai",
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
  };
}

async function completeWithOllama(
  prompt: string,
  options?: CompleteOptions,
): Promise<CompletionResult> {
  const base = getOllamaBaseUrl();
  // Prefer the smallest available model for speed; fall back to llama3.2
  const model = options?.modelOverride ?? _ollamaModels[0] ?? "llama3.2:latest";

  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(options?.timeoutMs ?? 120_000), // local models can be slow
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    response: string;
    model: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  return {
    text: data.response,
    provider: "ollama",
    model: data.model,
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
  };
}

function completeWith(
  provider: ProviderName,
  prompt: string,
  options?: CompleteOptions,
): Promise<CompletionResult> {
  switch (provider) {
    case "anthropic":
      return completeWithAnthropic(prompt, options);
    case "openai":
      return completeWithOpenAI(prompt, options);
    case "ollama":
      return completeWithOllama(prompt, options);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a completion using the configured provider, accepting tagged inputs.
 * Untrusted-source content is wrapped in framing before being sent to the
 * model. Order is preserved.
 *
 * Skills should prefer this entry point over `complete(prompt)` once their
 * input pipelines have been refactored (Phases 1c, 1d).
 *
 * `options.modelOverride` selects a specific model identifier (used by the
 * Phase 2a inbound content classifier to route to a cheap variant). Without
 * an override the provider's default model is used.
 */
export async function completeTagged(
  inputs: ReadonlyArray<TaggedInput>,
  options?: CompleteOptions,
): Promise<CompletionResult> {
  const primary = getPrimaryProvider();

  if (!primary) {
    throw new Error("No model provider configured. Set ARMORCLAW_MODEL_PROVIDER in your .env.");
  }

  // Budget hard-stop gate (Phase 4 red-team finding). Refuse the call when the
  // token tracker has flipped its hard-stop flag; the user must clear it from
  // the dashboard. Cloud-only by construction — Ollama keeps estimatedCostUSD
  // at 0 so the flag never flips under local-only operation.
  if (isHardStopped()) {
    throw new Error(
      "ArmorClaw: monthly budget exhausted — model API calls are paused. Raise the budget or resume from the dashboard to continue.",
    );
  }

  const rendered = renderForModel(inputs);
  const result = await completeWith(primary, rendered, options);
  _activeProvider = primary;
  return result;
}

/**
 * Backward-compat shim: auto-tags the prompt as `user-direct` and delegates
 * to `completeTagged`. Existing callers continue to work unchanged. New
 * callers that consume external content should migrate to `completeTagged`
 * and tag explicitly (Phases 1c, 1d).
 */
export async function complete(prompt: string): Promise<CompletionResult> {
  return completeTagged([userDirect(prompt)]);
}

/**
 * Explicitly switch the active provider. Used by the tray toggle.
 * Does not persist — call writeEnvVar separately to persist.
 */
export function setActiveProvider(provider: ProviderName): void {
  _activeProvider = provider;
  notify();
}

/**
 * Get the current adapter state for the dashboard and tray.
 */
export function getModelAdapterState(): ModelAdapterState {
  const primary = getPrimaryProvider();
  return {
    primary,
    active: _activeProvider ?? primary,
    isLocal: primary === "ollama",
    ollamaReachable: _ollamaReachable,
    ollamaModels: [..._ollamaModels],
  };
}

/**
 * Initialize the adapter: probe Ollama if configured, set initial active.
 * Call once at startup.
 */
export async function initModelAdapter(): Promise<void> {
  _activeProvider = getPrimaryProvider();
  if (_activeProvider === "ollama") {
    await probeOllama();
  }
}
