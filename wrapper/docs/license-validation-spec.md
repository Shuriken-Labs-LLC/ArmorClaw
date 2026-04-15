# ArmorClaw License Validation — Technical Specification

## Architecture: Option B (signed key with local validation)

### Overview

ArmorClaw uses a signed license key stored locally. The key is validated
cryptographically without network calls while unexpired. The validation
server is a single Cloudflare Worker that checks Stripe subscription status
only when the key expires.

```
                  ┌─────────────────────────┐
                  │   Stripe Subscription    │
                  │   Webhook (created/      │
                  │   renewed)               │
                  └─────────┬───────────────┘
                            │ generates signed key
                            ▼
                  ┌─────────────────────────┐
                  │  Cloudflare Worker       │
                  │  license.armorclaw.ai    │
                  │  /validate              │
                  └─────────┬───────────────┘
                            │ returns { valid, expiresAt }
                            ▼
         ┌──────────────────────────────────────┐
         │  ~/.armorclaw/license.key             │
         │  (JWT or HMAC-signed, 35-day expiry)  │
         └──────────────────┬───────────────────┘
                            │ read on launch
                            ▼
         ┌──────────────────────────────────────┐
         │  ArmorClaw Electron app              │
         │  - Local crypto check (no network)   │
         │  - Network call only if expired      │
         └──────────────────────────────────────┘
```

---

## License Key Format

### Option A: JWT (recommended)

```json
{
  "sub": "cus_abc123",
  "email": "user@example.com",
  "plan": "armorclaw-monthly",
  "iat": 1774000000,
  "exp": 1777024000,
  "mid": "machine-id-hash"
}
```

Signed with Ed25519 (fast, small keys). Public key embedded in the app
for local verification. Private key stored in Cloudflare Worker secrets.

### Option B: HMAC-SHA256

```
<base64-payload>.<base64-hmac>
```

Payload is JSON with the same fields. HMAC is computed with a secret
stored in the Worker. Verification requires the Worker (no local check
possible). Use JWT instead.

**Decision: JWT with Ed25519.**

---

## Key Lifecycle

### Generation (server-side)

Triggered by Stripe webhook `customer.subscription.created` or
`invoice.paid`:

1. Look up customer email from Stripe event
2. Generate JWT with:
   - `sub`: Stripe customer ID
   - `email`: customer email
   - `plan`: subscription plan ID
   - `iat`: now
   - `exp`: now + 35 days (30 billing + 5 grace)
   - `mid`: machine ID from the request (optional, for single-machine
     enforcement later)
3. Sign with Ed25519 private key
4. Return to client or store for retrieval

### Validation (client-side)

On ArmorClaw launch:

```
┌─ Read ~/.armorclaw/license.key
│
├─ Key exists?
│  ├─ YES → Verify JWT signature with embedded public key
│  │  ├─ Signature valid + not expired → PROCEED (no network call)
│  │  ├─ Signature valid + expired < 7 days → AMBER WARNING + online check
│  │  └─ Signature valid + expired > 7 days → DISABLE + resubscribe screen
│  │
│  └─ Signature invalid → DISABLE + resubscribe screen
│
└─ NO → Show subscription screen with "Enter license key" input
         or "Subscribe" button linking to armorclaw.ai/pricing
```

### Online Validation

Only called when:

- Key is expired (may have been renewed)
- Key is missing (first launch after purchase)
- User clicks "Check subscription" manually

```
POST https://license.armorclaw.ai/validate
Content-Type: application/json

{
  "key": "<JWT>",
  "machineId": "<sha256 of hostname + username>"
}

Response:
{
  "valid": true,
  "expiresAt": "2026-05-01T00:00:00Z",
  "newKey": "<refreshed JWT if renewed>",
  "message": "Subscription active"
}
```

---

## Validation Server (Cloudflare Worker)

### Endpoints

#### `POST /validate`

1. Decode JWT (don't verify — we issued it, just extract `sub`)
2. Call Stripe API: `GET /v1/customers/{sub}/subscriptions?status=active`
3. If active subscription found:
   - Generate new JWT with fresh expiry
   - Return `{ valid: true, expiresAt, newKey }`
4. If no active subscription:
   - Return `{ valid: false, message: "Subscription not found" }`
5. Rate limit: 3 calls per day per `machineId`

#### `POST /issue`

Called by Stripe webhook handler. Not called by the client.

1. Receive Stripe webhook event
2. Verify webhook signature
3. If `customer.subscription.created` or `invoice.paid`:
   - Generate JWT for customer
   - Store in KV: `key:{customer_id}` → JWT
4. If `customer.subscription.deleted`:
   - Delete from KV

### Infrastructure

- **Worker**: single Cloudflare Worker (~100 lines)
- **KV**: Cloudflare KV for key storage (optional — JWT is self-contained)
- **Secrets**: Ed25519 private key, Stripe API key, webhook signing secret
- **Domain**: `license.armorclaw.ai` (CNAME to Worker)
- **Cost**: Free tier covers ~100K requests/day

---

## User Experience

### Timeline

| State                          | Dashboard                                       | Gateway      |
| ------------------------------ | ----------------------------------------------- | ------------ |
| Valid key, 30+ days remaining  | Nothing shown                                   | Running      |
| Valid key, 7 days remaining    | Amber banner: "Renews in 7 days"                | Running      |
| Expired, grace period (7 days) | Amber banner: "Ended — renew to continue"       | Running      |
| Expired, past grace            | Full-screen: "Subscription ended" + Resubscribe | **Disabled** |
| No key                         | Full-screen: "Subscribe" or "Enter key"         | **Disabled** |

### Resubscribe Flow

"Resubscribe" button → opens Stripe Customer Portal URL in browser →
user updates payment → Stripe webhook fires → new key issued →
user clicks "Check subscription" in ArmorClaw → key refreshed → gateway starts.

### Data Preservation

**Never delete user data on deactivation.** All of these are preserved:

- `~/.armorclaw/` (memory, audit log, config)
- `~/.openclaw/` (gateway config, channels, sessions)
- `~/armorclaw/.env` (API keys, tokens)
- Sandbox directory files
- Installed skills

Only the gateway process is stopped. User can resume instantly by renewing.

---

## Implementation Plan

### Phase 1: Key validation (client-side only)

Files to create/modify:

- `wrapper/billing/license.ts` — read/verify/cache license key
- `wrapper/launcher/main.ts` — check license on startup, gate gateway start
- `wrapper/dashboard/public/index.html` — expiry banner, subscription screen
- `wrapper/dashboard/server.ts` — `/api/license/status` endpoint

### Phase 2: Validation server (Cloudflare Worker)

Files to create:

- `infra/license-worker/index.ts` — Worker handler
- `infra/license-worker/wrangler.toml` — Worker config
- Stripe webhook setup (Dashboard or CLI)

### Phase 3: Update system

Files to modify:

- `wrapper/launcher/auto-updater.ts` — disable autoDownload, add changelog
- `wrapper/launcher/tray.ts` — update notification in menu
- `wrapper/dashboard/public/index.html` — update banner with release notes

---

## Security Considerations

- Ed25519 public key is embedded in the app binary — can be extracted, but
  can't be used to forge keys (only the private key can sign)
- Machine ID binding is optional for v1 — add later if piracy is observed
- License key file is plaintext — a determined user could share it, but the
  Stripe subscription is tied to their email and payment method
- The Worker rate limits prevent brute-force key generation
- Webhook signature verification prevents forged subscription events
- The 5-day grace period prevents false deactivations from payment processor
  delays
