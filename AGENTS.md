# ArmorClaw — CLAUDE.md

Source of truth for architecture rules, security constraints, and coding standards. When in doubt, ask before acting. Security constraints are non-negotiable.

---

## Obsidian session protocol

**Every session starts by reading the vault before any other work.**

Vault: `armorclaw/ArmorClaw Vault/`

- **Session start:** Read `Claude Protocol.md` and `Current State.md`. Confirm in 1-2 sentences, then proceed.
- **Session end:** Update `Current State.md` and create/append `Sessions/YYYY-MM-DD.md`.
- **Mid-session:** Log root causes, decisions, surprises. Don't narrate routine work.

The vault handles continuity. CLAUDE.md handles rules.

## Non-negotiable gates (enforced every session)

- **Commit check:** If there are uncommitted changes in the working tree, commit or stash them before starting new work. The build serves from `dist-src/` (a copy), not the working tree — uncommitted code is invisible to the live app.
- **Smoke test after index.html edits:** After any edit to `wrapper/dashboard/public/index.html`, run `npm run test:smoke` before moving to a live test. The dashboard JS is inline and untyped — the compiler won't catch runtime errors.

---

## Project overview

ArmorClaw is a hardened Electron wrapper around the OpenClaw open-source agent runtime, targeting freelancers and SMBs. Ships locked down by default with three bundled skills, a no-CLI onboarding wizard, a dashboard for visibility/control/approvals, daily digest, skill recipes, one-tap undo, and a security layer.

**Repo structure:**

The OpenClaw upstream fork lives at the repo root. ArmorClaw code lives entirely in `wrapper/` (plus `site/` for the landing page and `ArmorClaw Vault/` for session continuity).

```
armorclaw/
├── docs/, src/, ui/, skills/, packages/, .github/   ← OpenClaw upstream (treat as read-only)
├── README.md, CHANGELOG.md, VISION.md, ...          ← OpenClaw upstream root *.md files
├── AGENTS.md                                        ← ArmorClaw spec (CLAUDE.md is a symlink)
├── ArmorClaw Vault/                                 ← ArmorClaw session continuity (Cowork-managed)
├── site/                                            ← ArmorClaw landing page (armorclaw.app)
└── wrapper/                                         ← ArmorClaw code — all behaviour lives here
    ├── security/    ← injection-filter.ts, permissions.ts, audit-logger.ts
    ├── skills/      ← email-calendar, secure-files, browser (bundled only)
    ├── onboarding/, dashboard/, token-tracker/
    ├── digest/, recipes/, undo/
    ├── config/      ← gateway.ts, system-prompt.ts, models.ts
    ├── lib/         ← skill-registry.ts, model-adapter.ts, source-tag.ts, platform-paths.ts, ...
    └── tests/       ← ArmorClaw test suites
```

Note: `skills/` at the repo root is OpenClaw's; ArmorClaw's bundled skills are in `wrapper/skills/`. Don't conflate them.

**Runtime:** Node.js 22+, TypeScript throughout. No `.js` files in `wrapper/` or `tests/`.

---

## Core principles

1. **Security first.** Evaluate security surface before writing any code. Flag permission-broadening changes before proceeding.
2. **Minimal footprint.** Request the smallest permission set that makes a skill functional.
3. **Upstream separation.** Don't modify upstream OpenClaw paths at the repo root (`/docs`, `/src`, `/ui`, `/skills`, `/.github`, and root-level `*.md` files except `AGENTS.md`/`CLAUDE.md`) without a documented security reason. All ArmorClaw behaviour lives in `wrapper/`.
4. **Explicit over implicit.** No runtime auto-discovery of permissions or implicit elevation.
5. **Test security twice.** Injection filter, permission engine, audit logger each need unit + integration tests.

---

## Security architecture

### Injection filter — `wrapper/security/injection-filter.ts`

Pre-skill hook. Runs on every invocation, before any skill, without exception. Cannot be bypassed by calling a skill directly.

Reject inputs that:

- Contain instruction-override patterns ("ignore previous instructions", "you are now", "disregard your", "new system prompt", "pretend you are", semantic equivalents)
- Attempt to reference or rewrite the system prompt
- Contain base64 or other encoded payloads that decode to instruction patterns

