# ArmorClaw Dashboard — Lovable.dev UI Rebuild Brief

> Generated 2026-05-07. Source: `wrapper/dashboard/server.ts`, `wrapper/security/permissions.ts`, `ui/src/ui/app-*.ts`.

---

## Section 1 — Tech Context

### What we're rebuilding

The ArmorClaw dashboard is a **localhost-only control panel** for a hardened AI agent runtime. It lives at `http://localhost:7390` (and the user's Tailscale URL). It is **not** a chat interface — messaging happens in Telegram/WhatsApp. The dashboard provides visibility, control, and approvals.

The current implementation is a **single inline HTML file** (`wrapper/dashboard/public/index.html`) with vanilla JavaScript. We want to replace it with a proper React app while keeping the same backend unchanged.

### Current stack (to be replaced)

| Layer | Current | New |
|---|---|---|
| Framework | Vanilla JS in a monolithic inline HTML file | **React 18 + Vite** |
| Styling | CSS custom properties, no utility classes | **Tailwind CSS** |
| Components | None (hand-rolled DOM) | **shadcn/ui** |
| State | Mutable globals, SSE-driven re-render | **React state + SSE hook** |
| Routing | Manual `view` variable | **React Router** (hash or memory router — no server routing) |

The upstream OpenClaw Control UI (`ui/src/ui/app-*.ts`) is a separate Lit web-component app embedded as an **iframe** inside the Advanced view. It is NOT being rebuilt — keep it as an iframe pointing to `http://127.0.0.1:18789/__openclaw__/canvas/`.

### API contract (no backend changes)

- All data comes from `GET /api/events` (SSE stream, pushes `DashboardSnapshot` every 5 s and on state change) or on-demand `GET /api/dashboard` (same shape, one-shot).
- Mutations are individual REST calls listed in Section 2.
- **Never** modify `wrapper/dashboard/server.ts` or any `wrapper/security/` files as part of this UI rebuild.

### Design system

Dark only. No light theme.

```
--ac-bg:            #0D0F14   (page background)
--ac-surface:       #13161E   (card/sidebar background)
--ac-surface2:      #1A1D27   (nested surfaces)
--ac-border:        #2A2D3A   (card borders — use 0.5px solid)
--ac-border-strong: #3A3D4E
--ac-text:          #E8E6FF   (primary text)
--ac-muted:         #8B8DA8   (secondary text)
--ac-hint:          #5A5C75   (placeholder / disabled)
--ac-teal:          #1DE9B6   (primary accent, running state)
--ac-teal-light:    #0D2E26   (teal tint background)
--ac-purple:        #9B6DFF
--ac-purple-light:  #1A1030
--ac-amber:         #FFB347   (warning)
--ac-amber-light:   #2A1F0A
--ac-red:           #FF5370   (error / security event)
--ac-red-light:     #2A0F14
--ac-blue:          #82AAFF   (pending approval)
--ac-blue-light:    #0F1A2E
```

**Typography:** Plus Jakarta Sans only. Weights: 400 body, 500 headings, 600 primary metrics. `DM Mono` reserved for code/API key display only — never for user-facing text.

**Spacing:** 4 px base, multiples of 4. Card radius 12 px. Button radius 8 px. Min tap target 44×44 px.

**Activity feed left borders (4 px solid):** pending approval = blue + blue-light tint; success = teal, no tint; security/error = red + red-light tint; warning/budget = amber + amber-light tint.

**Interactive hover:** `box-shadow: 0 0 12px rgba(29, 233, 182, 0.3)`.

---

## Section 2 — Full API Reference

### Base URL

```
http://localhost:7390
```

All endpoints bind to `127.0.0.1` only. The app should use relative URLs.

---

### 2.1 SSE Stream (primary data source)

#### `GET /api/events`

Server-Sent Events. Each `data:` frame is a JSON-serialised `DashboardSnapshot`. The server pushes on every state change and polls every 5 s. A `: ping` keepalive comment fires every 15 s.

**Connection:** open on app mount, reconnect with exponential backoff on close.

**`DashboardSnapshot` shape:**

```ts
{
  agentStatus: "running" | "paused" | "error";
  gatewayReachable: boolean;

  config: {
    modelProvider: string | null;       // "anthropic" | "openai" | "ollama"
    isLocal: boolean;
    activeProvider: string | null;
    ollamaReachable: boolean;
    ollamaModels: string[];
    sandboxDir: string | null;
  };

  channels: Array<{
    name: string;   // "Telegram" | "WhatsApp"
    url: string;    // deep-link URL
    icon: string;   // emoji
  }>;

  budget: {
    monthlyBudgetUSD: number;
    spentThisMonthUSD: number;
    percentUsed: number;             // 0–100+
    hardStopActive: boolean;
    atWarning: boolean;              // >= 80%
  };

  monthTokens: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUSD: number;
  };

  undo: {
    id: string;
    actionType: "email-draft" | "file-write";
    skill: string;
    expiresAt: string;             // ISO 8601
  } | null;

  pendingApprovals: Array<{
    id: string;
    skill: string;
    displayName: string;
    requestedAt: string;           // ISO 8601
    source: "local" | "gateway";
    toolParams: Record<string, unknown>;
  }>;

  feed: AuditEntry[];              // last 20, newest-first (see §2.2)

  skills: Array<{
    skillId: string;
    displayName: string;
    description: string;
    version: string;
    author: "bundled";
    permissionManifest: string[];
    undoable: boolean;
    recipeEligible: boolean;
    digestMention: boolean;
  }>;

  recipes: Array<{
    id: string;
    name: string;
    description: string;
    skill: string;
    defaultSchedule: string;
    scheduleLabel: string;
    undoable: boolean;
    active: boolean;              // RecipeWithState adds this
    currentSchedule: string;
  }>;

  connectedServices: {
    gmail: boolean;
    outlook: boolean;
  };

  tailscaleUrl: string | null;

  stripeCustomerPortalUrl: string;
  paymentLinkBase: string;

  license: {
    tier: string;                  // "trial" | "pro" | "inactive"
    installId: string;
    valid: boolean;
  };

  security: {
    injectionFilterActive: boolean;
    rejectionsToday: number;
    sparkline7d: number[];         // 7 values, index 0 = 6 days ago
    gatewayHost: string;           // always "127.0.0.1"
  };

  tokenBurn: {
    todayTokens: {
      inputTokens: number;
      outputTokens: number;
      estimatedCostUSD: number;
    };
    monthBySkill: Record<string, number>;   // skillId → USD
    dailyHistory30: Array<{
      date: string;                // "YYYY-MM-DD"
      inputTokens: number;
      outputTokens: number;
      estimatedCostUSD: number;
    }>;
    recentEvents: TokenEvent[];             // last 50, newest-first (see §2.9)
  };

  serverTime: string;              // ISO 8601
}
```

#### `AuditEntry` shape

```ts
{
  timestamp: string;               // ISO 8601
  skill: string;
  outcome: "success" | "rejected" | "error" | "undone";
  durationMs: number;
  permissionsUsed: string[];
  inputSummary?: string;           // first 80 chars, no secrets
  seq?: number;
  prevHash?: string;
  hmac?: string | null;
}
```

---

### 2.2 Snapshot (one-shot)

#### `GET /api/dashboard`

Returns the same `DashboardSnapshot` shape as the SSE stream. Use for initial load or manual refresh.

---

### 2.3 Agent Control

#### `POST /api/agent/pause`
No body. Response: `{ ok: true }`. Sets agent to paused — blocks all tool calls.

#### `POST /api/agent/resume`
No body. Response: `{ ok: true }`. Resumes agent.

---

### 2.4 Approvals

#### `POST /api/approvals/:id/approve`
Path param: `id` — the approval ID from `pendingApprovals[].id`. No body.
Response: `{ ok: boolean }`. `ok: false` means the ID was not found or already resolved.

#### `POST /api/approvals/:id/reject`
Same as approve. Resolves the gate as denied.

---

### 2.5 Undo

#### `POST /api/undo`
No body. Executes the in-memory undo entry if one exists and has not expired.
Response: `{ ok: boolean }`. `ok: false` = nothing to undo or already expired.

---

### 2.6 Budget

#### `POST /api/budget`
Request: `{ monthlyBudgetUSD: number }` — must be > 0.
Response: `{ ok: true }` or `{ ok: false, message: string }` (422).

#### `POST /api/budget/resume`
No body. Clears the hard-stop flag so model calls can resume.
Response: `{ ok: true }`.

---

### 2.7 Token Recording

#### `POST /api/tokens/record`
Request:
```ts
{
  provider?: string;        // "anthropic" | "openai" | "ollama" (default: "anthropic")
  model?: string;           // model ID (default: "unknown")
  skill?: string;           // skill ID (default: "chat")
  inputTokens?: number;
  outputTokens?: number;
}
```
Response: `{ ok: true, recorded: boolean, estimatedCostUSD: number }`.
`recorded: false` when both token counts are 0.

---

### 2.8 Settings — Model Provider

#### `POST /api/settings/provider`
Request:
```ts
{
  provider: "anthropic" | "openai" | "ollama";
  apiKey?: string;    // written to ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_BASE_URL
}
```
Response: `{ ok: true }` or 422.

#### `GET /api/settings/ollama-status`
Response:
```ts
{
  reachable: boolean;
  models: string[];
  isActive: boolean;
  isLocal: boolean;
}
```

---

### 2.9 Settings — Sandbox

#### `POST /api/settings/sandbox`
Request: `{ path: string }` — must be an absolute path.
Response: `{ ok: true }` or 422.

---

### 2.10 Settings — Launch on Startup

#### `GET /api/settings/launch-on-startup`
Response: `{ enabled: boolean }`.

#### `POST /api/settings/launch-on-startup`
Request: `{ enabled: boolean }`.
Response: `{ ok: true, enabled: boolean }` or 422.

---

### 2.11 Security — Browser Allowlist

#### `GET /api/security/browser-allowlist`
Response: `{ domains: string[] }`.

#### `POST /api/security/browser-allowlist/add`
Request: `{ domain: string }` — apex domain, e.g. `"github.com"`.
Response: `{ ok: true, domains: string[] }` or 422.

#### `DELETE /api/security/browser-allowlist/:domain`
Path param: URL-encoded domain. Response: `{ ok: true, domains: string[] }`.

---

### 2.12 Memory

#### `GET /api/memory`
Response: `{ ok: true, content: string, path: string }`.

#### `POST /api/memory/clear`
No body. Resets `memory.md` to a blank header.
Response: `{ ok: true }` or 500.

#### `POST /api/memory/open`
Opens memory.md in the system default editor.
Response: `{ ok: true }` or 500.

#### `GET /api/memory/vector-status`
Response: `{ ok: true, available: boolean, status: string }`.

#### `POST /api/memory/reindex`
Runs the OpenClaw vector indexer on the sandbox. May take up to 60 s.
Response: `{ ok: true, output: string }` or 500.

---

### 2.13 Audit Export

#### `GET /api/audit/export.csv`
Streams a CSV download of all audit entries.
Headers: `Content-Disposition: attachment; filename="armorclaw-audit-YYYY-MM-DD.csv"`.
Columns: `timestamp,skill,outcome,durationMs,permissionsUsed`.

---

### 2.14 Skills (bundled status)

#### `GET /api/skills/bundled`
Response: array of:
```ts
{
  id: string;
  displayName: string;
  description: string;
  version: string;
  status: "active" | "not_configured";
  missingConfig?: string;           // present only when not_configured
}
```

---

### 2.15 Recipes

#### `POST /api/recipes/:id/activate`
No body. Response: `{ ok: true }` or 422.

#### `POST /api/recipes/:id/deactivate`
No body. Response: `{ ok: true }` or 422.

#### `POST /api/recipes/:id/schedule`
Request: `{ cron: string }` — a valid cron expression.
Response: `{ ok: true }` or 422.

---

### 2.16 Channels

#### `GET /api/channels`
Response: `{ ok: true, channels: ChannelType[] }` where:
```ts
{
  id: string;            // "telegram"
  name: string;          // "Telegram"
  description: string;
  icon: string;          // emoji
  status: "active" | "not_configured" | "error";
  configurable: boolean;
}
```

#### `POST /api/channels/telegram/validate`
Request: `{ token: string }`.
Response: `{ ok: true, username: string }` or `{ ok: false, error: string }` (422).

#### `POST /api/channels/telegram/save`
Request: `{ token: string, username: string }` — `username` is the owner's Telegram handle (without @).
Response: `{ ok: true }` or 422/500.

#### `POST /api/channels/gateway/restart`
No body. Kills the running gateway and starts a fresh one.
Response: `{ ok: true, pid: number }` or 500.

---

### 2.17 Advanced

#### `GET /api/advanced/config`
Response: `{ ok: true, config: Record<string, unknown>, path: string }`. Auth token fields are redacted to `"••••••••"`.

#### `POST /api/advanced/start-gateway`
No body. Spawns the OpenClaw gateway process.
Response: `{ ok: true, pid: number }` or 500.

#### `POST /api/advanced/run-command`
Request: `{ command: string }` — the arguments after `openclaw`, e.g. `"status"` or `"update --dry-run"`.
Response: `{ ok: true, output: string }` or 500 `{ ok: false, message: string }`. Max 30 s timeout.

#### `POST /api/advanced/open-config`
No body. Opens `~/.openclaw/openclaw.json` in system editor.
Response: `{ ok: true }` or 500.

#### `POST /api/advanced/backup-config`
No body. Copies the launcher config directory to a timestamped backup path.
Response: `{ ok: true, path: string }` or 404/500.

#### `GET /api/advanced/gateway-probe`
Response: `{ ok: true, reachable: boolean }`.

#### `GET /api/advanced/openclaw-update`
Response: `{ ok: true, currentVersion: string, latestVersion: string, updateAvailable: boolean }` (exact shape from `openclaw-version-check.ts`).

---

### 2.18 Chat / Gateway Config

#### `GET /api/chat/gateway-config`
Returns WebSocket credentials for the OpenClaw gateway. Used by the chat panel.
Response:
```ts
{ wsUrl: "ws://127.0.0.1:18789", token: string }
// or on unavailable:
{ wsUrl: "ws://127.0.0.1:18789", token: "", error: string }   // HTTP 503
```

---

### 2.19 Danger Zone

#### `POST /api/reset`
Request: `{ confirm: "reset" }` — literal string required.
Deletes `~/.armorclaw/audit.log` and `~/.armorclaw/tokens.ndjson`.
Response: `{ ok: true, deleted: number }` or 422.

---

## Section 3 — Screen-by-Screen UI Spec

The sidebar has seven navigation items: **Home, Skills, Recipes, Security, Token Burn, Advanced, Settings**. Sidebar is 216 px wide on desktop; collapses to icon-only on mobile or via toggle. Brand mark + "ArmorClaw" wordmark at top. No light theme ever.

All views read from the live SSE snapshot. Mutations call the REST endpoints above and the SSE stream naturally refreshes the UI within ≤5 s.

---

### 3.1 Home

**Purpose:** primary at-a-glance view. Non-technical target.

**Data sources from snapshot:** `agentStatus`, `gatewayReachable`, `undo`, `pendingApprovals`, `budget`, `feed`, `recipes`.

**Layout (top to bottom):**

1. **Agent status pill** — `Running` (teal), `Paused` (amber), `Error` (red). Gateway reachability shown as a secondary dot. Pause/Resume button alongside.

2. **Undo banner** — conditional; shown when `undo !== null`. Format: `"[Action description] — Undo (Xs)"`. Countdown from expiry. Dismiss button. Auto-dismisses at expiry. Calls `POST /api/undo` on click.

3. **Pending approvals card** — hidden when `pendingApprovals.length === 0`. Blue left border + blue-light background tint. Each approval shows: `displayName`, `requestedAt` (relative time), and a collapsed `toolParams` JSON viewer (DM Mono). Approve + Reject buttons → `POST /api/approvals/:id/approve` and `reject`.

4. **Token burn summary** (simple widget only) — one sentence: `"You've spent $X.XX of your $Y budget."` + a progress bar. Teal below 80%, amber at 80–99%, red at 100%+. If hard-stop active: red banner `"Spending limit reached — agent is paused."` with Resume button → `POST /api/budget/resume`. `"See breakdown →"` link to Token Burn view.

5. **Activity feed** — last 20 entries, newest first. Each row: left border colour per outcome (see §1), timestamp (relative), skill name, outcome badge (`success`/`rejected`/`error`/`undone`), duration. No icons or coloured text within rows.

6. **Recipes shortcut row** — first 3 active recipes as compact cards with name + toggle.

---

### 3.2 Skills

**Purpose:** see and configure the three bundled skills.

**Data sources:** `skills` (from snapshot registry), `GET /api/skills/bundled`.

**Layout:**

Single section header: "ArmorClaw skills". One card per skill:
- Name + version badge
- Status: `Active` (teal) or `Not configured` (muted)
- Plain-English permission summary (derived from `permissionManifest`)
- Last run (from `feed`, filtered by skillId)
- `missingConfig` message when not configured
- Expandable "Last 5 runs" section (filter `feed` by skill)

No toggle to disable bundled skills. No add-skill button (user skill loading was permanently removed in 0.3.0).

---

### 3.3 Recipes

**Purpose:** manage named scheduled automations.

**Data sources:** `recipes` array from snapshot.

**Layout:**

Table or card list of all recipes. Each row/card:
- Name + schedule label (e.g. "Weekdays 8am")
- Active/Inactive toggle → `POST /api/recipes/:id/activate` or `deactivate`
- Underlying skill name
- Custom schedule input (cron expression) → `POST /api/recipes/:id/schedule`

Four bundled recipes in the default list: Morning inbox triage, Daily calendar briefing, Notify on new files, Weekly activity summary.

User can also have custom recipes (from `~/.armorclaw/recipes.json`). Same controls apply.

---

### 3.4 Security

**Purpose:** read-only status view. Security layer is always on — no disable toggles.

**Data sources:** `security` from snapshot, `pendingApprovals`.

**Layout:**

1. **Status indicators** (always-on, displayed as read-only badges):
   - Injection filter: Active (teal)
   - Permission engine: Active (teal)
   - Audit log: Active (teal)
   - Gateway bind: `127.0.0.1` (teal)

2. **Rejections today** — large number + sparkline bar chart (7-day, `sparkline7d`).

3. **Browser allowlist** — list of allowed domains from `GET /api/security/browser-allowlist`. Add domain input + Add button → `POST /api/security/browser-allowlist/add`. Remove button per row → `DELETE /api/security/browser-allowlist/:domain`.

4. **Recent security events** — filter `feed` where `outcome === "rejected"`, last 10.

5. **Audit integrity note** — static text: "Audit entries are HMAC-signed and chain-hashed. Use `npm run export:audit` to verify." No interactive elements — the audit-verify CLI is out of scope for v1 UI.

---

### 3.5 Token Burn

**Purpose:** detailed cost visibility.

**Data sources:** `tokenBurn`, `budget`, `monthTokens` from snapshot.

**Layout:**

1. **Budget meter** — `$X.XX spent of $Y.YY`. Progress bar (teal/amber/red). If hard-stop: red banner + Resume button.

2. **Today summary** — input tokens, output tokens, estimated cost.

3. **30-day daily history chart** — bar chart, one bar per day, Y-axis in USD. Source: `tokenBurn.dailyHistory30`.

4. **Spend by skill** — horizontal bar chart or table. Source: `tokenBurn.monthBySkill` (skillId → USD). Show human-readable skill names.

5. **Recent token events** — table, last 50 events. Columns: time, skill, provider, model, input tokens, output tokens, cost. Source: `tokenBurn.recentEvents`.

6. **Change budget** — inline number input → `POST /api/budget`. Positive numbers only.

---

### 3.6 Advanced

**Purpose:** power-user pass-through to OpenClaw internals. Amber warning banner at top: "Changes here affect the underlying OpenClaw runtime directly."

**Data sources:** `gatewayReachable` from snapshot, `GET /api/advanced/config`, `GET /api/advanced/gateway-probe`, `GET /api/advanced/openclaw-update`.

**Layout:**

1. **Amber warning banner** — always visible at top of this view.

2. **OpenClaw update notice** — shown when `updateAvailable === true` from `GET /api/advanced/openclaw-update`. Shows current vs latest version. "Update now" button → `POST /api/advanced/run-command` with `{ command: "update" }`. Never auto-updates.

3. **Gateway status** — shows reachable/unreachable. "Start gateway" button → `POST /api/advanced/start-gateway`. "Restart" button → `POST /api/channels/gateway/restart`.

4. **OpenClaw Canvas (iframe)** — embeds `http://127.0.0.1:18789/__openclaw__/canvas/` in an iframe. This is the upstream OpenClaw Control UI (Lit web components, not rebuilt here). Shows "Gateway offline" placeholder when not reachable.

5. **Command runner** — text input for OpenClaw CLI commands (e.g. `status`, `memory status`). Confirm dialog before execution. Output in a code block (DM Mono). → `POST /api/advanced/run-command`.

6. **Config viewer** — read-only JSON display of `openclaw.json`. Auth tokens shown as `••••••••`. → `GET /api/advanced/config`. "Open in editor" button → `POST /api/advanced/open-config`.

7. **Backup config** button → `POST /api/advanced/backup-config`. Shows backup path on success.

---

### 3.7 Settings

**Purpose:** configure the ArmorClaw installation.

**Data sources:** `config`, `connectedServices`, `channels`, `tailscaleUrl`, `stripeCustomerPortalUrl`, `license` from snapshot.

**Sub-sections (can be tabs or accordion):**

#### Model provider
Current provider pill (Anthropic / OpenAI / Ollama). Toggle between providers.
- Anthropic / OpenAI: API key input (masked) → `POST /api/settings/provider`.
- Ollama: base URL input, reachability status from `GET /api/settings/ollama-status`, models list.

#### Sandbox directory
Current path from `config.sandboxDir`. Read-only display (file picker not available in browser — show path + a note to use onboarding wizard to change). Actually expose a path text input → `POST /api/settings/sandbox` for power users.

#### Email (Gmail)
`connectedServices.gmail` shows connected/disconnected. Disconnected state: "Connect via onboarding wizard" note (no inline OAuth flow — app-password path only, managed through wizard).

#### Channels
List from `GET /api/channels`. For Telegram: token input → `POST /api/channels/telegram/validate` for live validation, then `POST /api/channels/telegram/save`. Shows bot deep-link when connected.

#### Budget
Monthly budget input. Current: `budget.monthlyBudgetUSD`. → `POST /api/budget`.

#### Startup
Launch on startup toggle → `GET` / `POST /api/settings/launch-on-startup`.

#### Tailscale
Detected URL displayed from `tailscaleUrl`. Static info: "Enable Tailscale Serve to access the dashboard remotely."

#### Memory
Memory file content viewer (read-only text area). Source: `GET /api/memory`.
- "Clear memory" button → `POST /api/memory/clear` (with confirmation dialog).
- "Open in editor" button → `POST /api/memory/open`.
- Vector index status from `GET /api/memory/vector-status`. "Re-index" button → `POST /api/memory/reindex` (spinner during 60 s operation).

#### Audit log export
"Download CSV" button → `GET /api/audit/export.csv`.

#### Subscription
"Manage subscription" link → `stripeCustomerPortalUrl`. Hidden if URL is empty. Trial banner if `license.tier === "trial"`.

#### Danger zone
"Reset ArmorClaw data" — deletes audit log and token history. Confirmation dialog requiring user to type `reset`. → `POST /api/reset`.

---

## Section 4 — Lovable Prompt

```
Build a React + Tailwind + shadcn/ui single-page application for "ArmorClaw" — a local desktop dashboard for a hardened AI agent runtime. The app runs at http://localhost:7390 on macOS and talks to a backend Express server on the same origin via REST and SSE.

**Design constraints — non-negotiable:**
- Dark theme only. No light mode, no toggle.
- Background #0D0F14. Surface #13161E. Surface-2 #1A1D27. Borders 0.5px solid #2A2D3A.
- Text #E8E6FF. Muted #8B8DA8. Hint #5A5C75.
- Primary accent (teal): #1DE9B6 with background tint #0D2E26.
- Warning (amber): #FFB347 / #2A1F0A. Error/security (red): #FF5370 / #2A0F14. Info/pending (blue): #82AAFF / #0F1A2E.
- Typography: Plus Jakarta Sans (400/500/600). DM Mono only for code/API keys/JSON — never for labels or body copy.
- Spacing: 4px base, multiples of 4. Card border-radius 12px. Button border-radius 8px.
- Interactive hover: box-shadow 0 0 12px rgba(29,233,182,0.3).
- Card border: 0.5px solid #2A2D3A. No drop shadows on cards.
- Activity feed entries use a 4px solid left border to indicate status — not icons, badges, or coloured text within the row.

**App structure:**
Fixed sidebar (216px on desktop) with navigation: Home, Skills, Recipes, Security, Token Burn, Advanced, Settings. Sidebar has brand mark "ArmorClaw" at top. On mobile or when collapsed: icon-only. All content in main area to the right.

**Data layer:**
- Open `GET /api/events` as an EventSource on app mount. Each `data:` message is a JSON `DashboardSnapshot` — use this as the primary state source. Reconnect with exponential backoff.
- Mutations call REST endpoints (all relative URLs — no hardcoded localhost). After each successful mutation, the SSE stream will push an updated snapshot within 5 seconds; no manual refetch needed.

**Seven views:**

HOME — Shows agent status pill (Running=teal, Paused=amber, Error=red) with pause/resume button. An undo banner (conditional, only when `snapshot.undo !== null`) showing action description + countdown to expiry + Undo button (POST /api/undo). Pending approvals card (hidden when empty) with blue-400/blue-light background: each approval shows tool name, requestedAt, collapsible tool params JSON, and Approve/Reject buttons (POST /api/approvals/:id/approve and /reject). Token burn widget: one sentence + teal/amber/red progress bar + "See breakdown" link. Activity feed: last 20 entries newest-first, each with a 4px solid left border coloured by outcome (teal=success, red=rejected/error, blue=pending), timestamp, skill name, outcome badge, duration in ms. Recipes shortcut: first 3 active recipes as compact cards.

SKILLS — One card per bundled skill (email-calendar, secure-files, browser). Each card shows name, version, active/not-configured status, permissions in plain English, and last-run time. No enable/disable toggle (security layer is always on). Expandable "last 5 runs" section per skill (filter the feed array).

RECIPES — Card or table list of all recipes. Each shows name, schedule label, active toggle (POST /api/recipes/:id/activate and /deactivate), underlying skill. Custom schedule input field (cron) → POST /api/recipes/:id/schedule.

SECURITY — Read-only status grid showing: injection filter, permission engine, audit log, gateway bind — all always Active (teal). Large "rejections today" number + 7-day sparkline bar chart. Browser allowlist: list of domains with add input (POST /api/security/browser-allowlist/add) and per-row delete button (DELETE /api/security/browser-allowlist/:domain). Recent rejected events from the feed.

TOKEN BURN — Budget meter with progress bar. Today's tokens summary. 30-day daily cost bar chart. Spend-by-skill horizontal bars. Recent 50 token events table (time, skill, provider, model, tokens, cost). Change budget input → POST /api/budget. Resume hard-stop button → POST /api/budget/resume (only when snapshot.budget.hardStopActive is true).

ADVANCED — Amber warning banner. OpenClaw update notice when available (GET /api/advanced/openclaw-update), with Update button (POST /api/advanced/run-command with {"command":"update"}). Gateway status + Start/Restart buttons. An iframe embedding http://127.0.0.1:18789/__openclaw__/canvas/ (this is a separate Lit app — do not rebuild it). Command runner text input + confirm dialog + output code block (POST /api/advanced/run-command). Read-only openclaw.json viewer with "Open in editor" button (POST /api/advanced/open-config). Backup config button (POST /api/advanced/backup-config).

SETTINGS — Sub-sections: Model provider (provider toggle + API key input → POST /api/settings/provider; Ollama reachability status GET /api/settings/ollama-status). Sandbox directory (path input → POST /api/settings/sandbox). Channels (Telegram token input with live validation POST /api/channels/telegram/validate, then save POST /api/channels/telegram/save). Budget (monthly limit → POST /api/budget). Launch on startup toggle (GET/POST /api/settings/launch-on-startup). Memory (viewer, clear button POST /api/memory/clear, open-in-editor POST /api/memory/open, re-index POST /api/memory/reindex). Audit CSV download (GET /api/audit/export.csv). Subscription link (stripeCustomerPortalUrl from snapshot). Danger zone: delete audit+token data (POST /api/reset with body {confirm:"reset"}, requires confirmation modal).

**Notable behaviour rules:**
- Dashboard never writes application state directly — all mutations go through the REST API.
- No disable toggles for security features (injection filter, permission engine, audit log). Display them as permanent green status indicators.
- Undo banner auto-dismisses when expiresAt passes (compute a local countdown from the ISO timestamp).
- Hard-stop budget state shows a red banner everywhere the token widget appears, not just Token Burn view.
- The Advanced view iframe is always rendered even when the gateway is unreachable; show a placeholder overlay if the iframe 404s or the gateway probe returns false (GET /api/advanced/gateway-probe).
- Fully responsive at 390px width (iPhone 15 viewport). All tap targets 44×44px minimum.
- Monospace (DM Mono) only for: API keys, JSON viewers, command output, code blocks. Never for navigation, headings, body copy, or metric numbers.
```

---

*End of brief. Questions: ping Emerson or read `wrapper/dashboard/server.ts` for the ground truth on any endpoint shape.*
