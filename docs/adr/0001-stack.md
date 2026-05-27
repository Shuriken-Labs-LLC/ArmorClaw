# 0001 — Stack: Electron + pnpm monorepo

Status: Accepted
Date: 2026-05-19

## Context

v2 needs a Mac and Windows desktop app, a small backend for license validation, and a marketing site. The choice of desktop stack shapes 16 weeks of work.

## Decision

Electron 33 with TypeScript, React 19 renderer, Tailwind for styling, Vite via electron-vite for build. SQLite via better-sqlite3 for the local brain. keytar for OS keychain. electron-builder for packaging and signing. electron-updater for auto-updates.

Monorepo with pnpm workspaces. Three packages: `desktop/`, `license-worker/`, `site/`.

License validator runs as a single Cloudflare Worker. Stateless. Source of truth for subscription state is Stripe.

## Alternatives considered

Tauri (Rust core + webview). Smaller binary, sharper sandbox primitives, and a more modern story for security. Rejected for v1 because: (a) the team's prior shipping experience is with Electron and the v1 timeline is tight, (b) keytar and better-sqlite3 are first-class in the Node ecosystem and a real reimplementation cost in Rust, (c) the marginal security improvement is small relative to the security floor we actually commit to. Revisit for v2.

Native Mac (Swift) + Windows (WinUI). Best perf and tightest OS integration. Rejected because doubling the codebase doubles every feature shipped. Not justified for a single-developer v1.

Single repo, no monorepo. Rejected because shared types between desktop and license-worker are real and copy-pasting them would rot quickly.

## Consequences

Easier: every dependency we need is on npm. Hiring a contractor for a specific feature is easy. Build pipeline is well-documented.

Harder: binary size starts at ~150 MB. Memory footprint is larger than Tauri. Broader attack surface from the bundled Chromium. We accept these costs and document them in `docs/SECURITY.md`.

Implied follow-on work: write a v2 ADR if Tauri's ecosystem matures and we want to migrate.

## Update (2026-05-21)

Windows moved out of v1 to a v1.1 fast-follow (see DECISIONS and VISION). This does not change the stack decision; if anything it reinforces it, since Electron keeps the eventual Windows build cheap from one codebase. v1 ships macOS only. Read the "Mac and Windows" framing in Context as the eventual cross-platform target, not the v1 scope.
