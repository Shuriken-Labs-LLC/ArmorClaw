# Changelog

All notable changes to ArmorClaw are documented here. Format follows Keep a Changelog (https://keepachangelog.com).

## [Unreleased]

### Added
- Initial repo skeleton.
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

### Fixed
- .gitignore anchored build/ to repo root; desktop/build/entitlements.mac.plist is now tracked.
- Wrapper context says "macOS" instead of "macOS or Windows" (v1 scope).
- Release workflow drops Windows from matrix (v1 is macOS only).
- pnpm-workspace.yaml removed non-existent site package.
- License-worker: removed hand-rolled KVNamespace stub (covered by @cloudflare/workers-types).
- Stripe API version updated to 2025-02-24.acacia.
