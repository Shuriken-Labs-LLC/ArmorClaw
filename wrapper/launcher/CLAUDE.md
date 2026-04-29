# ArmorClaw Launcher

ArmorClaw is a desktop Electron app (system tray) that wraps the OpenClaw AI gateway. ArmorClaw owns the Electron shell, security layer, dashboard UI, and onboarding wizard. Everything else — the agent runtime, tool execution, model routing, messaging channels — is delegated natively to OpenClaw.

## Architecture

```
wrapper/
  launcher/         ← Electron main process (this directory)
    main.ts          — app lifecycle, single-instance lock, login item, wizard/dashboard startup
    gateway-manager.ts — spawns `node openclaw.mjs gateway`, health-polls port 18789
    dashboard-window.ts — BrowserWindow + BrowserView overlay for Advanced tab
    tray.ts          — system tray icon (green/amber/red), context menu, notifications
    auto-updater.ts  — electron-updater from GitHub Releases
    assets/          — tray icons, DMG background, .icns
    scripts/         — icon generation, wizard public copy, desktop shortcut
  dashboard/
    server.ts        — Express on :7390, SSE push, all API routes
    index.ts         — standalone entry point (node --experimental-strip-types)
    public/index.html — single-page dashboard UI
  onboarding/
    server.ts        — Express on :7391, 6-step wizard
    index.ts         — standalone entry point
    state.ts         — in-memory wizard session state
    env-writer.ts    — safe .env file read/write
    validators.ts    — pure validation for steps 1-6
    tailscale.ts     — Tailscale detection, polling, `tailscale serve`
  config/
    system-prompt.ts — agent system prompt + memory file management
  lib/
    model-adapter.ts — Anthropic/OpenAI/Ollama completion abstraction
    skill-registry.ts — bundled-skill manifest registration (no user-skill loading)
    platform-paths.ts — cross-platform config directory resolution
  security/
    audit-logger.ts  — NDJSON audit log to ~/.armorclaw/audit.log (OpenClaw plugin)
    permissions.ts   — permission manifests, hard-banned levels, approval queue (OpenClaw plugin)
  token-tracker/
    store.ts         — NDJSON token event log, budget alerts, daily/monthly aggregation
    pricing.ts       — per-model pricing table (Anthropic, OpenAI; Ollama = free)
  undo/
    registry.ts      — single-slot undo registry (60s expiry)
  recipes/
    types.ts         — Recipe, RecipeState, RecipeWithState interfaces
    store.ts         — recipe state persistence to ~/.armorclaw/recipes.json
    library/         — bundled recipe definitions (morning-inbox, daily-briefing, file-watcher, weekly-summary)
```

## Key ports

| Port  | Service                        |
|-------|--------------------------------|
| 7390  | Dashboard (Express, in-process)|
| 7391  | Onboarding wizard (Express)    |
| 18789 | OpenClaw gateway (WebSocket)   |

## Key paths

| Path                              | Purpose                           |
|-----------------------------------|-----------------------------------|
| `~/.armorclaw/`                   | Config dir (audit.log, tokens, memory, recipes) |
| `~/.armorclaw/install-path.txt`   | Repo root written by wizard Step 6 |
| `~/.armorclaw/memory.md`          | Agent long-term memory file        |
| `~/.openclaw/openclaw.json`       | OpenClaw config (gateway token lives here) |
| `<repo-root>/.env`               | API keys, provider config, sandbox dir |

## Commands

### Fast reinstall (kills, rebuilds, reinstalls, launches)
```sh
pkill -f ArmorClaw 2>/dev/null; pkill -f openclaw 2>/dev/null; sleep 2; rm -rf /Applications/ArmorClaw.app; rm -rf ~/.armorclaw; rm -rf ~/.openclaw; cd ~/armorclaw/wrapper/launcher && npm run build:mac && cp -R ~/armorclaw/dist/launcher/mac-arm64/ArmorClaw.app /Applications/; open /Applications/ArmorClaw.app
```
Note: `npm run build:ts` only compiles TS to `dist-src/`. The `.app` bundle requires `npm run build:mac` (electron-builder). Build output is at `~/armorclaw/dist/launcher/` (repo root, not `wrapper/launcher/dist/`).

### Full DMG build
```sh
cd ~/armorclaw/wrapper/launcher && npm run build:mac
```
Output: `~/armorclaw/dist/launcher/ArmorClaw-0.1.0-arm64.dmg`

### Dev mode (no packaging)
```sh
cd ~/armorclaw/wrapper/launcher && npm start
```

### TypeScript compile only
```sh
cd ~/armorclaw/wrapper/launcher && npm run build:ts
```

## Known harmless TS errors

`security/audit-logger.ts` and `security/permissions.ts` import `openclaw/plugin-sdk` types with `@ts-ignore` — these types don't exist as a real npm package. The imports are used for the OpenClaw plugin hook API (`api.on("after_tool_call", ...)`, `api.on("before_tool_call", ...)`). `tsconfig.json` has `noEmitOnError: false` and `skipLibCheck: true` to allow compilation despite these missing types.

## Design principles

- **Tray-only**: no dock icon on macOS, no visible windows by default
- **In-process servers**: both wizard and dashboard are Express servers running inside the Electron process (never spawned as external node subprocesses)
- **Gateway is external**: `node openclaw.mjs gateway` runs as a child process, managed by GatewayManager
- **Token sync**: the gateway owns its auth token in `~/.openclaw/openclaw.json`; ArmorClaw reads it back and syncs to `.env`
- **Security layer**: permission filter + audit logger register as OpenClaw plugins on `before_tool_call` / `after_tool_call` hooks
- **Approval queue**: undeclared tools trigger `approval_required` (informational for v1 — tools proceed while queued; full execution gating requires async approval support in the gateway)

## Current status

### Inline chat panel (migrated from floating window)
The floating chat window (`chat-window.ts`, `chat/chat.html`) has been removed. Chat is now an inline panel in the dashboard home view (`dashboard/public/index.html`). Same WebSocket protocol:
- Frame format: `{type:"req"|"res"|"event", ...}` (NOT JSON-RPC)
- Auth flow: gateway sends `connect.challenge` event with nonce → client sends `connect` req with token + nonce → gateway responds
- `/api/chat/gateway-config` polls for the gateway token. Returns 503 if not ready.
- Streaming via `stream.text.delta` events; turn completion via `agent.turn.complete` / `chat.turn.complete`.
- Triple-click panel header toggles debug log.

### Advanced view gateway status polling (fixed)
`dashboard-window.ts:probeGateway()` now calls `/api/advanced/gateway-probe` (TCP-level probe) instead of HTTP GET to the WebSocket server root.

### Pending approvals card (fixed)
`getPendingApprovals()` merges two sources:
1. In-process: `security/permissions.ts` approval queue
2. Gateway: `exec.approvals` RPC via native WebSocket (2s timeout, graceful fallback)

Each approval carries `source: "local" | "gateway"`. Deduplicates by id (local wins on collision).

## Next priorities

1. Full approval gating (pause tool execution until user responds via dashboard)
2. Email & calendar integration (Gmail/Outlook OAuth flows are scaffolded in onboarding but the actual email skill is not yet implemented)
3. Recipe cron runner (store tracks state but nothing invokes the recipes on schedule)