On rejection: log to audit log (timestamp, skill target, reason, first 120 chars of input), return a structured error. Never silently swallow or partially execute. Filter must be synchronous.

Run `npm run test:security` before marking any injection filter change done.

### Permission engine — `wrapper/security/permissions.ts`

Every skill declares a static `PERMISSION_MANIFEST`. Validated at skill-load time. Manifests are immutable at runtime. Warn-and-confirm for most violations; hard block only for banned levels.

| Level               | Grants                                             |
| ------------------- | -------------------------------------------------- |
| `read:files`        | Read within sandbox directory only                 |
| `write:files`       | Write within sandbox directory only                |
| `read:email`        | Read email metadata and body (no send)             |
| `send:email`        | Compose and send (requires user confirmation flow) |
| `read:calendar`     | Read calendar events                               |
| `write:calendar`    | Create/modify calendar events                      |
| `browser:sandboxed` | Control dedicated ArmorClaw browser profile only   |
| `network:outbound`  | Outbound HTTP to explicitly allowlisted domains    |

**Hard blocks — never implement or accept:** `system:root`, `system:exec`, `files:global`, or any variant that escapes the sandbox.

### Gateway hardening — `wrapper/config/gateway.ts`

- Never expose on `0.0.0.0` or any public IP — throw hard error on startup.
- Gateway owns its auth token entirely. It writes the token to `openclaw.json` on startup. ArmorClaw reads it back after the gateway is confirmed reachable. ArmorClaw never generates or sets the token.
- Tokens: never logged, never in audit output, never in error messages.
- Tailscale Serve is the recommended tunnel method.

### Audit logger — `wrapper/security/audit-logger.ts`

Every skill invocation logs: ISO 8601 timestamp, skill name+version, permission levels used, input summary (first 80 chars, no secrets), outcome (`success`/`rejected`/`error`/`undone`), duration ms.

Logs → `~/.armorclaw/audit.log` (NDJSON). Logger must never throw — fail silently to in-memory buffer. `npm run export:audit` produces CSV.

### Source-tagger — `wrapper/security/source-tagger.ts`

Subscribed to OpenClaw's `tool_result_persist` lifecycle hook (mutation rights). Wraps external tool-result content in `<external-content>` framing via `renderForModel()` before it reaches the model's next-turn context. Allowlist-style: only tools listed in `TOOL_TO_SOURCE_TAG` get tagged. Unmapped tools pass through unchanged.

Current map:

| Tool                                 | Source tag      |
| ------------------------------------ | --------------- |
| `web_fetch`, `web_search`, `browser` | `external-web`  |
| `read`, `grep`                       | `user-file`     |
| `bash`, `exec`                       | `external-bash` |
| `pdf`, `image`                       | `user-file`     |

Mutation contract: returns a new message object with framed text content; `event.message` is never mutated in place. Image and other non-text content blocks pass through. Synchronous handler (the OpenClaw runtime calls `tool_result_persist` synchronously in the session-transcript append hot path).

Tools `bash` and `exec` are tagged `external-bash` by default. The exemption list `BASH_EXEMPT_PREFIXES` (empty by default) lets us exempt specific known-safe command prefixes (`pwd`, `whoami`, etc.) from framing. The exemption mechanism is wired but the per-command lookup is a no-op until Phase 2a introduces the side channel for tool-call params.

Tools `pdf` and `image` are tagged `user-file` (untrusted) for v1. Phase 3 may introduce a `media-attachment` distinction.

Phase 2 adds a content classifier on `before_prompt_build` (see below — Phase 2a `inbound-content-classifier.ts`) and may consolidate the source-tagger's framing with OpenClaw's existing per-tool wrapping (`src/security/external-content.ts`). Memory tagging (`before_prompt_build`) and vector tagging (`registerContextEngine`) are separate phases.

### Inbound content classifier — `wrapper/security/inbound-content-classifier.ts`

Subscribed to OpenClaw's `before_prompt_build` lifecycle hook (async; mutation rights are limited to system context). Each turn, walks the messages array for content the source-tagger framed as untrusted, classifies each previously-unseen block via the cheap variant of the user's configured model provider (`CLASSIFIER_MODEL_BY_PROVIDER` in `wrapper/config/classifier.ts`), and aggregates warnings into a single `prependSystemContext` for the upcoming model turn.

