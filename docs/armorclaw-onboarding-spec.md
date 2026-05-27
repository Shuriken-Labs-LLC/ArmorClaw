# ArmorClaw — First-launch onboarding spec

The goal of first launch is one thing: get the user to their first useful agent task in under 10 minutes, without them later regretting that we didn't tell them what they were getting into.

The challenge is that "what they're getting into" includes prompt injection, approval discipline, model API costs, and third-party code execution. Front-loading all of that as 4 modal screens in a row will get dismissed. The approach below uses one consolidated "Things to know" screen at onboarding, plus contextual reminders that fire later at the natural moment.

## Philosophy

Show the user what matters when they need to know it. Frontload only what cannot be deferred.

Every screen has one job. No screen tries to do two things. The user's progress through the flow is linear and resumable: if they quit halfway, the app remembers where they were.

Skip is a real option wherever it makes sense. Don't force the user to connect Gmail before they've seen the app work.

## The full flow

### 1. Welcome

Purpose: brand the moment and introduce Emerson. Tell them what this is in one sentence, in character.

Copy (standard voice; final wording pending the personality direction):
> Hi, I'm Emerson.
> Your local-first AI agent with a real memory. I live on your machine, I remember what matters, and I don't forget the things you ask me to do.

Primary CTA: Get started.

No skip. This is the first frame. Emerson (the chibi character) hosts the entire onboarding flow, not just this screen.

### 2. Email entry

Purpose: capture email for the magic-link auth and the Stripe trial.

Copy:
> What email should we use for your account?
> [email input]
> We'll send you a magic link to sign in. No password.

Primary CTA: Send magic link.

Notes:
- Input validation: standard email regex, friendly error if invalid
- Calls POST /auth/magic-link on the license worker
- Advances to step 3 on success

### 3. Check your inbox

Purpose: wait for the user to click the magic link in their email.

Copy:
> Check your inbox.
> We sent a sign-in link to **[user@example.com]**. Click it to come back.
> Didn't receive it? Check spam or [resend].

States:
- Waiting: shows above copy plus a small spinner
- The deep-link callback `armorclaw://auth?token=...` is handled by the main process; on success, this screen auto-advances to step 4

Time-out behavior:
- After 5 minutes idle, show a "Still waiting? Resend the link or try a different email" message

### 4. Start your trial

Purpose: capture payment method via Stripe Checkout to begin the 30-day trial.

Copy:
> Start your 30-day free trial.
> $19.99 per month after. We need a payment method to start the trial, but we won't charge until day 31.
> Cancel anytime in the app. Full refund in one click if you cancel within 7 days of your first charge.

Primary CTA: Add payment method.

Behavior:
- Clicking opens a Stripe Checkout URL in the system browser
- Stripe redirects back to a `armorclaw://billing/return?session_id=...` deep link
- App polls /subscription/status until it sees `sub_status=trialing`
- Advances to step 5 on success

Skip handling: there is no skip. The trial requires payment method capture. If the user closes the window, they resume here on next launch.

### 5. OpenClaw setup

Purpose: detect or install the OpenClaw runtime.

Two cases:

If detected:
> OpenClaw detected.
> Version 0.x.y. You're good to go.

Primary CTA: Continue.

If missing:
> ArmorClaw needs the OpenClaw runtime.
> We'll install it for you. About 30 seconds.

Primary CTA: Install OpenClaw.

Behavior during install:
- Progress bar
- Streaming output panel below, scrollable
- On failure, show the error plus link to a troubleshooting page and a "try again" button

### 5b. Model key

Purpose: capture the model API key OpenClaw needs to actually run. Without this, the first chat in step 9 cannot do inference. This was missing from the original flow and is the second half of the "one-click install gets you started with a token" promise.

Copy:
> One last key to get Emerson thinking.
> Paste your OpenAI or Anthropic API key. Emerson uses it to run. It's stored in your OS keychain and never leaves your machine. Costs go to your provider account, not us.
> [API key input]   [Where do I get one?]

Primary CTA: Save key and continue.

Behavior:
- Key validated with a cheap test call to the provider
- Stored via the OS keychain (one of the four security-floor commitments)
- Handed to the OpenClaw subprocess via environment, never written to disk in plaintext
- On success, advance to step 6

Install plus this key handoff are the only required setup friction. Everything else has a sensible default.

### 6. Things to know

Purpose: the consolidated safety brief. Four ideas in one screen, structured for scanning. This is the screen we cannot defer.

Copy:

> ## A few things to know before you start
>
> **The agent can be tricked.** AI agents trust the text they read. If a webpage or email contains hidden instructions, the agent might try to follow them. We protect you with approval prompts on irreversible actions like sending email or deleting files. You can let Emerson run reversible, low-stakes tasks on its own, but irreversible actions stay gated unless you deliberately opt a specific one out. The prompts are the safety. Read them. Don't approve on autopilot.
>
> **Everything the agent does is logged.** In plain text, at `~/Library/Application Support/ArmorClaw/audit.log`. Check it after big tasks. The log is your record.
>
> **Model API costs come out of your account.** ArmorClaw uses your OpenAI or Anthropic key. Long agent tasks can run up cost. Set a spending limit in your model provider's dashboard.
>
> **Third-party integrations run code on your machine.** Gmail and Google Calendar use APIs we trust. If you later install MCP servers from outside our curated gallery, read the source first.

