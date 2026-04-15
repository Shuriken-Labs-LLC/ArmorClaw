/**
 * Dashboard state — initial values for all mutable global variables.
 *
 * Zero dependencies: no DOM, no imports, no side-effects.
 * Canonical source for PR 2 of the dashboard JS extraction.
 *
 * Every field must be JSON-serializable (null, string, number, boolean,
 * plain object, or array). Non-serializable runtime types (WebSocket,
 * timer handles) initialise as null; browser code assigns the real
 * handle later.
 */

/** Server-pushed dashboard snapshot (shape defined by getDashboardSnapshot in server.ts). */
export interface DashboardSnapshot {
  [key: string]: unknown;
}

/** Pending skill install slot: code + filename + import source. */
export interface PendingInstall {
  [key: string]: unknown;
}

/** Channel type info as returned by /api/channels. */
export interface ChannelInfo {
  [key: string]: unknown;
}

/** The full shape of client-side dashboard state. */
export interface DashboardState {
  // ── Navigation ──
  activeView: string;

  // ── Advanced view ──
  advancedPollTimer: ReturnType<typeof setInterval> | null;
  advancedGatewayOnline: boolean;
  _updateBannerDismissed: boolean;

  // ── Dashboard snapshot ──
  dashState: DashboardSnapshot | null;

  // ── Rendering dedup guards ──
  _lastAgentStatus: string;
  _lastApprovalIds: string;
  _lastChannelIds: string;
  _lastBudgetKey: string;
  _lastFeedKey: string;

  // ── Undo ──
  undoDismissed: boolean;
  undoTickerId: ReturnType<typeof setInterval> | null;

  // ── Settings ──
  selectedProvider: string;

  // ── Token Burn ──
  tbBreakdownOpen: boolean;

  // ── Skills / ClawHub ──
  _bundledSkillsLoaded: boolean;
  _clawHubLoaded: boolean;
  _pendingInstall: PendingInstall | null;

  // ── Channels view ──
  channelsData: ChannelInfo[] | null;
  channelsLoaded: boolean;
  tgSetupOpen: boolean;
  tgValidated: boolean;
  tgBotUsername: string;

  // ── Chat connection ──
  chatDebugLog: string[];
  chatClickCount: number;
  chatClickTimer: ReturnType<typeof setTimeout> | null;
  chatGatewayUrl: string;
  chatGatewayToken: string;
  chatWs: WebSocket | null;
  chatConnected: boolean;
  chatAuthenticated: boolean;
  chatResponding: boolean;
  chatPendingId: string | null;
  chatResponseBuffer: string;
  chatLastUserMessage: string;
  chatMsgIdCounter: number;
  chatConnectId: string | null;
  chatChallengeNonce: string | null;

  // ── Chat retry ──
  chatRetryAttempts: number;
  chatRetryTimer: ReturnType<typeof setTimeout> | null;

  // ── Token tracking bridge ──
  chatLastSessionTokens: { input: number; output: number };
  chatUsagePendingCallbacks: Record<string, { inputText: string; outputText: string }>;
}

/** Initial values — one `var` per field is emitted by /dashboard-lib.js. */
export const INITIAL_STATE: Readonly<DashboardState> = {
  activeView: "home",
  advancedPollTimer: null,
  advancedGatewayOnline: false,
  _updateBannerDismissed: false,
  dashState: null,
  _lastAgentStatus: "",
  _lastApprovalIds: "",
  _lastChannelIds: "",
  _lastBudgetKey: "",
  _lastFeedKey: "",
  undoDismissed: false,
  undoTickerId: null,
  selectedProvider: "",
  tbBreakdownOpen: false,
  _bundledSkillsLoaded: false,
  _clawHubLoaded: false,
  _pendingInstall: null,
  channelsData: null,
  channelsLoaded: false,
  tgSetupOpen: false,
  tgValidated: false,
  tgBotUsername: "",
  chatDebugLog: [],
  chatClickCount: 0,
  chatClickTimer: null,
  chatGatewayUrl: "ws://127.0.0.1:18789",
  chatGatewayToken: "",
  chatWs: null,
  chatConnected: false,
  chatAuthenticated: false,
  chatResponding: false,
  chatPendingId: null,
  chatResponseBuffer: "",
  chatLastUserMessage: "",
  chatMsgIdCounter: 0,
  chatConnectId: null,
  chatChallengeNonce: null,
  chatRetryAttempts: 0,
  chatRetryTimer: null,
  chatLastSessionTokens: { input: 0, output: 0 },
  chatUsagePendingCallbacks: {},
};
