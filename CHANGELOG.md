# Changelog

All notable changes to ArmorClaw are documented here. Format follows Keep a Changelog (https://keepachangelog.com).

## [Unreleased]

### Added
- Initial repo skeleton.
- Full IPC layer for workspace, project, chat, message, memory, and audit CRUD (desktop/src/main/ipc-handlers.ts).
- Repository module with typed query helpers mapping snake_case SQL to camelCase TS (desktop/src/main/repositories.ts).
- App state management: active workspace/project persistence across restarts, settings updates.
- Zustand app store with navigation, workspace/project selection, chat flow (desktop/src/renderer/stores/app-store.ts).
- Sidebar UI: workspace selector dropdown, project list, navigation (Chat/Brain/Commitments/Settings), conversation list.
- Chat view: message bubbles with user/assistant styling, suggestion chips, empty state with Emerson, streaming message display.
- Brain panel: three-layer progressive disclosure (overview -> project memories -> memory detail), FTS search, approve/reject controls.
- Settings view: General (model provider, personality, autonomy, missed-run policy, OpenClaw runtime), Account (email, subscription), Brain (per-project access mode), Audit log viewer.
- Commitments view shell with upcoming/active/paused sections.
- License worker: complete JWT implementation using Web Crypto API (sign, verify, magic-link tokens, license tokens with expiry).
- License worker: Stripe integration for customer lookup/creation, subscription management, Checkout session creation with 30-day trial.
- License worker: magic-link email sending via Resend API.
- Database tests: schema validation, cascade deletes, CRUD operations, FTS search, commitments, audit entries (8 tests).
- TypeScript configs: root base plus per-package configs for desktop and license-worker (strict mode, noUncheckedIndexedAccess).
- electron-vite config with main, preload, and renderer entry points.
- React renderer scaffold with Tailwind CSS (desktop/src/renderer/).
- Preload script with typed contextBridge API (desktop/src/preload/).
- Logger module for main process (replaces console.log per AGENTS.md).
- Database module (desktop/src/main/db.ts): better-sqlite3 at ~/Library/Application Support/ArmorClaw/, migration runner respecting schema_versions.
- OpenClaw detection and subprocess spawn (desktop/src/main/openclaw.ts): checks $PATH then common install paths, version validation, wrapper context injection.
- commitments and commitment_runs tables in 0001_initial.sql (ADR 0002).
- instructions_md columns on workspaces and projects.
- app_state columns: model_provider, model_api_key_keychain_ref, personality_mode, autonomy_default, missed_run_default, openclaw_latest_known, openclaw_advisory.
- Unit tests for wrapper-context.ts (8 tests covering content, token budget, platform scope).
- KV binding and nodejs_compat flag in license-worker wrangler.toml.
- ADR 0002: schema reconciliation.

- Onboarding state machine: full 9-step flow (welcome → email → verify → trial → OpenClaw → model key → safety → workspace → integrations → done) with progress bar, dev bypass, and re-initialization on completion.
- Onboarding wired into App shell with conditional rendering based on onboardingState.
- Deep-link protocol handler: `armorclaw://` scheme registered via electron-builder, `app.on('open-url')` routing for `auth?token=...` and `billing/return?session_id=...` callbacks, single-instance lock.
- Commitments scheduler: 30-second poll loop in main process, missed-run policy (ask/skip/next_wake), commitment CRUD repository, commitment_runs tracking.
- Commitments UI: expandable cards with status/next-fire/run-history, create form with interval/time/manual triggers, pause/resume/delete.
- In-app notification system: Zustand notification store, NotificationBell with unread badge, NotificationPanel dropdown, commitment events auto-create notifications.
- Workspace markdown export: dumps entire workspace tree (projects, chats, messages, memories, commitments) to `~/Documents/ArmorClaw Exports/`.
- Pre-seeded morning briefing: recurring commitment created after onboarding (autonomous, next_wake missed-run policy, 8 AM daily).

### Fixed
- electron-vite renderer build: removed explicit rollupOptions.input that broke path resolution with root config.
- .gitignore anchored build/ to repo root; desktop/build/entitlements.mac.plist is now tracked.
- Wrapper context says "macOS" instead of "macOS or Windows" (v1 scope).
- Release workflow drops Windows from matrix (v1 is macOS only).
- pnpm-workspace.yaml removed non-existent site package.
- License-worker: removed hand-rolled KVNamespace stub (covered by @cloudflare/workers-types).
- Stripe API version updated to 2025-02-24.acacia.
