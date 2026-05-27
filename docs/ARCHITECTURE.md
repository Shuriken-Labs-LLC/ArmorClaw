# ArmorClaw Architecture

This document describes the v1 architecture. Decisions in this doc are load-bearing for the v1 build. Changes require a written ADR.

## System overview

```
+-------------------------------+        +------------------------+
|   ArmorClaw Desktop (Electron)|        | Cloudflare Worker      |
|                               |  HTTPS | (license validator)    |
|  Renderer (React + Tailwind)  |<------>|                        |
|  Main (Node)                  |        |  -> Stripe API         |
|   |                           |        +------------------------+
|   +-> OpenClaw subprocess     |
|   +-> SQLite (brain store)    |        +------------------------+
|   +-> Filesystem (attachments)|        |  Stripe                |
|   +-> Keychain (macOS)        |        |  (subscriptions)       |
|   +-> Scheduler + notifier    |        +------------------------+
+-------------------------------+
```

The desktop app is the entire user-facing product. There is no backend storing user data. The only network egress from ArmorClaw itself goes to: the license validator (intermittent), Stripe Customer Portal (when the user clicks "Manage subscription"), the transactional email provider (magic links and scheduled briefings), the auto-update channel (which also carries OpenClaw's upstream version and advisory feed), and, in v1.x, the Telegram Bot API. Every other network call (LLM inference, MCP server calls) is made by OpenClaw or by the MCP servers it loads, not by ArmorClaw directly.

## Stack and rationale

Electron with TypeScript. v1 ships macOS only; Windows is a v1.1 fast-follow (see VISION). Electron is chosen partly because it keeps that fast-follow cheap from one codebase, and partly for its mature signing and notarization tooling and the team's prior experience. The cost is binary size (roughly 150 MB) and a broader attack surface than Tauri. Accepted.

Renderer UI: React 19 plus Tailwind. State management via Zustand or Jotai (decide in week 3 prototype). No Redux.

IPC: standard Electron contextBridge plus typed message channels. No remote module.

Local data store: SQLite via better-sqlite3 for structured data (workspaces, chats, messages, notes, memories, commitments, integrations, audit). Filesystem for attachments and large blobs. No ORM in v1. Hand-written SQL with a tiny query helper.

Build and packaging: electron-builder. Notarized DMG and zip for Mac (v1). NSIS installer for Windows comes with the v1.1 fast-follow.

License validator backend: a single Cloudflare Worker with no D1 storage. The Worker is stateless. It takes a request signed with the user's email, calls Stripe to check subscription status, returns a short-lived JWT signed with a server key. App caches the JWT and re-validates every 7 days.

Auth: magic link to email via Resend or Postmark. No passwords.

## Data model

All structured data lives in a single SQLite file at the platform-appropriate path.

### Containment hierarchy

Workspace -> Project -> Chat / Note / Memory / Commitment.

Workspaces are organizational containers (Work, Personal, Side projects). Projects are the unit of agent context (Q3 Launch, Hiring Lead Eng). Chats, notes, memories, and commitments belong to projects. Topics and entities are workspace-scoped tags applied to memories and surfaced as navigation. Editable instructions (the prose policy layer) are scoped at the workspace and project levels.

### Tables

workspaces: id (uuid), name, icon, color, sort_order, instructions_md (nullable; workspace-level prose policy), created_at, updated_at.

projects: id (uuid), workspace_id (fk), name, description, icon, color, sort_order, brain_mode (smart / manual / full), instructions_md (nullable; project-level prose policy that overrides or extends the workspace level), created_at, updated_at.

chats: id, project_id (fk), title, created_at, last_msg_at.

messages: id, chat_id (fk), role (user/assistant/system/tool), content, tool_calls (json), created_at.

notes: id, project_id (fk), title, content_md, created_at, updated_at.

note_tags: note_id (fk), tag. Composite primary key.

memories: id, project_id (fk), subject, value, summary, confidence (float), source_chat_id (nullable fk), source_message_id (nullable fk), status (proposed / approved / rejected), created_at, approved_at (nullable), updated_at, user_notes (free text).

entities: id (uuid), workspace_id (fk), name, type (person / project / event / organization / place / thing), aliases (json array), canonical_id (nullable; for future entity merging), created_at, updated_at.

memory_entities: memory_id (fk), entity_id (fk). Composite primary key.

topics: id (uuid), workspace_id (fk), name, description, last_used_at, use_count, created_at.

memory_topics: memory_id (fk, unique in v1), topic_id (fk). One topic per memory.

dossier_pins: id, topic_id (fk), content_md, generated_at, is_archived (bool).

commitments: id (uuid), workspace_id (fk), project_id (fk), description, trigger_type (time / interval / manual), trigger_spec (json: cron-like rule or one-shot timestamp), next_fire_at (nullable; denormalized so the scheduler can query cheaply), action_template (what the agent does on fire), reversibility (reversible / irreversible), autonomy (gated / autonomous), status (active / paused / done / failed), done_condition (nullable), missed_run_policy (ask / skip / next_wake; defaults to the global default), last_run_at (nullable), created_at, updated_at. Commitments are intent memory and are not part of the FTS index.

commitment_runs: id, commitment_id (fk), started_at, finished_at (nullable), outcome (completed / awaiting_approval / failed / skipped), detail. Each row also writes a line to the plain-text audit log; this table is the structured mirror of those entries.

attachments: id, project_id (fk), local_path, original_name, mime_type, size_bytes, created_at.

integrations: id, type (gmail / gcal / etc.), display_name, status (connected / disconnected / error), token_keychain_ref, last_used_at, created_at.

audit_entries: id, workspace_id (nullable), project_id (nullable), event_type, payload_json, created_at.

app_state: single-row table with user_email, license_jwt, license_expires_at, last_validated_at, openclaw_version, openclaw_path, openclaw_latest_known, openclaw_advisory (nullable), model_provider (openai / anthropic), model_api_key_keychain_ref, personality_mode (standard / unhinged; default standard), autonomy_default (gated / autonomous; default gated), missed_run_default (ask / skip / next_wake; default ask), telegram_bot_token_keychain_ref (nullable; v1.x).

### Full-text search

SQLite FTS5 virtual tables over notes.content_md, memories.subject + memories.value + memories.summary, messages.content, and entities.name + entities.aliases (for fast cross-walk lookups). No vector embeddings in v1.

## Storage paths

macOS: ~/Library/Application Support/ArmorClaw/ contains armorclaw.db, attachments/, audit.log, openclaw-stdout.log.

Windows: %APPDATA%/ArmorClaw/ with the same layout. (v1.1; v1 is macOS only.)

Secrets: never on disk in plaintext. macOS Keychain via keytar (the same library covers Windows Credential Manager for the v1.1 fast-follow). Stored items: integration OAuth tokens, the model API key, the Telegram bot token (v1.x), license JWT.

## Security floor

Four commitments. Not more.

Credentials in OS keychain. Never in config files, never in environment variables on disk, never in app_state plaintext columns.

Explicit user confirmation for irreversible actions before the agent performs them. Concretely: sending messages or emails, deleting files or records, making purchases, posting publicly. This holds even for unattended scheduled runs and even when the user appears to grant blanket permission in chat: a fired commitment runs until it completes or reaches an irreversible action, then pauses and notifies. The per-task autonomy toggle is keyed to reversibility. It can let reversible actions run hands-off, but it cannot disable the gate on irreversible ones except through a separate, deliberate, off-by-default opt-in that names the specific action. Approval surfaces in the chat UI and optionally as a push notification.

Plain-text audit log at audit.log. One line per agent action. Grep-able. No HMAC, no hash chains, no cryptographic signatures.

Sandboxing is delegated. ArmorClaw does not sandbox OpenClaw or its MCPs. We document this in onboarding so users know what they are running.

What we do not commit to: network egress allowlist in the app layer, code-signed audit entries, encrypted local database (the OS protects the disk), Linux support, mobile, FIPS anything.

## License and auth flow

First launch: app prompts for email. User enters email. App calls POST /auth/magic-link on the Worker. Worker generates a one-time token, emails the magic link. User clicks the link, which opens a deep link back into ArmorClaw (`armorclaw://auth?token=...`). App posts the token to /auth/exchange. Worker calls Stripe to look up subscription state for that email. Returns a JWT with sub_status (trialing / active / past_due / canceled / none) and an expires_at (now + 7 days).

App caches JWT in keychain. Re-validates every 7 days when online. Allows up to 30 days offline grace before forcing reconnect.

If sub_status is trialing or active: full app access.
If sub_status is anything else: app shows a "Subscription required" screen with a "Manage" button that opens the Stripe Customer Portal in the system browser.

Trial flow: when a new email is seen, Worker calls Stripe to create a customer and start a 30-day trial subscription against the $19.99/mo price. Payment method captured at trial start via Stripe Checkout opened in the system browser.

## Subscription self-service

Cancellation and refund happen inside the app, not over email. Three Worker endpoints back this:

POST /subscription/status. Verifies the JWT, calls Stripe to read the current subscription state, returns { sub_status, next_invoice_at, first_charge_at, refund_eligible_until }.

POST /subscription/cancel. For users in trial or users past the refund window. Verifies the JWT, calls stripe.subscriptions.cancel. For trial users this stops the upcoming first charge entirely. For paid users past the refund window, this sets cancel_at_period_end=true so the user keeps access through the end of their billing cycle, then the app locks.

POST /subscription/cancel-and-refund. For users still inside the 7-day refund window measured from first_charge_at. Verifies the JWT, verifies eligibility, pulls the latest paid invoice, calls stripe.refunds.create with reason='requested_by_customer', then cancels the subscription immediately. The app locks on the next license check.

After any cancel call, the app immediately calls /auth/refresh to get a fresh JWT with the updated sub_status. The lock screen appears within seconds, not at the next scheduled validation.

Refund abuse mitigation: the Worker tracks the payment method fingerprint of every customer who has used the auto-refund button. A second auto-refund to the same fingerprint within 12 months returns 403; the user can still email support for manual review. Storage: a single Cloudflare KV namespace keyed by fingerprint, value is the most recent refund timestamp. Refund-eligibility check is two KV reads plus the Stripe API call. Negligible cost.

In-app UI: Settings -> Subscription shows current state plus one of three buttons. Trial users see "End trial now." Paid users within refund window see "Cancel and refund." Paid users past the window see "Cancel subscription." The button copy is explicit about the outcome; no ambiguous "Manage" links.

## OpenClaw integration

Detection on first launch: check `$PATH` for the `openclaw` command, then check common install locations per OS. If found, capture the version and confirm it meets the minimum compatible version in package.json.

If absent or below minimum, show "Set up the OpenClaw runtime" screen. Single button runs the install command (currently `npm install -g @openclaw/cli`, subject to OpenClaw's distribution choices). Output streams into a UI panel with clear error surfacing. On failure, link to the OpenClaw install docs and the relevant troubleshooting page.

Version policy: by default, ArmorClaw uses whatever OpenClaw is on `$PATH`. Settings includes an "OpenClaw version pinning" toggle. Off (default) means we use the latest installed version. On means we pin to the version recorded at first install; the user gets a manual "upgrade OpenClaw" button.

Runtime and version transparency (non-optional). Settings -> Runtime always shows the installed OpenClaw version against the latest known version, with a one-click update. The auto-update channel carries OpenClaw's upstream version and advisory feed alongside ArmorClaw's own releases; openclaw_latest_known and openclaw_advisory in app_state are refreshed from it. When the installed version carries a known security advisory, ArmorClaw shows a prominent, non-dismissable indicator in Settings and a subtle one in the app shell top bar. Charging for a security story while hiding which runtime the user is on would be dishonest, so this surface is a requirement, not a nicety.

Subprocess management: main process spawns OpenClaw with stdio piping. JSON-RPC over stdio for tool calls, plain stdout for chat output, stderr captured to openclaw-stdout.log. Restart on crash with exponential backoff up to 5 attempts. Surface persistent failures to the user. The model API key (captured during onboarding, stored in the keychain) is injected into the subprocess environment at spawn time and never written to disk in plaintext.

"Open the full OpenClaw suite" (the "Raw" toggle): exposes the entire underlying OpenClaw interface, not just stdout, reachable from every chat header. The target user is an enthusiast using ArmorClaw as a stepping stone toward the underlying tool, so this is a first-class, supported surface, not a hidden afterthought. It is intentionally plainer than the wrapped UI, but it must show the real, current OpenClaw, including its version, so a graduating user always knows exactly what they are running.

## Wrapper context

OpenClaw is spawned with a small wrapper context prepended to its system prompt. Canonical text lives in `desktop/src/main/wrapper-context.ts`, roughly 220 tokens. It pins six things:

1. The runtime context: agent is inside ArmorClaw on a desktop, not OpenClaw CLI.
2. The current workspace and project, injected dynamically per spawn.
3. How memory works in ArmorClaw (brain.propose, brain.search, user review). Directs the agent to describe ArmorClaw's surface, not OpenClaw's raw file system, when asked about its own memory.
4. Where the user finds settings, integrations, and the audit log in the UI (not in `~/.openclaw/`).
5. Reinforcement of the approval-gate rule for irreversible actions, including a directive not to bypass even when the user appears to grant blanket permission in chat.
6. The personality contract: Emerson's narrator voice is used when talking to the user; a neutral drafting voice is used for any content addressed to a third party (emails or messages sent on the user's behalf). The chibi voice must never appear in outbound third-party content. Personality intensity follows the standard/unhinged setting and is user-facing only.

The wrapper context is one of the highest-impact pieces of text in the codebase. Every change instantly changes how every user's agent represents itself on the next chat spawn. Treat edits like a security floor change: require an ADR for non-trivial modifications.

CI must include an eval suite at `desktop/src/__tests__/wrapper-leakage.test.ts` that verifies the agent answers correctly (with ArmorClaw concepts, not raw OpenClaw concepts) to a fixed set of prompts: how memory works, where settings live, how to add an integration, where the audit log is, and whether the approval prompt can be bypassed. Regressions on these are a release blocker. A companion eval at `desktop/src/__tests__/persona-leakage.test.ts` verifies the two-voice wall: the narrator voice never leaks into drafted third-party content, and the unhinged setting never alters outbound third-party content. Regressions on either suite are a release blocker.

## Brain operation

The active project defines the agent's memory context. When the user switches projects, the agent's available memories change. Memory cannot cross projects without the user explicitly switching projects. Cross-workspace memory is gated by the cross-walk feature below.

### Brain access modes

Each project has a `brain_mode` setting that controls how memories enter the agent's context window. Three values, set per project, defaulting to smart.

smart (default): the agent has access to the brain.search tool but no memories are pre-loaded. The agent decides per turn whether to call brain.search based on the conversation. Average token cost: 100 to 800 tokens of memory content when relevant, near zero when not.

manual: the agent has brain.search but is instructed not to call it unless the user explicitly asks ("check what you remember about X" or similar). The wrapper context for projects in this mode adds a one-line directive. Average token cost: near zero unless the user requests lookup. Use for cost-sensitive long sessions or for chats where memory bleed is unwanted.

full: all approved memories for the project are loaded into the system prompt at chat start. No retrieval needed. Token cost is linear with memory count, roughly 50 to 80 tokens per memory. Practical limit around 200 memories before the context window hurts. The project settings UI warns if you switch to full with more than 100 memories.

The settings UI shows an estimated token cost per turn at the current project size, updated as memories grow. The mode setting takes effect on the next chat spawn within the project.

### brain.search

Signature: brain.search(query, limit?: number = 8). Returns the top N memories from the active project ordered by FTS5 rank against query. Each result includes id, subject, value, summary, topic, entities, and confidence. The agent is instructed in the wrapper context to prefer summary over full value for inclusion in its own response, citing memory ID when relevant.

### brain.propose

Signature: brain.propose with a structured payload: subject, value, summary, confidence, entities (each with type and name), topic, topic_is_new boolean, and suggested_project_id. Emits a review card in the chat UI with Approve, Edit, and Reject buttons. Topic and project are dropdowns on the card so the user can override before approving. Default focus is on the card body, not on Approve; Enter does not trigger Approve. Approved memories enter the memories table with status='approved' and trigger atomic inserts into memory_entities and memory_topics.

The propose card is generalized beyond memories. It is one primitive with four payloads: a new memory (brain.propose, above), a new commitment (commit.propose, see Commitments below), a reliability or safety setting change implied by an instructions edit, and the irreversible-action approval gate. All four share the same card chrome and the rule that Enter never approves. The gate variant never auto-approves and is the surface the security floor depends on.

### Save-time agent work

When proposing a memory, the agent does one additional LLM call beyond generating the proposal: classify entities, pick a topic from the workspace's existing topic list or propose a new one, and write a one-line summary. The wrapper supplies the workspace's topic list (most-recently-used first, capped at 30 entries) and entity list (capped at 50 entries) so the agent prefers existing labels over creating new ones. Approximate cost: 200 to 400 output tokens per memory, about $0.001 at current model pricing.

### Cross-walks

The user can run an explicit cross-walk on any memory or entity to find related items in other workspaces. Implementation is local (handled by the desktop app, not by the license worker) and runs entity-matching against the entities table across all workspaces. Result: a list of matched memories grouped by workspace and project, no content loaded into the active conversation. Each click is fresh; no persistent state is created. Bringing cross-workspace content into a chat requires manual copy-paste, which is intentional friction.

### Per-topic dossier

Generated on demand via a button on the topic detail view. The agent receives all approved memories under the topic and produces a structured human-readable briefing (typically 400 to 1000 words of markdown with section headers and in-line [Memory #N] citations). Dossiers can be pinned to a topic; pinning persists in dossier_pins. Regeneration creates a new version; old pins archive automatically. Every dossier has "Copy as markdown" and "Save to file" options.

### Workspace export

A "Export workspace" button in workspace settings writes a folder tree of plain markdown:

```
[workspace-name]/
  [project-name]/
    chats/
      2026-05-19-conversation-title.md
    notes/
      [note-title].md
    memories.md
    dossiers/
      [topic-name].md
  README.md
```

No proprietary format. This is the trust signal promised on the pricing page.

## Commitments and the scheduler (always-on)

Commitments are intent memory: things the agent will do, as distinct from things it knows. They live in the commitments table in the same SQLite brain file, scoped workspace then project like everything else, and they are not a memory type or part of the FTS index.

A lightweight scheduler in the main process owns execution. It runs whether or not a chat window is open; the app supports a tray presence and launch-at-login so it is on when the device is on. It polls next_fire_at, spawns the work through the same OpenClaw subprocess path, writes a commitment_runs row plus an audit line, and applies the missed-run policy when the device was off at the due time.

v1 triggers are time-based and manual only. Event-driven triggers ("when this email arrives") are deferred to v1.x because they pull in polling, webhooks, and per-connector wiring.

Autonomy and the gate. A fired commitment runs until it completes or reaches an irreversible action. Reversible actions can run hands-off when the commitment's autonomy is set to autonomous; an irreversible action always pauses for approval and notifies the user, regardless of autonomy, unless the user has made the separate, deliberate, named opt-in described in the security floor. Missed-run policy defaults to ask.

Briefings are commitments. The recurring "brief the user" job is an ordinary commitment with a pre-seeded sensible default (a short morning brief) the user can edit or delete. Briefings deliver via in-app and email in v1; Telegram is a v1.x channel.

"What's on there" reads directly from the commitments table (active and paused, grouped by next_fire_at). The agent answers the same question by querying the same table, so the spoken answer and the visual list cannot disagree.

## Instructions and the two-layer control model

ArmorClaw separates policy from contract. Editable prose instructions (workspaces.instructions_md and projects.instructions_md) are the policy: flexible, user-owned, edited as plain prose by someone who does not speak JSON. Structured records are the contract: the commitments table, the autonomy and missed-run settings, and the approval gate. The scheduler and the gate read the structured values, never the prose, so reliability and safety cannot be edited away in a sentence or misread at runtime.

The bridge between the two layers is the propose card. When a user edits instructions in a way that implies a structured change (a schedule, an autonomy default), the agent proposes the structured change for approval rather than reinterpreting the prose on each run.

## Integrations: Gmail and Google Calendar

Single Google OAuth flow with both scopes requested up front. Tokens stored in keychain. The ArmorClaw app does not call Gmail or GCal directly. It writes an MCP server config that points at the official Google MCP server (or our own thin wrapper if needed) with the stored credentials. OpenClaw picks up the config and loads the MCP on next start.

"Test connection" button after install: calls the MCP's healthcheck tool and verifies the response.

Token refresh: handled by the MCP server. If the refresh token is revoked, surface the error in the integrations panel with a "Reconnect" button.

## Notifications and briefings

Channels in v1 are in-app and email. The email channel reuses the transactional provider (Resend or Postmark) already used for magic links. Notifications and briefings are configurable per event type: long task complete, approval required, integration error, scheduled briefing.

Content addressed to the user (in-app, email briefings) uses Emerson's narrator voice. Content the agent drafts for a third party uses the neutral drafting voice; see the wrapper context.

Telegram is a v1.x channel, not v1. When it lands: Settings -> Telegram -> "Set up Telegram," create a bot with @BotFather, paste the bot token, send `/start`, the app polls `getUpdates` once to capture chat_id then stops. Outbound only, via HTTPS POST to api.telegram.org. Approval prompts over any channel only describe the action and direct the user to approve at the desktop surface; there is no remote-approval callback.

## Build and distribution pipeline

GitHub Actions: macos-14 for v1 (windows-2022 added with the v1.1 fast-follow). Build, sign, notarize, upload to Cloudflare R2.

Mac: notarized with Developer ID Application certificate. Hardened runtime. Stapled. Distributed as DMG and zip.

Windows (v1.1): signed with an EV or HSM-backed code-signing certificate. Distributed as NSIS installer and portable zip. SmartScreen reputation accrues over time, so early Windows builds will warn until it does; this is factored into the fast-follow plan.

Auto-update: electron-builder's autoUpdater pointing at a Cloudflare R2 bucket with the standard manifest. Each release publishes a `latest-mac.yml` and `latest.yml`. Auto-update is gated by license; self-compiled builds do not receive updates.

Release cadence: tagged releases trigger CI. No nightly channel in v1.

## Explicit non-features for v1

Cloud brain sync. (v2, only if 30%+ of paid users explicitly request within 6 months.)
Semantic / vector search across memories.
Persistent cross-workspace entity linking (e.g., "Sarah here is the same as Sarah there"). Cross-walks are explicit-each-time only.
Visual graph view of relationships (force-directed nodes and edges). v2 candidate; harder to make useful than to make pretty.
Auto-merging of duplicate memories. v1.1 candidate.
Multi-topic memories. A memory has exactly one topic in v1.
Memory expiry or auto-pruning. User prunes manually; suggestions ("12 memories untouched in 6 months — archive?") come in v1.1.
Web companion app.
Mobile companion app.
Windows support. (v1.1 fast-follow, gated on a stable Mac core.)
Linux support.
Skill or connection authoring UI. (Installing skills and connections is supported via the gallery, curated and community tiers with preview-before-install; authoring them in-app is deferred. The skills surface model is decided but still needs its own spec.)
HMAC or signed audit entries.
Network egress allowlist in the app layer.
In-app payment forms. (Use hosted Stripe Checkout.)
Telegram inbound commands. (v1.1.)
Event-driven commitment triggers ("when X happens"). (v1.x; v1 commitments are time-based and manual.)
Telegram briefing and notification channel. (v1.x; v1 uses in-app and email.)
Commitment markdown export. (v1.x.)
Avatar customization by the user or Emerson. (v1.x.)
Slack, Notion, GitHub, Linear integrations. (v1.1, prioritized by user demand.)
Team or multi-user features.
SSO.
On-prem deployment.

If a feature is not on the v1 list and not on the explicit v1.1 line in VISION.md, it is not on the roadmap.
