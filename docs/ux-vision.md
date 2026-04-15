# ArmorClaw UX Vision

Last updated: 2026-04-06

This document describes the approved user experience for ArmorClaw v1. Every screen
is described from the user's perspective. Implementation should match this document.

---

## Product summary

ArmorClaw is a hardened wrapper around OpenClaw targeting freelancers and SMBs. The
value proposition is security, ease of use, and visibility. A non-technical user
should go from download to talking to their agent on Telegram in under 15 minutes.

Three bundled skills: Email & Calendar, Secure Files, Browser Automation.

Two main UI surfaces: the onboarding wizard (run once) and the dashboard (daily use).
Chat happens in messaging apps (Telegram, WhatsApp, Discord, Slack). A floating
desktop chat window is available as a convenience.

---

## Onboarding wizard (6 steps)

The wizard is a local web UI served on localhost. Dark theme, Plus Jakarta Sans font,
ArmorClaw design system throughout. Every step is one screen, no scrolling required.
Progress indicator shows "Step X of 6" at all times.

Every step except Step 1 has a "Skip this step" link at the bottom. Skipped steps
save no data and advance to the next screen.

### Step 1: Choose your AI provider (required)

The only required step. Two sections: Cloud and Local.

Cloud section (labeled "conversations processed by provider"):

- Claude (Anthropic) card: "Great for nuanced writing and long documents"
- GPT-4o (OpenAI) card: "Reliable and fast for everyday tasks"

Local section (labeled "conversations stay on your computer"):

- Ollama card: "Free, completely private, no internet required"

