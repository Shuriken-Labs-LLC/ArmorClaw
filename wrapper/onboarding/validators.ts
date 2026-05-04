/**
 * Onboarding wizard — pure validation functions.
 *
 * All functions here are synchronous and free of I/O side-effects so that
 * they can be exhaustively unit-tested without a running server. Network
 * validation (test API calls) lives in server.ts route handlers.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Step 1 ──────────────────────────────────────────────────────────────────��─

export type ModelProvider = "anthropic" | "openai" | "ollama";

export interface Step1Data {
  provider: ModelProvider;
  apiKey?: string;
  ollamaUrl?: string;
}

export interface ValidationResult {
  ok: boolean;
  field?: string; // which field carries the error
  message?: string;
}

const MIN_API_KEY_LENGTH = 20;

export function validateStep1(data: Partial<Step1Data>): ValidationResult {
  if (!data.provider) {
    return {
      ok: false,
      field: "provider",
      message: "Please choose a model provider to continue.",
    };
  }

  if (data.provider === "anthropic") {
    const key = (data.apiKey ?? "").trim();
    if (!key) {
      return { ok: false, field: "apiKey", message: "Please enter your Anthropic API key." };
    }
    if (!key.startsWith("sk-ant-")) {
      return {
        ok: false,
        field: "apiKey",
        message:
          "That doesn't look like an Anthropic API key — they start with sk-ant-. Double-check you copied the whole thing.",
      };
    }
    if (key.length < MIN_API_KEY_LENGTH) {
      return {
        ok: false,
        field: "apiKey",
        message: "That key looks too short. Double-check you copied the whole thing.",
      };
    }
  }

  if (data.provider === "openai") {
    const key = (data.apiKey ?? "").trim();
    if (!key) {
      return { ok: false, field: "apiKey", message: "Please enter your OpenAI API key." };
    }
    if (!key.startsWith("sk-")) {
      return {
        ok: false,
        field: "apiKey",
        message:
          "That doesn't look like an OpenAI API key — they start with sk-. Double-check you copied the whole thing.",
      };
    }
    if (key.length < MIN_API_KEY_LENGTH) {
      return {
        ok: false,
        field: "apiKey",
        message: "That key looks too short. Double-check you copied the whole thing.",
      };
    }
  }

  if (data.provider === "ollama") {
    const url = (data.ollamaUrl ?? "").trim();
    if (!url) {
      return {
        ok: false,
        field: "ollamaUrl",
        message:
          "Please enter the address of your Ollama server. It usually looks like http://localhost:11434.",
      };
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          ok: false,
          field: "ollamaUrl",
          message: "The address should start with http:// or https://. Try http://localhost:11434.",
        };
      }
    } catch {
      return {
        ok: false,
        field: "ollamaUrl",
        message:
          "That doesn't look like a valid web address. It should look like http://localhost:11434.",
      };
    }
  }

  return { ok: true };
}

// ── Step 2 ────────────────────────────────────────────────────────────────────

export interface Step2Data {
  sandboxDir: string;
}

/** System directories that must never be used as the sandbox root. */
const FORBIDDEN_PATHS = [
  "/",
  "/bin",
  "/sbin",
  "/usr",
  "/usr/bin",
  "/usr/sbin",
  "/etc",
  "/var",
  "/tmp",
  "/System",
  "/Library",
  "/Applications",
  "/private",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
];

export function validateStep2(data: Partial<Step2Data>): ValidationResult {
  const dir = (data.sandboxDir ?? "").trim();
  if (!dir) {
    return { ok: false, field: "sandboxDir", message: "Please choose a folder to continue." };
  }
  // Must be an absolute path
  if (!dir.startsWith("/") && !/^[A-Za-z]:\\/.test(dir)) {
    return {
      ok: false,
      field: "sandboxDir",
      message: "Please choose a folder using the folder picker — don't type a path directly.",
    };
  }
  // Normalise: strip trailing slashes/backslashes but keep "/" itself representable
  const normalised = dir.replace(/[/\\]+$/, "") || "/";
  for (const forbidden of FORBIDDEN_PATHS) {
    if (
      normalised === forbidden ||
      normalised.startsWith(forbidden + "/") ||
      normalised.startsWith(forbidden + "\\")
    ) {
      return {
        ok: false,
        field: "sandboxDir",
        message:
          "That folder is a system folder. Please choose a folder inside your home directory, like ~/Documents/ArmorClaw.",
      };
    }
  }
  // Reject paths that ARE or CONTAIN ~/.armorclaw/ — that directory holds
  // the audit log; allowing the agent to write into it would let a poisoned
  // tool call rewrite its own forensic record.
  const armorclawDir = resolve(homedir(), ".armorclaw");
  const resolved = resolve(normalised);
  if (resolved === armorclawDir || armorclawDir.startsWith(resolved + "/")) {
    return {
      ok: false,
      field: "sandboxDir",
      message:
        "That folder contains ArmorClaw's own data directory (~/.armorclaw). Please choose a different folder, like ~/Documents/ArmorClaw.",
    };
  }
  return { ok: true };
}

// ── Step 3 ────────────────────────────────────────────────────────────────────

export interface Step3Data {
  gmailConnected: boolean;
}

export function validateStep3(_data: Partial<Step3Data>): ValidationResult {
  // Step 3 is always skippable — connection is optional.
  // If the user connected Gmail, it's already been validated by the IMAP test.
  return { ok: true };
}

// ── Step 4 — Tailscale ──────────────────────────────────────────────────────

export type TailscaleStatus = "detected" | "installing" | "deferred" | "pending";

export interface Step4Data {
  status: TailscaleStatus;
}

export function validateStep4(data: Partial<Step4Data>): ValidationResult {
  if (!data.status || data.status === "pending") {
    return {
      ok: false,
      field: "status",
      message: "Waiting for Tailscale to be detected — please wait a moment.",
    };
  }
  // 'deferred' is allowed — user consciously chose to skip
  // 'installing' requires polling to complete first
  if (data.status === "installing") {
    return {
      ok: false,
      field: "status",
      message:
        "Still waiting for Tailscale to install. Once you've installed it, this page will update automatically.",
    };
  }
  return { ok: true };
}

// ── Step 5 — Mobile channels ────────────────────────────────────────────────

export type MobileChannel = "telegram" | "whatsapp";

export interface Step5Data {
  connectedChannels: MobileChannel[];
  tailscaleDeferred: boolean;
}

export function validateStep5(data: Partial<Step5Data>): ValidationResult {
  if (data.tailscaleDeferred) {
    // Step was greyed out — skip is allowed
    return { ok: true };
  }
  const channels = data.connectedChannels ?? [];
  if (channels.length === 0) {
    return {
      ok: false,
      field: "channels",
      message: "Connect at least one messaging app so you can chat with ArmorClaw from your phone.",
    };
  }
  return { ok: true };
}

// ── Step 6 — Review & launch ────────────────────────────────────────────────

export interface Step6Data {
  provider: ModelProvider;
  sandboxDir: string;
  tailscaleUrl?: string;
  connectedChannels: MobileChannel[];
}

/** Step 6 is a review screen — nothing to validate, just check completeness. */
export function validateStep6(data: Partial<Step6Data>): ValidationResult {
  if (!data.provider) {
    return { ok: false, message: "Model provider is not configured." };
  }
  if (!data.sandboxDir) {
    return { ok: false, message: "Sandbox directory is not configured." };
  }
  return { ok: true };
}
