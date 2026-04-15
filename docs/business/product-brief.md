# ArmorClaw Product Brief

## Shuriken Labs LLC

**An AI agent that works for you. Runs on your computer. Answers on your phone.**

ArmorClaw is an AI agent that handles your daily workload autonomously — triaging email, drafting follow-ups, managing files, automating browser tasks, and sending you a morning briefing before you've sat down at your desk. You talk to it from Telegram. It works while your Mac is running.

It runs entirely on your own computer. Your emails, documents, and business data never touch a server you didn't choose.

**Who it's for:** Real estate agents, insurance agents, independent financial advisors, and freelancers who need real leverage from AI — not a better search engine, but an agent that actually runs workflows and reports back.

**What makes it deployable:** A 15-minute setup wizard. No terminal, no config files, no engineering required. Connect your email account, choose a folder for your files, and start a Telegram bot. That's the entire setup.

**What it does out of the box:**

- Reads and triages your inbox, drafts replies, waits for your approval before sending
- Sends a daily morning briefing via Telegram — email summary and what needs attention
- Manages files in a sandboxed folder on your computer
- Automates browser tasks (form fills, data extraction, research) in a dedicated Chromium profile
- Runs scheduled recipes for recurring workflows
- Logs every action and every AI dollar spent in a plain-English dashboard

**Email:** Connects to Gmail and any standard IMAP email account (Yahoo, iCloud, custom domain). No OAuth setup, no permissions screens, no verification hoops — your email address and an app password, stored in your Mac's secure keychain.

**Not yet available:** Calendar integration is in development. Today the agent handles email, files, and browser tasks only.

---

## The wedge: ArmorClaw vs. raw OpenClaw

ArmorClaw is built on OpenClaw, the open-source agent runtime. A developer could install OpenClaw themselves for free. Here's what ArmorClaw adds that raw OpenClaw does not:

**Prompt injection filter.** Every input is screened for instruction-override patterns before it reaches the model. Malicious content hidden in emails, documents, or web pages is caught, logged, and rejected. OpenClaw has no such layer.

**Permission manifests.** Every skill declares at load time what it can access (`read:email`, `write:files`, `browser:sandboxed`, etc.) and is rejected if it tries to exceed that. OpenClaw has no skill permission system.

**Sandboxed file access.** Files are confined to one folder chosen during onboarding. Path traversal attempts are rejected. OpenClaw has no filesystem sandbox.

**Approval flow.** Emails draft but don't send. File writes snapshot before executing. The agent queues up irreversible actions and waits for user confirmation. OpenClaw has no approval layer.

**Plain-English audit log.** Every skill invocation, permission used, outcome, and duration logged to a local file — searchable in the dashboard, exportable to CSV. OpenClaw has no audit trail.

**Token budget hard-stop.** API calls to cloud providers stop when the user's monthly cap is hit. OpenClaw has no cost controls.

**15-minute setup wizard.** OpenClaw requires a terminal and a config file. ArmorClaw requires a file picker and a password field.

**Local deployment.** No ArmorClaw intermediary server. Conversations go directly from the user's machine to the AI provider they chose. The company has no access to customer data.

---

## AI provider options

- **Ollama (local):** Everything stays on the user's computer. Fully private. No API costs.
- **Anthropic (Claude):** Powerful cloud AI. Conversations go to Anthropic's servers. User brings their own API key and pays Anthropic directly.
- **OpenAI (GPT):** Powerful cloud AI. Conversations go to OpenAI's servers. User brings their own API key and pays OpenAI directly.

---

## A few things to know

These are not deal-breakers, but sales and marketing should be honest about them up front:

1. **The Mac has to be running.** ArmorClaw is not a cloud service. Scheduled tasks, morning briefings, and Telegram messages all require the user's Mac to be on and the app to be open. If the machine sleeps, the agent stops until it wakes up.

2. **Cloud providers still see prompts.** When the user picks Anthropic or OpenAI, their conversation text goes to those providers' servers. That's inherent to using cloud AI, not something ArmorClaw can prevent. Users who want total privacy should run Ollama locally.

3. **AI agents can be wrong.** The approval flow and audit log exist specifically because even well-aligned agents make mistakes. Users should start with low-stakes tasks (triage, drafts, research) and build trust before delegating anything with real consequences.

4. **Injection filter is not perfect.** The filter catches common prompt injection patterns, but no filter catches everything. Users should avoid pointing the agent at emails, files, or web pages from sources they wouldn't trust with their account credentials.

5. **Budget controls exist for a reason.** Autonomous agents can loop and burn through tokens fast. ArmorClaw's hard-stop is at the user's configured monthly cap. $20/month is the default.

---

**Pricing:** Free for the first month. $19.99/month thereafter. Users bring their own API key or run Ollama at no cost.

Built by Shuriken Labs LLC, Milan, Michigan. Contact: hello@armorclaw.app