Selecting a cloud provider slides in an API key input with a link to where the key
can be found. Selecting Ollama shows a server URL input (default: http://localhost:11434).

The key is validated live against the provider API. Definite auth failures (401/403)
block with a clear error. Network issues or rate limits show a soft warning and let
the user continue by clicking "Continue anyway."

No skip button on this step.

### Step 2: Choose a folder for your files (skippable)

Native folder picker. Default suggestion: ~/Documents/ArmorClaw.

One-sentence explanation: "ArmorClaw can only read and write files inside this folder.
It cannot touch anything else on your computer."

Validated against a list of forbidden system directories. If the folder doesn't exist,
ArmorClaw creates it.

If skipped, the Secure Files skill is disabled until configured in Settings.

### Step 3: Email & Calendar (skippable)

Two OAuth cards side by side: Gmail and Outlook.

Each card has a "Connect" button. Clicking it expands a credentials panel below with:

- A link to Google Cloud Console or Azure Portal
- Step-by-step instructions for creating an OAuth app
- Client ID input field
- Client Secret input field
- Redirect URI display (read-only, for the user to register in their console)
- "Save & Connect" button

On save, ArmorClaw opens the OAuth consent screen in a new browser tab. When the
callback completes, the card flips to "Connected" with a teal checkmark.

A permission summary box explains: "ArmorClaw will be able to read your emails and
create calendar events. It will always ask before sending anything."

v1 note: This OAuth flow requires users to create their own Google Cloud / Azure app.
This is a known friction point. When Google OAuth verification completes and ArmorClaw
has its own verified app credentials, this step simplifies to a one-click consent flow.

### Step 4: Secure remote access (Tailscale) (skippable)

Auto-detects whether Tailscale is installed. Three possible states:

1. Detecting: brief loading state while checking for the tailscale binary.
2. Detected: green confirmation with the user's https://<device>.ts.net URL. ArmorClaw
   calls `tailscale serve` to expose the dashboard on the Tailnet only.
3. Not installed: explanation of what Tailscale is, two buttons: "Install Tailscale"
   (opens download page, polls for installation) and "I'll do this later" (shows
   warning about no phone access).

A "Learn more about this" expandable section covers:

- Why Tailscale matters (secure access from anywhere, no port forwarding, encrypted)
- Step-by-step installation walkthrough
- How to sync between computer and phone

### Step 5: Connect your phone (skippable)

Two-column layout. Left: large QR code encoding the Tailscale dashboard URL. Right:
messaging app cards stacked vertically.

Channels:

- Telegram (marked "Recommended" with teal accent): primary path, native OpenClaw
  bot support. Expands a setup panel with BotFather instructions and token input.
- WhatsApp: secondary, uses OpenClaw native channel support.
- Discord: secondary, uses OpenClaw native channel support.
- Slack: secondary, uses OpenClaw native channel support.

If Tailscale was skipped, this entire step is greyed out with an explanation.

When at least one channel pings back, a teal success banner confirms the connection.

### Step 6: Review & Launch

Summary screen showing all configured values in card format:

- Active model provider
- Sandbox directory
- Email/calendar connection status
- Tailscale URL
- Connected messaging channels

Skipped items show as "Not configured" with muted styling (not an error).

"Open dashboard" button runs the launch sequence:

1. Back up existing config
2. Write gateway + plugin config
3. Start the gateway process
4. Poll until gateway is reachable (up to 15s)
5. Verify ArmorClaw security layer loaded
6. Check messaging channel connectivity

Live checklist shows checkmarks appearing one by one. On success, opens the dashboard
in a new tab.

---

## Dashboard

The dashboard is a local web UI served on localhost and accessible via Tailscale from
any device. Dark theme, ArmorClaw design system. Fully functional at 390px mobile
width. All data reads from the audit log and live config (no separate database).

Sidebar navigation: Home, Skills, Recipes, Security, Token Burn, Advanced, Settings.

### Home (default view)

Answers three questions at a glance: Is my agent running? Does anything need my
attention? What has it been doing?

Components, top to bottom:

- Agent status pill: Running (teal) / Paused (amber) / Error (red)
- Undo banner (conditional): shows for 60 seconds after a reversible action, with
  countdown timer and one-tap undo
- Pending approvals card: blue border, Approve/Reject buttons, hidden when empty
- Token burn summary: one-liner with progress bar, "See breakdown" link
- Activity feed: last 20 actions with color-coded left borders (blue = pending,
  teal = success, red = security/error, amber = warning)
- Recipes shortcut row: first 3 active recipes with next run time
- Inline chat widget: quick command input

### Skills

Two groups: "ArmorClaw skills" (bundled) and "Your skills" (user-created).

Bundled skills:

1. Email & Calendar
2. Secure Files
3. Browser Automation

Each card: name, version, Active/Inactive toggle, permissions in plain English, last
run time and outcome, expandable last-5-runs list. User skills show "Built by you"
label. Toggling off requires one-click confirmation.

### Recipes

Two sections: Bundled recipes and My recipes (custom).

Bundled recipes:

- Morning inbox triage (email-calendar, weekdays 8am)
- Daily calendar briefing (email-calendar, weekdays 8am)
- Notify on new files in sandbox (secure-files, every 30 min)
- Weekly activity summary (digest, Fridays 5pm)

Each card: name, description, editable schedule, Active toggle, last run, next run.
Inline schedule editor with presets (every morning, weekdays only, every Monday, etc).
Custom cron behind an "Advanced" toggle.

### Security

Interactive security controls. Each control is a toggleable card with explanation.
Toggling off triggers a warning dialog requiring explicit confirmation.

Toggleable controls:

- Injection filter (on by default): screens inputs for manipulation attempts
- Permission enforcement (on by default): limits what each skill can access
- Audit logging (on by default): records everything ArmorClaw does

Status dashboard: rejections today, 7-day sparkline, recent security events,
gateway status, permission summary across active skills.

### Token Burn

Full spend visibility.

Top row: three metric cards (Today, This Month, Budget Remaining).

Charts:

- Daily spend bar chart (30 days, 14 on mobile), colored by provider
- Skill breakdown horizontal bar chart (month-to-date, sorted descending)

Table: last 50 token events (time, skill, model, tokens, cost), sortable.
Mobile: collapses to time/skill/cost with expandable rows.

Inline editable budget field. Alerts at 80% (amber) and 100% (red hard stop).
Ollama shows as "Local model -- no cost."

### Advanced

Dedicated full-screen view (own sidebar item, not a sub-section of Settings).

Persistent amber banner: "You're in Advanced mode. Commands here go directly to
OpenClaw. ArmorClaw's security layer still monitors all tool calls, but some
protections may not apply to manual configuration changes."

Features:

- Full OpenClaw Canvas UI in iframe
- Command runner with confirm dialog
- Full openclaw.json config viewer
- "Open in editor" button
- Gateway status and control

Security layer still runs on all tool calls. Commands execute as user, not
privileged.

### Settings

ArmorClaw-level configuration:

- Model provider and API key management
- Sandbox directory
- Email & Calendar OAuth reconnect/revoke
- Tailscale status and re-setup
- Mobile channel management
- Token budget
- Daily digest schedule (default 8am, configurable)
- Audit log CSV export
- Subscription management (Stripe Customer Portal, hidden when not configured)

---

## Daily digest

Morning message pushed to all connected messaging channels. Default: 8am local time.
Always 4-6 sentences, first-person, warm.

Content in order:

1. What the agent did yesterday (action count by type)
2. Anything pending (approvals, overdue items)
3. Today's first 3 calendar events
4. Token spend (yesterday's cost, month-to-date vs budget)
5. Optional: one suggested recipe or action if confidence is high

Never skips entirely. If idle: "All quiet yesterday." If budget hard-stop is active:
sends budget warning instead.

---

## Floating chat window (desktop)

Frameless Electron window (420x600), triggered by Cmd+Shift+Space or tray icon.
ArmorClaw design system. WebSocket to gateway. Typing indicator, streaming responses,
offline banner with retry, position persistence.

Convenience for desktop. Primary chat is the messaging app on the phone.
