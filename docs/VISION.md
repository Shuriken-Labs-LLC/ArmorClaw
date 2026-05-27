# ArmorClaw

A local-first AI agent with a real memory.

## The product in one sentence

ArmorClaw is a desktop application that runs the OpenClaw AI agent on your Mac (Windows is a v1.1 fast-follow), wraps it in a project-workspace UI you can actually live in, gives it a memory it can grow with you, and lets it remember to do things on its own while your device is on.

## Who this is for

Agent-curious enthusiasts who can install software and sign into OAuth flows, but who do not speak terminal or JSON and do not want to manage MCP configs, edit YAML, or read OpenClaw's CLI docs to get useful work done. Many will use ArmorClaw as a stepping stone: they start with no clear idea what this is, and within a few weeks they are confident enough to open the full underlying tool. The product is built for that arc, which is why the full OpenClaw suite stays one click away.

People who want an always-on assistant that remembers context across sessions and topics and does not drop the things they asked it to do.

People who are happy paying for software that respects them. Source-available, no telemetry, no cloud lock-in.

## Who this is not for

Software developers who are already comfortable running OpenClaw from the terminal. They should keep doing that. ArmorClaw will not be measurably more powerful than what they already have.

Users who want a free chatbot. ArmorClaw is a $19.99/month tool, not a free experiment.

Users on Linux. v1 ships macOS; Windows is a v1.1 fast-follow. Linux is not on the roadmap.

Users who need their agent to run while their computer is asleep or in the cloud. ArmorClaw is local. It works while your device is awake. If that is a dealbreaker, ArmorClaw is the wrong tool.

## What ArmorClaw is

A native macOS desktop application (Windows is a v1.1 fast-follow) that detects or installs OpenClaw and runs it as a managed subprocess, and that always shows which OpenClaw version is running and whether it is current.

A project-workspace interface modeled after Notion. Each workspace contains its own chats, notes, files, and memories. The agent's context is scoped to the active workspace.

A memory system the agent contributes to and the user curates. After meaningful conversations, the agent proposes memories to save. The user reviews, edits, approves, or rejects each one. Approved memories surface in future agent context within that workspace.

An always-on commitments layer. Beyond remembering facts, the agent remembers things to do: scheduled briefings, reminders, recurring tasks. It follows through on its own while your device is on, pausing for your approval before anything irreversible.

A one-click setup flow for Gmail and Google Calendar in v1 using a single Google OAuth consent. More integrations follow based on user demand.

Notifications and briefings delivered in-app and by email in v1. A Telegram bridge for outbound notifications and approval requests is a v1.x channel; inbound Telegram commands are later still.

A plain-text audit log of agent actions, readable with any text editor.

A character with personality. The assistant is named Emerson and has a deliberate visual and tonal identity, chosen for memorability rather than novelty. The personality is user-facing only and dials down to nothing at the moments that demand trust, such as approving an irreversible action.

Source code is public under PolyForm Noncommercial 1.0.0. Anyone can read it and compile it for personal use. Paying subscribers get signed and notarized binaries, automatic updates, and support.

## What ArmorClaw is not

Not a cloud agent. Nothing about ArmorClaw executes while your device is asleep. We tell users this clearly in onboarding and on the pricing page.

Not a security-hardened agent. We commit to a pragmatic floor and stop there. Specifically: credentials in OS keychain, user confirmation for irreversible actions, plain-text audit log, sandboxing handled by OpenClaw and the MCPs it loads. We do not market guarantees we cannot deliver.

Not a cross-device sync product. Your brain lives on your machine. If you use two machines, you have two independent brains. Sync may come later if and only if user demand justifies the engineering and ops cost.

Not an enterprise tool in v1. Single user, single machine, single subscription.

Not a generic chat app. ArmorClaw is an agent with tools, persistent memory, and a workspace structure. Users who want pure chat should use ChatGPT or Claude.

## Pricing and business model

$19.99 per month. 30-day free trial requiring a payment method up front. Auto-renewing subscription. Cancel anytime via the Stripe Customer Portal.

Paid binaries plus source-available code. We accept that some technical users will compile from source and skip the subscription. This is intentional. The trust signal of open code is worth more than the marginal revenue from self-builders. Estimated leak rate at this price point and audience: 3 to 8%, and probably lower, since the sharpened target audience does not speak terminal and will not compile from source.

Hosted license validation gates the official signed builds, automatic updates, and support. Self-compilers do not get any of those.

## Honest claims policy

Every claim on armorclaw.app, in the app, and in marketing materials is audited as written, not retroactively. Concretely:

We do not claim ArmorClaw makes AI "safe." We describe specific protections that exist and explicitly name the ones that do not.

We do not claim enterprise-grade security. We are a single-user desktop app with a pragmatic floor.

We do not claim AI guarantees. The agent can hallucinate, make wrong tool calls, and misremember. The audit log and approval prompts exist to make these failures visible and recoverable, not to prevent them.

If a claim cannot be substantiated by a specific code path or test that exists at the time the claim is written, it does not ship.

## Success metrics for v1

100 paying subscribers by 90 days post-launch.
$24,000 MRR within 6 months of launch.
NPS above 30 from users who converted trial to paid.
Median time from first launch to first useful agent task under 10 minutes.
Self-build / paid-customer ratio under 1:10 (less than 10% leak rate).

## Roadmap signals

v1: ships at week 12 or earlier. macOS only.
v1.1: Windows fast-follow (gated on a stable Mac core), Telegram inbound commands, second wave of MCPs (Slack, GitHub, Notion or Linear depending on early user signal).
v1.x: Telegram briefing and notification channel, event-driven commitment triggers, avatar customization, commitment export.
v2: cloud brain sync, only if at least 30% of paid users explicitly request it within 6 months.
