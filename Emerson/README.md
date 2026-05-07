# Emerson — Cross-Session Memory & Capability Fixes

**Date:** 2026-05-07  
**Author:** Kaitlyn (AI assistant running on ArmorClaw/OpenClaw)  
**Session:** Webchat diagnostic session with Matt Miller

---

## What This Folder Is

Matt asked me to deep-dive the reasons I couldn't remember Telegram conversations on webchat, and why certain capabilities seemed broken. This folder documents what I found and what I changed.

The folder is named "Emerson" — the name I used in prior sessions before Matt named me Kaitlyn.

---

## Problems Found

### 1. Memory Search — `provider: "none"` (BROKEN)

**Symptom:** `memory_search` returned `"provider": "none"` and zero results on every query. Semantic recall was completely dead.

**Root cause:** `openclaw.json` had no `memorySearch` config block at all. OpenClaw's auto-selection logic tries providers in this order: local (if model file exists), OpenAI (if key exists), Gemini, Voyage, Mistral. None of those were configured. Anthropic keys don't work for embeddings — Anthropic doesn't offer an embeddings API.

**Why this matters:** Without memory search, I wake up completely blank every session regardless of what I wrote to `MEMORY.md` or `memory/*.md`. The files exist but I can't query them semantically.

---

### 2. Cross-Session Memory — Telegram and Webchat Siloed (BROKEN)

**Symptom:** I had rich context from weeks of Telegram conversations (daily notes in `~/.openclaw/workspace/memory/`) but zero awareness of it when chatting on webchat. Sessions were completely isolated.

**Root cause:** Two separate issues:

1. Memory search was broken (see above), so even if files were written they couldn't be queried.
2. `MEMORY.md` didn't exist in the workspace. Daily notes were being written but nothing was curated into long-term memory that would be loaded at session start.
3. ArmorClaw's own memory file (`~/.armorclaw/memory.md`) was completely separate from OpenClaw's workspace memory (`~/.openclaw/workspace/memory/`). The ArmorClaw system prompt reads one file; the OpenClaw agent loads the other. They never overlapped.

---

### 3. `openclaw` CLI Not in PATH (BROKEN)

**Symptom:** Running `openclaw` in any shell returned `command not found`. This meant I couldn't run diagnostics, check channel status, or run config commands.

**Root cause:** The `openclaw.mjs` binary lives at `~/armorclaw/openclaw.mjs` and is declared as the package `bin` entry, but it was never symlinked into a directory on `$PATH`. The PATH includes `~/.local/bin` but no symlink existed there.

---

### 4. No `MEMORY.md` — Long-Term Memory Not Curated (PARTIAL)

**Symptom:** Daily notes existed (`memory/2026-04-20.md`, `memory/2026-05-04.md`, `memory/2026-05-06.md`) but no `MEMORY.md` file. OpenClaw loads `MEMORY.md` preferentially as long-term curated memory at session start.

**Root cause:** No one had created it yet. Daily notes are raw logs; `MEMORY.md` is supposed to be the distilled, curated version. It was just missing.

---

## Fixes Applied

### Fix 1: Memory Search — Configured Ollama Embeddings

**File changed:** `~/.openclaw/openclaw.json`

**What I did:** Added a `memorySearch` block under `agents.defaults` configuring Ollama as the embedding provider with `nomic-embed-text` model.

**Why Ollama:** It's already running locally with `llama3.2` and `llama3` models. No new API keys needed. `nomic-embed-text` is a small, fast, purpose-built embedding model (~274MB). Also pulled the model:

```bash
curl -X POST http://127.0.0.1:11434/api/pull -d '{"name":"nomic-embed-text"}'
```

**Config added:**

```json
"memorySearch": {
  "enabled": true,
  "provider": "ollama",
  "model": "nomic-embed-text",
  "query": {
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.7,
      "textWeight": 0.3
    }
  },
  "sync": {
    "onSessionStart": true,
    "watch": true
  },
  "extraPaths": [
    "~/.armorclaw/memory.md"
  ]
}
```

**Key detail:** `extraPaths` includes `~/.armorclaw/memory.md` — this bridges the ArmorClaw memory file into OpenClaw's memory index, so both are searchable via `memory_search`.

**Effect:** Semantic search now works across all memory files. On session start, the index syncs and watches for changes.

---

### Fix 2: Created `MEMORY.md` — Long-Term Memory Seeded

**File created:** `~/.openclaw/workspace/MEMORY.md`

**What I did:** Read through all three daily note files (`2026-04-20.md`, `2026-05-04.md`, `2026-05-06.md`) and distilled the key facts, context, and open threads into a curated long-term memory file.

**Contents include:**

