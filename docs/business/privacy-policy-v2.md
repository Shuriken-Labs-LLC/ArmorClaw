# ArmorClaw Privacy Policy

**Shuriken Labs LLC**
Effective date: [DATE]
Last updated: [DATE]

---

## The short version

ArmorClaw runs on your computer. Shuriken Labs does not collect, store, or have access to your conversations, files, or agent activity. The only information we have is what we need to manage your subscription: your name and email address. This policy explains exactly what happens with your data, including what your AI provider and Telegram see.

---

## What Shuriken Labs collects

We collect your name and email address when you subscribe. That is used for account management, billing, and communicating with you about your subscription (payment confirmations, service announcements, required legal notices). We do not collect usage data, analytics, telemetry, conversation content, file contents, or any information about what you do with ArmorClaw.

**Payment processing.** Payments are handled by Stripe, Inc. Stripe collects your payment card information directly. We receive confirmation that a payment was made along with your billing details (name, email, last four digits of your card). We never see or store your full card number. Stripe's privacy policy: https://stripe.com/privacy

**Version checks.** ArmorClaw periodically checks GitHub Releases for available updates. This check transmits your current app version and basic request metadata (IP address, operating system) to GitHub's servers. No account information or usage data is included. GitHub's privacy policy: https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement

**No other collection.** We do not use cookies, tracking pixels, analytics services, or any form of behavioral monitoring. We do not fingerprint your device. We do not sell, rent, or share your information with advertisers or data brokers.

---

## Where your conversations go

ArmorClaw works with three types of AI providers. Your choice determines where your conversations are processed.

**Ollama (local, fully private).** All AI processing happens entirely on your computer using a model you download. No conversation data leaves your machine under any circumstances. This is the most private option.

**Anthropic or OpenAI (cloud, processed by a third party).** If you use Anthropic (Claude) or OpenAI (GPT), your conversations are sent directly from your computer to their servers for processing. Shuriken Labs does not route, intercept, store, or have access to these conversations. They are subject to those companies' own privacy policies and data practices:

- Anthropic: https://www.anthropic.com/privacy
- OpenAI: https://openai.com/policies/privacy-policy

We recommend reading the privacy policy of whichever provider you choose. If keeping your conversations entirely on your computer matters to you, choose Ollama.

---

## Telegram messaging channel

If you connect ArmorClaw to Telegram, messages you send to your ArmorClaw bot pass through Telegram's servers before reaching the ArmorClaw agent running on your computer. Telegram's privacy policy applies to message transit and storage on their platform: https://telegram.org/privacy

Shuriken Labs does not operate the Telegram infrastructure and does not have access to your Telegram messages. The messages are received by the ArmorClaw agent running locally on your machine.

---

## API keys and credentials

Your AI provider API keys are stored in your operating system's secure keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service). They are never transmitted to Shuriken Labs, never included in logs, and never leave your computer except when sent directly to your chosen AI provider for processing requests.

---

## Data stored on your computer

ArmorClaw stores the following data locally on your machine. None of it is transmitted to Shuriken Labs:

- **Audit log.** A record of every action the agent takes, stored as a local file. You can export it as CSV from the dashboard.
- **Token usage records.** A local record of AI model usage for budget tracking.
- **Agent memory.** Notes and context the agent retains between sessions, stored as local files. This includes a plain-text memory file and a local search index built over your sandbox files for faster retrieval. The search index is never transmitted externally.
- **Configuration.** Your preferences, skill settings, and recipe schedules.
- **Sandbox files.** Any files the agent creates or modifies within your designated sandbox directory.

You can delete any of this data at any time by removing the relevant files from your computer.

---

## Advanced settings and third-party components

ArmorClaw includes an Advanced view that provides direct access to the underlying OpenClaw runtime. If you install third-party extensions, modify configurations, or connect additional services through the Advanced view, those components may have their own data practices outside Shuriken Labs' control. We cannot make privacy guarantees about third-party components you choose to install.

---

## Your rights

Depending on where you live, you may have specific rights regarding your personal information under state privacy laws (including the California Consumer Privacy Act, Colorado Privacy Act, Virginia Consumer Data Protection Act, and similar laws in other states). These rights may include:

- **Access.** Request a copy of the personal information we hold about you.
- **Deletion.** Request that we delete your personal information.
- **Correction.** Request that we correct inaccurate personal information.
- **Opt-out of sale.** We do not sell your personal information to anyone, so there is nothing to opt out of.

Because ArmorClaw stores conversation data, files, and agent activity only on your computer, those rights apply only to the subscription information we hold (your name and email). You already have full control over everything stored locally.

To exercise any of these rights, contact us at [EMAIL]. We will respond within 45 days. We will not discriminate against you for exercising your rights.

We honor Global Privacy Control (GPC) signals. [ATTORNEY: Confirm GPC implementation requirements for a desktop app with no web presence beyond a landing page.]

---

## Children's privacy

ArmorClaw is not intended for use by anyone under the age of 18. We do not knowingly collect personal information from children. If you believe a child has provided us with personal information, contact us at [EMAIL] and we will delete it.

---

## Data retention

We retain your name and email address for as long as your subscription is active, plus [ATTORNEY: Specify retention period, typically 30-90 days] after cancellation for billing reconciliation. After that period, we delete your account information from our systems.

Stripe retains payment records according to their own retention policy and legal obligations.

Data stored locally on your computer (conversations, audit logs, agent memory, files) is retained until you delete it. Canceling your subscription does not delete your local data.

---

## Security

We protect your subscription information using industry-standard security practices including encrypted transmission (TLS) and secure storage.

ArmorClaw's local architecture is itself a security measure. Because your conversations, files, and agent activity never leave your computer (except when sent to your chosen AI provider), they cannot be exposed through a breach of our systems. Your API keys are stored in your operating system's encrypted keychain, not in plain text files.

---

## Changes to this policy

If we make material changes to this privacy policy, we will notify you by email at least 30 days before the changes take effect. Minor clarifications or formatting changes may be made without notice. The "Last updated" date at the top of this policy always reflects the most recent revision.

---

## Contact

Shuriken Labs LLC
Milan, Michigan

Email: [EMAIL]

---

## Attorney review notes

[REMOVE THIS SECTION BEFORE PUBLISHING]

Items requiring attorney review:

1. **State privacy law compliance.** We claim compliance with CCPA, CPA, VCDPA, and others. Verify the rights section covers all required elements for states with active comprehensive privacy laws.
2. **GPC requirement.** Confirm whether a desktop app with no web analytics needs to honor GPC signals, or whether this is only relevant for the landing page/marketing site.
3. **Data retention period.** Specify the post-cancellation retention period.
4. **Children's age threshold.** Confirm 18 is the correct threshold vs. 13 (COPPA) vs. 16 (some state laws).
5. **Telegram liability.** Confirm the disclosure about Telegram message transit is sufficient.
6. **Third-party components disclaimer.** Confirm the Advanced view disclaimer adequately limits liability for user-installed extensions.
7. **"No sale" claim.** Verify this holds under the broad CCPA definition of "sale" (which includes sharing for cross-context behavioral advertising). Should be clean given we share nothing, but confirm.
8. **Contact email.** Needs a real email address. Consider privacy@[domain] or legal@[domain].
