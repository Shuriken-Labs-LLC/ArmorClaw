# AGENTS.md

Instructions for AI coding agents working in this repo. Claude Code reads this on session start.

## Project shape

This is a pnpm monorepo with three deployables. Read `docs/VISION.md` and `docs/ARCHITECTURE.md` before making non-trivial changes; they encode load-bearing decisions. For brain, memory, commitments, or onboarding work, the detailed specs are `docs/armorclaw-brain-spec.md` (behavior), `docs/armorclaw-brain-mcp-spec.md` (tools and SQL), `docs/armorclaw-brain-ui-spec.md` (UI), and `docs/armorclaw-onboarding-spec.md` (first-run). These docs are canonical here, not in any parent folder.

```
desktop/         Electron app — the product
license-worker/  Cloudflare Worker — Stripe license validation
site/            Astro — armorclaw.app marketing site
docs/            VISION, ARCHITECTURE, SECURITY, brain + onboarding specs, ADRs
```

## Rules

The security floor is exactly four commitments listed in `docs/SECURITY.md`. Do not add commitments without explicit user discussion. Do not weaken them silently.

Do not commit secrets. Use the OS keychain via keytar at runtime, GitHub Secrets in CI, and `wrangler secret put` for the Worker.

Do not introduce new runtime dependencies without justification. Prefer the standard library and existing deps. Each new dep is an attack surface and a maintenance load.

Do not paste large third-party copyrighted content. Reference by URL.

If a feature is not on the v1 list in `docs/VISION.md` and not on the explicit v1.1 line, push back before implementing it. Ask whether it should be deferred.

## Conventions

TypeScript strict mode everywhere. No `any`. Use `unknown` and narrow.
React function components only. No class components.
No `console.log` in committed code. Use a logger module.
Snake_case for SQLite columns. camelCase in TypeScript. Map at the query layer.
Tests live next to the file they test as `*.test.ts`.
Run `pnpm typecheck` and `pnpm test` before declaring a task done.

## When asked to add a feature

1. Check `docs/ARCHITECTURE.md` for the data model. If a new table or column is needed, propose a migration before code.
2. Check `docs/SECURITY.md` for any relevant commitment.
3. Add tests at the same time as the feature, not after.
4. Update `CHANGELOG.md`.

## Commands

```
pnpm install                              # bootstrap
pnpm -F @armorclaw/desktop dev            # Electron in dev mode
pnpm -F @armorclaw/license-worker dev     # Worker locally via wrangler
pnpm -F @armorclaw/site dev               # Astro site locally
pnpm -r typecheck                         # typecheck all packages
pnpm -r test                              # run all tests
pnpm format                               # Prettier across the repo
```

## Things you should ask before doing

Anything that changes the data model, the security floor, the pricing model, or the value proposition. These live in `docs/VISION.md` and `docs/ARCHITECTURE.md` and require an ADR in `docs/adr/`.

Anything that adds a network call from the desktop app to a new domain. Document it in `docs/SECURITY.md`.

Anything that touches license validation. The license flow is intentionally simple; complexity here is rarely worth the cost.