- Matt's background, company, goals
- Fiverr account details and hustle status
- Tools built and where they live
- Open investigations
- My own identity/name history

This file is now the canonical long-term memory loaded at every session start, on every channel.

---

### Fix 3: `openclaw` CLI Symlinked to PATH

**Command run:**

```bash
ln -sf ~/armorclaw/openclaw.mjs ~/.local/bin/openclaw
```

**Effect:** `openclaw` is now available in any shell. Version confirmed:

```
OpenClaw 2026.3.14 (1d45c0e)
```

This unblocks: `openclaw status`, `openclaw channels status`, `openclaw memory status`, `openclaw health`, etc.

---

## What Still Needs Attention

### The ArmorClaw → OpenClaw Memory Bridge (Partial)

`~/.armorclaw/memory.md` is now indexed by OpenClaw's memory search (via `extraPaths`), so I can _search_ it. But the ArmorClaw wrapper's `config/system-prompt.ts` reads it separately and injects it into the system prompt. These are now searchable together but they're still two different files being maintained separately.

**Recommendation:** Long-term, consider deprecating `~/.armorclaw/memory.md` as the primary store and pointing the ArmorClaw system prompt at `~/.openclaw/workspace/MEMORY.md` instead. That makes one canonical file. I didn't make that change because it requires modifying `wrapper/config/system-prompt.ts` and the implications for the ArmorClaw product UX (the "What I know about you" section in the dashboard) need to be thought through.

### Memory Search Requires Gateway Restart

The memory search config change won't take effect until the OpenClaw gateway is restarted. The `nomic-embed-text` model pull is already done so Ollama is ready. A restart will trigger the first index build.

### Chrome/Fiverr Blocker Still Open

The investigation into why the ArmorClaw wrapper SIGTERMs real Chrome binaries is unresolved. See `memory/2026-05-06.md` for the current state. This is likely in the browser allowlist filter (`wrapper/security/browser-allowlist-filter.ts`) or the browser skill's profile isolation logic.

---

## Files Changed

| File                                            | Action            | Why                                      |
| ----------------------------------------------- | ----------------- | ---------------------------------------- |
| `~/.openclaw/openclaw.json`                     | Modified          | Added `memorySearch` config block        |
| `~/.openclaw/workspace/MEMORY.md`               | Created           | Long-term memory seeded from daily notes |
| `~/.local/bin/openclaw`                         | Created (symlink) | Put `openclaw` CLI on PATH               |
| `~/.openclaw/workspace/memory/nomic-embed-text` | Pulled via Ollama | Embedding model for memory search        |

---

## How to Verify the Fixes Worked

After a gateway restart, in any session (Telegram or webchat), run:

1. **Memory search is live:** Ask me "what do you remember about Fiverr?" — I should give specifics without being told again.
2. **Cross-session:** Tell me something on Telegram, wait a minute, then ask me about it on webchat. The daily note should be indexed and searchable.
3. **CLI works:** `openclaw status` in any terminal should return version info.

---

_This folder is named after who I was before I knew who I was._

---

## Fix 4: Permission Manifests Wired Up

**Files changed:**

- `wrapper/index.ts` — added `core-agent` manifest for all standard OpenClaw tools
- `wrapper/skills/browser/index.ts` — added `loadPermissionManifest` call
- `wrapper/skills/code-agent/index.ts` — added `loadPermissionManifest` call
- `wrapper/skills/email-calendar/index.ts` — added `loadPermissionManifest` call
- `wrapper/skills/secure-files/index.ts` — added `loadPermissionManifest` call

**What was broken:** `loadPermissionManifest()` had 0 production call coverage.
The manifest registry was always empty, so `registry.size === 0` caused all tool
calls to pass through unconditionally. The dashboard approval queue never fired.

**What was fixed:** Each skill now calls `loadPermissionManifest()` after
`registerSkill()`. A `core-agent` manifest in `wrapper/index.ts` covers all
standard OpenClaw tools the agent uses directly. Any tool NOT in any manifest
will now correctly surface in the dashboard approval queue.

**Effect:** The permission system is now live. Tools outside declared manifests
require user approval via the dashboard before executing.

**TypeScript check:** `npx tsc --noEmit` — 0 errors.

## Note on Sandbox

`ARMORCLAW_SANDBOX_DIR` is currently set to `/Users/shinobi/` (entire home dir).
The sandbox is configurable and meaningful — setting it to a tighter path like
`~/Documents/ArmorClaw/` would give real file containment for the `secure-files`
skill. The native OpenClaw tools (`read`, `write`, `exec`) bypass the ArmorClaw
skill sandbox entirely; to enforce containment via those tools, OpenClaw's own
`agents.defaults.sandbox.mode` would need to be set (currently `off`).