Decisions per score (default thresholds 0.7 reject / 0.4 warn):

- `score >= 0.7`: listed under "HIGH-RISK CONTENT REJECTED BY CLASSIFIER" in system context. Model is instructed to treat as data only and refuse user requests acting on it. Original content remains in the message log; audit log retains record.
- `0.4 <= score < 0.7`: listed under "ELEVATED-RISK CONTENT IN MESSAGE LOG" with weaker guidance.
- `score < 0.4`: no system-context entry.

Mediated interception, not hard redaction: `before_prompt_build`'s mutation rights are limited to system context (the messages array is read-only at this hook). The model sees both the framed content and the system warning; modern LLMs follow system-level security directives reliably. OpenClaw's `mergeBeforePromptBuild` (`src/plugins/hooks.ts:172-189`) concatenates `prependSystemContext` from multiple plugin handlers, so our warning composes additively with anything else.

Module-level cache keyed by `toolCallId` (or content hash when none) stores classification results across the session. Each unique framed block is classified once. Cache is cleared on `session_end`.

Fail-open: classifier timeout, error, parse failure, or no active provider all mean no system-context warning is added; source-tagger framing remains as the soft mitigation. Audit log records every classifier call under `skill: "classifier"` with cost attribution separately tracked in `tokens.ndjson` so the dashboard can show classifier spend distinct from agent spend.

Always-on by default. Disable via `ARMORCLAW_CLASSIFIER_DISABLED=true` env var (intended dashboard Advanced view toggle in Phase 2a follow-up). Disabling weakens indirect-injection mitigation and is not recommended for production.

Cost: ~$1/month at the $20 default budget on Anthropic (Haiku ~$0.0006/call; cached results so each unique tool result costs once per session).

---

## Source tagging — `wrapper/lib/source-tag.ts`

Every piece of content the model sees carries a permanent provenance tag. Skills wrap external content in `TaggedInput<T>` at ingestion. The model adapter renders inputs to the model with explicit "data not instruction" framing for untrusted-source content.

Tag values:

| Tag                   | Trust     | Origin                                                       |
| --------------------- | --------- | ------------------------------------------------------------ |
| `user-direct`         | trusted   | typed in chat window, Telegram, dashboard                    |
| `system`              | trusted   | wrapper-internal text, system prompt                         |
| `retrieved-memory`    | trusted   | pulled from `memory.md` (writes are gated separately)        |
| `user-file`           | untrusted | file content the agent reads from disk (sandbox or pointed)  |
| `external-email`      | untrusted | read from inbox via email-calendar skill                     |
| `external-web`        | untrusted | fetched by browser/web tools                                 |
| `external-attachment` | untrusted | file attached to an external email                           |
| `external-bash`       | untrusted | shell command output via OpenClaw's `bash`/`exec` tools      |
| `retrieved-vector`    | untrusted | OpenClaw vector index (may include indexed external content) |

**Rules:**

- Skills construct `TaggedInput` at the boundary where external content first enters the wrapper. Don't tag downstream of that point.
- Tags are immutable once constructed. Reuse a `TaggedInput` rather than retag.
- Untrusted content is wrapped in `<external-content>` framing by `renderForModel()` before reaching the model. Trusted content is passed through unframed.
- Phase 2 introduces an injection classifier that operates on untrusted-tagged content only; trusted content bypasses the classifier.
- `complete(prompt: string)` is a backward-compat shim. It auto-tags as `user-direct`. Skills that consume external content must migrate to `completeTagged()` and tag explicitly.

---

## Skills

Each skill: `wrapper/skills/<name>/index.ts`. Must export `SKILL_NAME`, `SKILL_VERSION` (semver), `PERMISSION_MANIFEST`, `run(input): Promise<SkillOutput>`. Skills never import from each other — shared utilities in `wrapper/lib/`.

### 1. Email + calendar (`email-calendar`)

Providers: Gmail / Google Calendar, Outlook / Microsoft 365. Provider adapter pattern — `adapters/gmail.ts` and `adapters/outlook.ts` implementing `IEmailCalendarAdapter`. Skill is provider-agnostic.

Capabilities: inbox triage, draft replies, schedule/retrieve events, daily briefing.

