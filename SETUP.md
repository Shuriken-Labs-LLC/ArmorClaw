# ArmorClaw v2 — Setup

This skeleton lays out the structure for the new ArmorClaw repo. Follow the steps below to bootstrap the actual repo on GitHub and start coding.

## Prerequisites

Node 22.x (LTS) installed locally.
pnpm 9.x: `npm i -g pnpm`.
Apple Developer Program account, renewed, team ID known.
Windows EV code-signing certificate, ordered (7 to 14 days lead time).
Cloudflare account with armorclaw.app already on it.
Stripe account in test mode.
Resend or Postmark account for transactional email.

## Repo bootstrap

1. Create the empty repo at github.com/Shuriken-Labs-LLC/ArmorClaw.
2. Copy the contents of this `repo-skeleton/` directory into the new repo's working directory.
3. `git init && git add . && git commit -m "Initial commit: project skeleton"`
4. `git remote add origin git@github.com:Shuriken-Labs-LLC/ArmorClaw.git && git push -u origin main`
5. Replace the placeholder in `LICENSE` with the full PolyForm Noncommercial 1.0.0 text from https://polyformproject.org/licenses/noncommercial/1.0.0/
6. Copy `docs/VISION.md` and `docs/ARCHITECTURE.md` from your previous drafts into the `docs/` folder (they were generated alongside this skeleton).

## Layout

```
armorclaw/
  desktop/         # Electron app, the product
  license-worker/  # Cloudflare Worker for Stripe license validation
  site/            # armorclaw.app marketing site (Astro, scaffold yourself)
  docs/            # VISION, ARCHITECTURE, SECURITY, ADRs
  .github/         # CI and release workflows
```

## What's NOT in the skeleton

The Astro marketing site (`site/`) is left for `pnpm create astro@latest`. Faster than my hand-rolled version.

The React renderer files in `desktop/src/renderer/` are not included. After bootstrap, run electron-vite's React template to scaffold them. The main process and electron-builder config are the parts you actually need help with.

Apple Developer ID Application cert, app-specific password, and Windows EV cert go in GitHub Secrets, not in the repo. See `.github/workflows/release.yml` for the exact secret names you need to set.

## First commands after bootstrap

```
pnpm install
pnpm -F @armorclaw/desktop dev        # Electron in dev mode
pnpm -F @armorclaw/license-worker dev # Worker locally via wrangler
pnpm -F @armorclaw/site dev           # Astro site locally
```

## Secrets you'll need to set in GitHub Actions

```
APPLE_CERTIFICATE_P12
APPLE_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
WIN_CSC_LINK
WIN_CSC_KEY_PASSWORD
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

## Secrets for the license-worker

Set via `wrangler secret put NAME`:

```
STRIPE_SECRET_KEY
JWT_SIGNING_KEY
RESEND_API_KEY
```
