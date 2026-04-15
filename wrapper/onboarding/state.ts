/**
 * Onboarding wizard — in-memory session state.
 *
 * Single global instance (one wizard session per process). The state is
 * the source of truth for the wizard UI via SSE push and GET /api/state.
 */

import type { MobileChannel, ModelProvider, TailscaleStatus } from "./validators.ts";

export interface WizardState {
  /** 1-indexed current step (1-6). */
  currentStep: number;
  /** Steps whose data has been saved (not necessarily validated). */
  completedSteps: number[];

  // Step 1 — Model provider
  modelProvider?: ModelProvider;
  apiKeyMasked: boolean;

  // Step 2 — Sandbox directory
  sandboxDir?: string;

  // Step 3 — Email (Gmail IMAP/app password)
  gmailConnected: boolean;
  gmailAddress?: string;

  // Step 4 — Tailscale
  tailscaleStatus: TailscaleStatus;
  tailscaleUrl?: string;

  // Step 5 — Mobile channels
  tailscaleDeferred: boolean;
  connectedChannels: MobileChannel[];
  mobilePingReceived: boolean;
}

function makeInitialState(): WizardState {
  return {
    currentStep: 1,
    completedSteps: [],
    apiKeyMasked: false,
    gmailConnected: false,
    tailscaleStatus: "pending",
    tailscaleDeferred: false,
    connectedChannels: [],
    mobilePingReceived: false,
  };
}

let _state: WizardState = makeInitialState();

/** Returns a shallow copy of the current state (safe to serialise as JSON). */
export function getState(): Readonly<WizardState> {
  return { ..._state };
}

/** Merges a partial update into the global state. */
export function updateState(patch: Partial<WizardState>): WizardState {
  _state = { ..._state, ...patch };
  return getState() as WizardState;
}

/** Advances currentStep and records the previous step as completed. */
export function advanceStep(): WizardState {
  const prev = _state.currentStep;
  const completed = _state.completedSteps.includes(prev)
    ? _state.completedSteps
    : [..._state.completedSteps, prev];
  return updateState({
    currentStep: Math.min(prev + 1, 6),
    completedSteps: completed,
  });
}

/** Moves back one step. */
export function goBack(): WizardState {
  return updateState({ currentStep: Math.max(_state.currentStep - 1, 1) });
}

/** Resets the wizard to its initial state (used in tests). */
export function resetState(): void {
  _state = makeInitialState();
}

// ── SSE change notification ───────────────────────────────────────────────────

type StateListener = (state: WizardState) => void;
const _listeners = new Set<StateListener>();

export function onStateChange(fn: StateListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Call after any updateState / advanceStep / goBack to push to SSE clients. */
export function notifyListeners(): void {
  const snapshot = getState() as WizardState;
  for (const fn of _listeners) {
    try {
      fn(snapshot);
    } catch {
      // never let a broken listener crash the server
    }
  }
}