Constraints: OAuth tokens in system keychain via `keytar` only. Sending always requires user confirmation — never auto-send. Don't read emails older than 90 days unless explicitly requested. **Email OAuth is disabled for v1 launch** — wizard Step 3 is informational only. Code stays intact; re-enable when OAuth is production-ready.

### 2. Secure file access (`secure-files`)

Capabilities: read/write/move/delete within sandbox, summarise contents, watch directory.

Constraints: sandbox path set during onboarding, must be absolute, not `/` or a system dir. All paths validated with `path.resolve` against sandbox root. Traversal (`../`) rejected and logged. Deletes require explicit confirmation with file path + size shown. Never follow symlinks outside sandbox.

### 3. Browser automation (`browser`)

Capabilities: form fill, data extraction, navigation, screenshots, cookie management.

Constraints: dedicated Chromium profile at `~/.armorclaw/browser-profile` only — never the user's personal profile. No persistent cookies across sessions unless user opts in per domain. Don't automate login flows to unconfigured services. Headless by default; headed requires explicit config opt-in.

---

## Skill registry — `wrapper/lib/skill-registry.ts`

In-memory, rebuilt on every daemon restart. Only bundled skills register — user-authored skill loading was removed in 0.3.0 (Phase 1a of the security overhaul).

```typescript
interface ArmorClawSkillManifest {
  skillId: string; // unique kebab-case
  displayName: string; // shown in activity feed
  description: string; // one sentence
  version: string; // semver
  author: "bundled";
  permissionManifest: PermissionLevel[];
  undoable: boolean; // must also export undo() if true
  recipeEligible: boolean;
  digestMention: boolean;
}
```

Registration: call `registerSkill(manifest)` before the first tool call.

Registry rules:

- Banned permission levels → throws `PermissionLoadError` at load time.
- Duplicate `skillId` → throws `SkillRegistryError`.
- `undoable: true` without exported `undo()` → throws `SkillRegistryError` at load time, never at runtime.
- Unregistered skills still execute safely (security layer catches all tool calls) but appear as "Unknown skill" in dashboard.
- No persistent registry file. No filesystem auto-discovery. The registry only contains skills that bundled code explicitly registers at startup.

Query functions (read-only): `getSkill()`, `getAllSkills()`, `getBundledSkills()`, `isUndoable()`, `isRecipeEligible()`.

---

## Model providers — `wrapper/config/models.ts`

Selected via `ARMORCLAW_MODEL_PROVIDER` env var. Skills call `modelAdapter.complete(prompt)` — never import provider SDKs directly.

| Provider           | Env var             | Notes                          |
| ------------------ | ------------------- | ------------------------------ |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | Default                        |
| OpenAI (GPT)       | `OPENAI_API_KEY`    | Fully supported                |
| Ollama (local)     | `OLLAMA_BASE_URL`   | No key; user supplies base URL |

Ollama is a primary choice, not a fallback. Cloud: "conversations processed by provider". Local: "conversations stay on your computer — completely private". No automatic fallback between providers. Budget hard-stop applies to cloud providers only.

---

## Onboarding wizard — `wrapper/onboarding/`

Goal: non-technical user is talking to ArmorClaw from their phone before closing their laptop. 6 steps, all skippable except Step 1. Target: under 15 minutes.

| Step | Name               | Required | Notes                                                                                                  |
| ---- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| 1    | Model provider     | Yes      | Cloud vs Local sections. Validate key before advancing.                                                |
| 2    | Sandbox directory  | No       | File picker only, no manual path. Default: `~/Documents/ArmorClaw`.                                    |
| 3    | Email and calendar | No       | Informational "coming soon" for v1.                                                                    |
| 4    | Tailscale          | No       | Auto-detect. Three states: detected / not installed / deferred. "Learn more" expandable.               |
| 5    | Mobile channel     | No       | QR code + channel cards (Telegram recommended, WhatsApp, Discord, Slack). Greyed if Tailscale skipped. |
| 6    | Review and launch  | No       | Summary cards + live launch checklist.                                                                 |

Design rules: one screen per step, no scrolling, inline validation errors, progress indicator always visible, warm non-technical tone, no CLI steps required.

---

## Design system

Dark theme on all surfaces (dashboard, wizard, chat window). No light theme.

**Typography:** Plus Jakarta Sans for all UI text. Monospace (`DM Mono`) reserved for: code snippets, API key display, developer expandables, brand wordmark only. Weights: 400 body, 500 headings, 600 primary metrics. Never 700+.