Primary CTA: Got it.
Secondary CTA: Read the full Trust & Safety page (opens armorclaw.app/safety in browser).

This is the only safety screen we force in onboarding. The rest live as contextual reminders later.

Note: bold typography on this screen is acceptable because it serves scanability of safety content. The rest of the app follows the no-bold guideline.

### 7. Create your first workspace

Purpose: get them into the actual product.

Copy:
> Create your first workspace.
> Workspaces are containers for related chats, notes, and memories. The agent's memory is scoped to whichever workspace you're in.
> [workspace name input]
> Suggested: Work, Personal, Side projects, Household

Primary CTA: Create workspace.

Behavior:
- Suggested names are clickable chips that pre-fill the input
- Workspace is created with a default icon and color; user can change later
- Advances to step 8

### 8. Connect Gmail and Calendar (optional)

Purpose: get them to value fast by hooking up the integrations most people want.

Copy:
> Connect Gmail and Google Calendar?
> Most people start here. The agent will be able to search your inbox, draft emails, check your schedule, and suggest meeting times. Sending and modifying still require your approval.
>
> One Google sign-in. Tokens stored in your OS keychain.

Primary CTA: Connect with Google.
Secondary CTA: Skip for now.

Behavior:
- Connect opens OAuth in the system browser
- Tokens captured via local loopback
- MCP server config written, OpenClaw restarted to pick it up
- On success, advance to step 9
- Skip advances directly to step 9

### 9. First chat

Purpose: leave the user at a working chat with concrete starting points, not an empty input.

Copy at the top of the chat:
> You're in **[workspace name]**. The agent's memory and integrations are scoped to this workspace.

Empty-state suggestions (clickable, fill the input):
> "Catch me up on my inbox from this week."
> "What's on my calendar tomorrow?"
> "Create a memory: my preferred meeting length is 25 minutes."
> "Remind me to follow up with [contact] on Friday."
> "Help me draft a reply to the most recent email from [contact]."

The "Remind me to..." suggestion is deliberate: it introduces the always-on layer early without a dedicated screen. Approving it creates the user's first commitment.

Customize the suggestions based on which integrations were connected in step 8. If no integrations connected, show:
> "Tell me what ArmorClaw can do."
> "Let's set up your first project workspace."
> "Save this to memory: [your fact here]."

Briefing intro (light-touch, not a screen): when the user lands here, Emerson mentions once that it can check in on a schedule, and tells them a short morning brief is already set and tunable anytime in Commitments. No configuration is forced. The default is a pre-seeded recurring commitment the user can edit or delete. Per the design decision, the "what cadence would you like?" question is deferred until after the first real task, when it means something.

This is the end of onboarding. Subsequent first-time moments use contextual reminders.

## Contextual reminders

These are not modals. They are inline notices that appear at the natural moment, dismissable, never shown twice.

### When the user adds their first model API key

> Heads up: this key is what the agent will use for inference. Costs go to your model provider account, not us. [Set a spending limit in your provider dashboard].

Position: in the API key settings panel, below the input. Dismiss persists per key provider.

### When the agent shows its first approval prompt

> This is an approval prompt. ArmorClaw shows one before any irreversible action. Read what the agent wants to do, then approve or reject. You can [always come back here later to review what was approved](opens audit log location).

Position: a small "?" toggle on the first approval card that expands the explainer when clicked. Auto-dismisses after first interaction.

### When the user browses the integrations gallery

> Integrations marked "Curated" have been reviewed by us. The "Community" tab lists MCP servers from the wider ecosystem. Those run code on your machine with your permissions. Read the source before installing.

Position: a persistent banner above the Community tab. Not dismissable.

### When the user installs their first Community MCP

Block the install with a confirm dialog:

> Install [server name] from [author]?
> This is a community MCP server. Running it gives [author]'s code permission to act with your credentials. We have not reviewed it.
> [Read the source on GitHub] | [Cancel] | [Install anyway]

The "Install anyway" button is purposefully not the default focus. The Cancel button has the default focus.

### When the audit log grows past 1,000 entries

Show a small badge in the brain/settings area:

> Your audit log has grown to over 1,000 entries. Consider archiving it occasionally.
> [Open log] [Archive and reset]

## What we skip in v1 onboarding

A tour of the brain panel. Show it when the user clicks into Brain for the first time, via a single tooltip on the search bar. Don't make them sit through a tour.

A guided "first agent task" tutorial. The empty-state chat suggestions do this work without forcing a tutorial flow.

A "share with a team member" step. v1 is single-user.

Account preferences (theme, hotkeys, sound). Defaults are fine. Surface in Settings only.

A pop-up offering Telegram setup. Telegram is a v1.x briefing channel; email and in-app briefing ship first. It lives in Settings under integrations when it arrives.

## Resumability and state machine

The onboarding flow is a state machine. Each step writes a marker to local storage so a user who closes the app at step 5 resumes there on next launch. The states are:

```
welcome -> email_sent -> email_verified -> payment_captured ->
openclaw_ready -> model_key_saved -> safety_acknowledged ->
workspace_created -> integrations_offered -> done
```

The `done` state means onboarding never reappears unless the user resets via Settings -> "Replay onboarding."

## Success metric for the onboarding flow

Median time from first launch to step 9 (first chat) under 10 minutes. Measure this in the audit log; first launch timestamp and first message-sent timestamp are both already recorded.

Goal: 80% of trial signups reach step 9. Below that, onboarding is leaking users somewhere and we need to find where.
