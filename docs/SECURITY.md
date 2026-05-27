# Security floor

ArmorClaw commits to exactly four security properties. We do not promise more. We do not market more.

## 1. Credentials in OS keychain

All credentials are stored in the OS-native keychain via keytar.

macOS: Keychain Services.
Windows: Credential Manager (v1.1; v1 is macOS only).

Items stored: integration OAuth tokens (Google, etc.), the model API key, the Telegram bot token (v1.x), license JWT, any user-provided API keys.

Never stored on disk in plaintext, never in environment variables persisted to disk, never in app_state plaintext columns.

## 2. Explicit user confirmation for irreversible actions

Before the agent performs any of the following, ArmorClaw shows a confirmation UI and requires explicit approval:

- Sending email
- Sending Slack or other chat messages
- Deleting files, records, or messages
- Making purchases
- Posting publicly (social media, forums, blog comments)
- Modifying calendar events (create, update, delete)
- Granting access permissions

This gate holds for unattended scheduled commitments too. A fired commitment runs until it completes or reaches one of the actions above, then pauses and requests approval. The per-task autonomy setting is keyed to reversibility: it can let reversible actions run hands-off, but it cannot turn off the gate on irreversible actions except through a separate, deliberate, off-by-default opt-in that names the specific action. Blanket permission granted in chat does not bypass the gate.

Approval requests can optionally be mirrored to a notification channel (in-app and email in v1; Telegram in v1.x). The user still confirms in the desktop app.

## 3. Plain-text audit log

Every agent action is logged as one line at `audit.log` in the app data directory.

Format: ISO timestamp, workspace id, event type, summary, payload hash. Grep-able. No HMAC, no signature chain, no cryptographic verification. The user can read and edit the file with any text editor. Unattended scheduled commitment runs are logged here as well; the commitment_runs table mirrors those entries.

If integrity matters to a specific user, they can stream the log to their own append-only service. We do not build that.

## 4. Sandboxing is delegated

ArmorClaw does not sandbox OpenClaw or its MCP servers. They run with the user's permissions. We document this in onboarding so users understand what they are running.

If OpenClaw or an MCP adds sandboxing, ArmorClaw benefits. We do not duplicate it.

## What we do not commit to

Network egress allowlist in the app layer.
Code-signed or hash-chained audit entries.
Encrypted local database (we rely on OS disk protection).
Linux support.
Mobile app.
Compliance certifications (SOC 2, ISO 27001, FIPS, FedRAMP, etc.).
Multi-user permissions.
Hardware-bound license keys.
Anti-tampering on the binary.

If a user needs any of the above, ArmorClaw is the wrong product for them. We tell them so.