**Colour palette:**

```
--ac-bg:           #0D0F14
--ac-surface:      #13161E
--ac-surface2:     #1A1D27
--ac-border:       #2A2D3A
--ac-border-strong:#3A3D4E
--ac-text:         #E8E6FF
--ac-muted:        #8B8DA8
--ac-hint:         #5A5C75
--ac-teal:         #1DE9B6
--ac-teal-light:   #0D2E26
--ac-purple:       #9B6DFF
--ac-purple-light: #1A1030
--ac-amber:        #FFB347
--ac-amber-light:  #2A1F0A
--ac-red:          #FF5370
--ac-red-light:    #2A0F14
--ac-blue:         #82AAFF
--ac-blue-light:   #0F1A2E
```

CSS variables throughout — no hardcoded hex in component code. Interactive elements: `box-shadow: 0 0 12px rgba(29, 233, 182, 0.3)` on hover.

**Spacing:** Base 4px, multiples: 8/12/16/24/32/48. Card radius 12px, button 8px, badge 20px. Card border: 0.5px solid `--ac-border`, no drop shadows. Min tap target 44×44px.

**Activity feed left borders (4px solid):**

- Pending approval: `--ac-blue` + `--ac-blue-light` tint
- Successful action: `--ac-teal`, no tint
- Security event / error: `--ac-red` + `--ac-red-light` tint
- Warning / budget: `--ac-amber` + `--ac-amber-light` tint

No icons, badges, or coloured text within feed items.

---

## Dashboard — `wrapper/dashboard/`

Local web UI, served on localhost + Tailscale URL only. Never a public IP. Not a chat interface — chat happens in messaging apps. Fully functional at 390px. All data from audit log + live config, no separate DB. SSE for live updates (5s poll).

**Views:** Home, Skills, Recipes, Security, Token Burn, Advanced, Settings.

**Home:** Agent status pill (Running/Paused/Error) → undo banner (conditional, 60s) → pending approvals card (hidden when empty, blue border) → token burn summary (simple view only: one sentence + progress bar + "See breakdown →") → activity feed (last 20, most recent first) → recipes shortcut row (first 3 active).

**Skills:** One card per skill. Two groups: "ArmorClaw skills" (bundled) / "Your skills" (user, "Built by you" label). Each card: name, version, Active/Inactive toggle, permissions in plain English, last run, expandable last-5-runs.

**Security:** Read-only status view. Injection filter, permission enforcement, and audit logging are always on — not user-configurable. Exposing disable toggles to non-technical users is a footgun with no legitimate use case; the security layer is a permanent feature. Status shown: total rejections today, 7-day sparkline, recent security events.

**Advanced:** Full-screen view with amber warning banner. Embeds OpenClaw Canvas UI (iframe at `/__openclaw__/canvas/`), command runner with confirm dialog, full `openclaw.json` config viewer. Security layer still runs on all tool calls. Commands execute as user, not privileged. Shows amber banner if OpenClaw update available (`update --dry-run --json`); never auto-updates.

**Settings:** Model provider/key, sandbox dir, email OAuth (coming soon), Tailscale, channels, budget, digest schedule, audit CSV export, Stripe Customer Portal link (hidden if `STRIPE_CUSTOMER_PORTAL_URL` not set).

Dashboard never writes application state. "Developer details" expandable for raw data — never shown by default.

---

## Daily digest — `wrapper/digest/`

Morning message to all connected channels. Sent at 8am local (configurable). Never skipped — if budget hard-stop active, send budget warning instead.

Content (4-6 sentences): what agent did yesterday → pending items → today's first 3 calendar events → token spend vs budget → one suggested recipe (optional, high-confidence only).

If agent was idle: "All quiet yesterday. Your next calendar event is [X]. Budget: $Y of $Z used."

Rules: plain warm first-person language. Never include raw token counts, model names, version numbers, permission strings, file paths, or API identifiers. Digest counts as a model API call → record with `skill: 'digest'`. If a skill's data is unavailable, omit and note "I couldn't reach your [X] — you may need to reconnect it in settings."

---

## Skill recipes — `wrapper/recipes/`

Named automations on a schedule. Executed by `wrapper/recipes/scheduler.ts` via `node-cron`.

