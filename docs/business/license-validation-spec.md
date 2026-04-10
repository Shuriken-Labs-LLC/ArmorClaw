# ArmorClaw License Validation Spec

## Shuriken Labs LLC

### Overview

Option B license enforcement: signed license keys validated locally with
periodic server check-in. Users cannot use ArmorClaw after subscription
lapses beyond the grace period. User data is never deleted on deactivation.

### License key flow

1. User subscribes via Stripe
2. Stripe webhook fires subscription.created or invoice.payment_succeeded
3. ArmorClaw validation server generates a signed JWT license key:
   - Contains: customer email, subscription ID, expiry (billing date + 5 days grace)
   - Signed with Shuriken Labs private key
4. Key delivered to user via email or displayed in account portal
5. User enters key in ArmorClaw during first launch (or it is auto-applied
   via a magic link from the confirmation email)
6. Key stored at ~/.armorclaw/license.key

### Validation on launch

1. Read ~/.armorclaw/license.key
2. Verify JWT signature locally (no network call needed for valid unexpired keys)
3. Check expiry date:
   - Valid and not expired: proceed normally
   - Within 7 days of expiry: show amber renewal reminder banner
   - Expired but within 7-day grace period: show red banner, full functionality
   - Expired beyond grace period: make ONE server validation call
4. Server call to POST https://license.armorclaw.ai/validate:
   { key, machineId, version }
   Response: { valid, expiresAt, message }
5. If valid: update local key file with new expiry, proceed
6. If invalid: disable gateway, show friendly deactivation screen

### Deactivation screen

- Title: "Your ArmorClaw subscription has ended"
- Message: "Your subscription ended on [date]. Your data is safe and
  still on your computer. Resubscribe to continue using ArmorClaw."
- Button: "Resubscribe" → opens Stripe Customer Portal
- Button: "Export my data" → opens sandbox directory in Finder
- No deletion of any user data ever

### Validation server (Cloudflare Worker)

POST /validate

- Verify JWT signature
- Check Stripe API for active subscription matching the key
- If active: return { valid: true, expiresAt: newExpiry }
- If cancelled but within grace: return { valid: true, expiresAt: graceExpiry,
  message: "Your subscription has ended. Renew to continue." }
- If cancelled beyond grace: return { valid: false, message: "..." }
- Rate limit: 3 calls per day per machineId

### Grace period settings (confirmed)

- Subscription pause: supported (user keeps access while paused)
- Cancellation: takes effect end of billing period
- Grace period after expiry: 7 days
- Data preservation: permanent (never deleted)

### Stripe Customer Portal settings

- Allow pausing: yes
- Cancellation timing: end of billing period
- Self-serve: cancel, pause, update payment, download invoices
- Link in ArmorClaw: Settings view "Manage subscription" button

### Update system (user-controlled)

- autoDownload: false (user chooses when to install)
- When update available: tray notification + dashboard banner with version
  number and release notes summary
- "View changelog" opens GitHub release notes in browser
- "Install update" downloads and installs on next restart
- "Remind me later" dismisses for 7 days
- Release notes maintained in GitHub Releases (electron-updater reads automatically)
- Never force-install without user action

### Implementation order (post-launch)

1. Set up Cloudflare Worker validation endpoint
2. Set up Stripe webhook for subscription events
3. Build license key generation on subscription created/renewed
4. Add license key check to ArmorClaw main.ts startup sequence
5. Build deactivation screen in Electron
6. Test full cancel → grace period → deactivation flow
7. Test resubscribe → reactivation flow