```typescript
interface Recipe {
  id: string;
  name: string;
  description: string;
  skill: string;
  defaultSchedule: string;
  scheduleLabel: string;
  inputTemplate: RecipeInput;
  undoable: boolean;
}
```

Bundled library:
| Id | Name | Skill | Schedule |
|----|------|-------|----------|
| `morning-inbox` | Morning inbox triage | email-calendar | Weekdays 8am |
| `daily-briefing` | Daily calendar briefing | email-calendar | Weekdays 8am |
| `file-watcher` | Notify on new files | secure-files | Every 30 min |
| `weekly-summary` | Weekly activity summary | digest | Fridays 5pm |

Custom recipes stored in `~/.armorclaw/recipes.json`.

Rules: recipe runs go through injection filter and permission engine identically to interactive invocations — no bypass. Three consecutive failures → auto-deactivate + notify user. Token usage attributed to underlying skill + `recipe` field on `TokenEvent`. Never run more than one invocation of the same skill concurrently.

---

## One-tap undo — `wrapper/undo/`

In-memory only. 60-second window. Max one entry at a time (new action discards previous snapshot). Never persisted to disk.

**Undoable actions (v1 only — do not expand without approval):**
| Action | Undo behaviour |
|--------|---------------|
| Email draft sent for approval | Return to pending state |
| File write/move within sandbox | Restore from pre-op snapshot |

File delete and email send (after user approval) are NOT undoable.

```typescript
interface UndoEntry {
  id: string;
  actionType: "email-draft" | "file-write";
  skill: string;
  timestamp: string;
  expiresAt: string;
  snapshot: unknown;
  undoFn: () => Promise<void>;
}
```

Rules: snapshot captured synchronously before action executes — if capture fails, do not execute. `undoFn` must be idempotent. Undo logged with `outcome: 'undone'`. 100% unit test coverage required. "undo" / "undo that" in messaging channel within 60s also triggers undo.

Dashboard banner: "Reply drafted to Marcus Webb — Undo (58s)" — dismissible, auto-dismisses at expiry.

---

## Token tracker — `wrapper/token-tracker/`

```typescript
interface TokenEvent {
  timestamp: string;
  provider: "anthropic" | "openai" | "ollama";
  model: string;
  skill: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
}
```

Events → `~/.armorclaw/tokens.ndjson`. Read-only from dashboard. Pricing constants in `wrapper/token-tracker/pricing.ts`. Unknown model → `estimatedCostUSD: 0`, flagged as "cost unknown". Ollama → always `estimatedCostUSD: 0`.

Aggregations: `getTodayTokens()`, `getMonthTokens()`, `getMonthBySkill()`, `getMonthByProvider()`, `getDailyHistory(days)`, `getBudgetStatus()`.

Budget alerts (default $20/month):

- 80%: amber banner + messaging channel notification.
- 100%: **hard stop** — model adapter refuses further API calls until user resumes in dashboard or raises budget. A warning is not sufficient.

Token recording is fire-and-forget — never block skill response. Token store write failure → log and continue, never surface as a skill failure. Cost display: 2 decimal places under $1.00, cents above $1.00.

Home view: simple token widget only ("You've spent $X of your $Y budget." + progress bar). Full view on Token Burn page only.

---

## Testing standards

**Framework:** Jest + `ts-jest`. Actual test runner: `npx vitest run`.

Coverage requirements:

- `wrapper/security/` — 100%
- `wrapper/undo/` — 100%
- `wrapper/lib/skill-registry.ts` — 100%
- `wrapper/skills/` — 90%
- `wrapper/token-tracker/` — 90% (budget hard-stop: 100%)
- `wrapper/recipes/` — 85%
- `wrapper/digest/` — 80%
- `wrapper/onboarding/` — 75%
- `wrapper/dashboard/` — 75%

Security fixtures (`tests/fixtures/injection-payloads.ts`) must cover: instruction-override, role-jailbreak, encoded payloads (base64/URL/homoglyph), multi-turn injection, data exfiltration. Every fixture pattern needs a corresponding rejection test.

```bash
npm test | npm run test:security | test:skills | test:dashboard | test:tokens
npm run test:recipes | test:digest | test:undo | test:registry | test:watch
cd ~/armorclaw/wrapper && npx vitest run
```

---

## Build commands

```bash
# Dev (fast)
cd ~/armorclaw/wrapper/launcher && npm run start

# TypeScript only
cd ~/armorclaw/wrapper/launcher && npm run build:ts

# Full distributable
cd ~/armorclaw/wrapper/launcher && npm run build:mac

# Install
cp -r ~/armorclaw/wrapper/launcher/dist/mac-arm64/ArmorClaw.app /Applications/
```

---

## Git workflow

- Branch naming: `feature/`, `fix/`, `security/` prefixes.
- Security branches require full security test suite in CI before merge.
- Commit messages: imperative, present tense, under 72 chars.
- One logical change per commit.
- Never commit `.env`, keychain data, audit logs, or API keys.
- PR for every change — description must include: what, why, what tests cover it.

---

## Architecture notes

- **WebSocket protocol:** `type:"req"` frames, not JSON-RPC 2.0. Token read fresh from `~/.openclaw/openclaw.json` on every connection attempt. Exponential backoff, max 10 attempts.
- **Chat window:** Cmd+Shift+Space or tray. Frameless 420×600, remembers position. Gateway offline state after 30s timeout.
- **Memory — Layer 1:** `~/.armorclaw/memory.md` — plain text, date-prefixed entries, read by system prompt every session. Agent writes when user says "remember that...". Never deleted without confirmation.
- **Memory — Layer 2:** OpenClaw vector search indexes sandbox. Configured via `memory.paths` in `openclaw.json`.
- **Platform config paths** (`wrapper/lib/platform-paths.ts`): Mac `~/Library/Application Support/armorclaw-launcher/`, Windows `%APPDATA%\armorclaw-launcher\`, Linux `~/.config/armorclaw-launcher/`. Never hardcode Mac paths — use `getLauncherDataPath()`.
- **Advanced view:** BrowserView at `http://127.0.0.1:18789`. Sidebar offset 200px, banner offset 90px. Managed by `wrapper/launcher/dashboard-window.ts`.
- **Channels config:** `armorclaw-launcher/channels.json`. (Skills config no longer written — user skills are not supported.)
- **OpenClaw version monitoring:** Watch `https://github.com/openclaw/openclaw/releases.atom`. Pin version in `package.json`. Schema changes to channels/providers/gateway protocol can silently break ArmorClaw.

---

## Hard stops — never do these

- Modify upstream OpenClaw paths at the repo root (`/docs`, `/src`, `/ui`, `/skills`, `/.github`, and root-level `*.md` files except `AGENTS.md`/`CLAUDE.md`) without explicit instruction and a documented security reason. All ArmorClaw behaviour lives in `wrapper/`.
- Add a permission level not in the permissions table.
- Expose the gateway on a non-localhost address.
- Store API keys, OAuth tokens, or auth tokens outside `.env` or the system keychain.
- Disable, bypass, or add an exception to the injection filter.
- Auto-send email or auto-execute file deletions — user confirmation always required.
- Add a dependency with a known CVE (`npm audit` before any new package).
- Use `any` in TypeScript — use proper types or `unknown` with a type guard.
- `console.log` in production — use `wrapper/lib/logger.ts`.
- Let the dashboard write application state — it reads only.
- Expose token pricing constants or API key logic to the dashboard layer.
- Allow token budget enforcement to be bypassed silently — hard stop required.
- Skip the injection filter for scheduled recipe runs — recipes are not trusted input.
- Persist undo snapshots to disk.
- Skip the daily digest when budget is hit — send the budget warning message instead.
- Use monospace fonts for end-user-visible UI text.
- Use a light theme.
- Re-introduce user-skill loading in any form. Auto-discovery from `~/.armorclaw/skills/`, GitHub URL fetch+install, ClawHub catalog browse, and `skills.json` write paths were all removed in Phase 1a of the security overhaul (0.3.0). If user skills come back later they require a redesign with hash-pinning, signed manifests, and sandboxed execution — not just re-enabling.
- Persist the skill registry to disk.
- Allow a skill with `undoable: true` to load without exporting `undo()`.
- Bypass the ArmorClaw security layer from the Advanced view — it is a visibility pass-through, not a security bypass.
- Auto-update OpenClaw — user must explicitly trigger it from the Advanced view command runner.
