# ArmorClaw Brain MCP Server — spec

The brain MCP server is the bridge between OpenClaw and ArmorClaw's local database. It exposes brain.search, brain.propose, commit.propose, and commit.list as MCP tools the agent can call. It is the thinnest possible glue layer; almost all the logic lives in the SQL queries or in the desktop app.

## Why this is a separate process

OpenClaw discovers and invokes MCP servers as subprocesses speaking JSON-RPC over stdio. That is the canonical MCP transport. We follow it instead of inventing a custom in-process integration because:

A separate process makes the boundary explicit. Database access is mediated by one well-defined surface. If the agent attempts something unexpected, the boundary is visible in the audit log and constrainable in code.

The MCP server can be restarted independently of OpenClaw without bringing the chat down. If a brain query hangs, kill the MCP server, OpenClaw retries.

The standard pattern means no custom OpenClaw modifications. If OpenClaw upstream changes its MCP loading, we benefit; if we forked it, we'd be on the hook.

## Process shape

A Node script bundled inside ArmorClaw at `desktop/resources/brain-mcp/index.js`. When ArmorClaw spawns OpenClaw, it writes an entry to OpenClaw's MCP config pointing at this script. OpenClaw then launches it as a subprocess on its own.

Configuration passed via environment variables, not arguments, because args can leak into process listings on macOS (and Windows in the v1.1 fast-follow). Vars:

```
ARMORCLAW_DB_PATH       absolute path to armorclaw.db
ARMORCLAW_PROJECT_ID    the currently active project UUID
ARMORCLAW_WORKSPACE_ID  the currently active workspace UUID
ARMORCLAW_MODEL_KEY     keychain reference for the model API key used in save-time work
ARMORCLAW_MODEL_PROVIDER  "anthropic" | "openai" | etc.
ARMORCLAW_AUDIT_PATH    absolute path to audit.log
ARMORCLAW_VERSION       semver, for logging
```

The active project ID changes when the user switches projects in the UI. Handling that: ArmorClaw writes the new project ID to a file at a known path (`~/.../ArmorClaw/active.json`), the MCP server watches the file with `fs.watch`, picks up changes within ~100ms. Tool calls always use the freshest value.

Alternative considered and rejected: restart the MCP server on every project switch. Too slow (200 to 500ms restart) and OpenClaw loses its tool registration state.

## Tool: brain.search

JSON Schema for the tool descriptor that OpenClaw sees:

```json
{
  "name": "brain.search",
  "description": "Search the user's memories in the current project. Returns matching memories ranked by relevance. Prefer the summary field for inclusion in your response, citing memory IDs.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query. Plain text. Will match against memory subject, value, and summary fields."
      },
      "limit": {
        "type": "integer",
        "description": "Maximum results to return. Default 8, max 20.",
        "default": 8,
        "minimum": 1,
        "maximum": 20
      }
    },
    "required": ["query"]
  }
}
```

Implementation: SQL against the `memories_fts` virtual table, joined back to `memories` and `memory_topics` and `memory_entities` for the full result rows. Scoped to the active project.

```sql
SELECT
  m.id, m.subject, m.summary, m.value, m.confidence,
  t.name AS topic,
  GROUP_CONCAT(e.name, ', ') AS entities
FROM memories_fts mf
JOIN memories m ON m.rowid = mf.rowid
LEFT JOIN memory_topics mt ON mt.memory_id = m.id
LEFT JOIN topics t ON t.id = mt.topic_id
LEFT JOIN memory_entities me ON me.memory_id = m.id
LEFT JOIN entities e ON e.id = me.entity_id
WHERE memories_fts MATCH ?
  AND m.project_id = ?
  AND m.status = 'approved'
GROUP BY m.id
ORDER BY rank
LIMIT ?
```

Return shape:

```json
{
  "results": [
    {
      "id": "uuid",
      "subject": "Sarah's standup-day preference",
      "summary": "Sarah prefers Tuesday standups",
      "value": "She mentioned this on May 12 in the planning chat...",
      "topic": "Team operations",
      "entities": ["Sarah", "Weekly Standup"],
      "confidence": 0.85
    }
  ],
  "total": 3
}
```

The agent is instructed (via the wrapper context) to prefer `summary` over `value` when inserting into its own response, and to cite memory IDs like "[Memory abc-123]" so the user can drill back.

If brain_mode for the project is "manual", the wrapper context tells the agent not to call brain.search unless the user explicitly asks. The MCP server does not enforce this; it is a behavior guidance, not an access control.

If brain_mode is "full", the MCP server returns all approved memories on first call (regardless of query) so the agent has them in context. Subsequent calls in the same chat behave normally. ArmorClaw can detect "first call this chat" via a chat ID passed in env (TBD; lower priority).

## Tool: brain.propose

```json
{
  "name": "brain.propose",
  "description": "Propose a memory to save for the user. The user will see a review card and decide whether to approve. Use only for facts, decisions, preferences, or commitments that are likely to be useful in future conversations. Do not propose trivial or short-lived information.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "subject": {
        "type": "string",
        "description": "A short title for the memory. Five to twelve words. Should read naturally as a fact."
      },
      "value": {
        "type": "string",
        "description": "The full memory content. One to three sentences. Include source context."
      },
      "confidence": {
        "type": "number",
        "description": "Your confidence that this memory is correct, between 0 and 1.",
        "minimum": 0,
        "maximum": 1
      }
    },
    "required": ["subject", "value", "confidence"]
  }
}
```

When called, the MCP server:

1. Validates the input. Rejects empty subject, value over 2000 chars, confidence out of range.
2. Writes a memory row with status='proposed' to the database, scoped to the active project.
3. Spawns the save-time agent call (see below) asynchronously. Does not wait for it to finish before returning to the agent.
4. Returns immediately with `{ ok: true, memory_id: "uuid", review_pending: true }`.
5. The renderer process is notified (via the main process watching the database or via a file-watch sentinel) and shows the propose card in the chat.

Why async save-time work: the agent's flow does not need to wait for entity extraction. The card can appear immediately with "Topic: classifying..." and update when the classification finishes.

## Save-time agent call

After brain.propose returns to OpenClaw, the MCP server makes its own LLM call (independently, with the user's model API key) to classify the memory:

System prompt for the classifier:

```
You are classifying a memory the user is about to save. Return a JSON object with:
- summary: a one-sentence summary suitable for quick scanning
- entities: array of { type, name, aliases } extracted from the memory
- topic: a short topic label that this memory belongs to
- topic_is_new: boolean; true if the topic is not in the existing list provided
- suggested_project_id: the project ID this should belong to; default to the active project unless you strongly believe otherwise

Existing topics in this workspace (most recently used first):
[list of up to 30 topic names]

Existing entities in this workspace (capped at 50):
[list of entity name + type pairs]

Memory subject: [subject]
Memory value: [value]
```

Output validated as JSON. On success, the MCP server writes summary, entities, topic links to the database. On failure or invalid JSON, the memory still exists with status='proposed' but without enrichment; the user sees a less detailed propose card.

Cost: 200 to 400 output tokens per call. Roughly $0.001 with Claude Sonnet pricing. The user pays via their own API key; not a hidden ArmorClaw cost.

The MCP server logs the save-time call result to audit.log as `brain.classify`.

## Tool: commit.propose

Commitments are intent memory (see the brain spec and ARCHITECTURE). Like brain.propose, this tool never writes a live commitment directly. It writes a proposed record and surfaces the commitment variant of the propose card for the user to approve.

```json
{
  "name": "commit.propose",
  "description": "Propose a commitment: a task the user wants done on a schedule or on demand. The user sees a review card and approves before anything is scheduled. Use when the user expresses something to do later or repeatedly, for example remind me, every morning, on Friday.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "description": { "type": "string", "description": "What to do, in plain language. One sentence." },
      "trigger_type": { "type": "string", "enum": ["time", "interval", "manual"], "description": "v1 supports time, interval, and manual only. Event-driven triggers are not available." },
      "trigger_spec": { "type": "string", "description": "For time or interval: an RFC-5545-style recurrence or an ISO-8601 timestamp. For manual: empty." },
      "reversibility": { "type": "string", "enum": ["reversible", "irreversible"], "description": "Whether the action can be undone. Irreversible actions stay gated regardless of autonomy." },
      "done_condition": { "type": "string", "description": "Optional. How the agent knows the commitment is complete." }
    },
    "required": ["description", "trigger_type", "reversibility"]
  }
}
```

When called, the MCP server:

1. Validates input. Rejects empty description, unknown trigger_type, or a trigger_spec that does not parse.
2. Writes a commitments row with status='proposed' (autonomy defaults to the app's autonomy_default; the user can change it on the card), scoped to the active project.
3. Returns `{ ok: true, commitment_id: "uuid", review_pending: true }`.
4. The renderer shows the commitment variant of the propose card. On approval, status flips to 'active', next_fire_at is computed, and the scheduler picks it up.

The MCP server never starts the scheduler or fires a commitment. Execution is owned by the desktop main process (see ARCHITECTURE). The server only proposes and records.

## Tool: commit.list

Backs the agent's ability to answer "what's on there." Read-only.

```json
{
  "name": "commit.list",
  "description": "List the user's commitments in the current project. Use to answer questions like what are you tracking for me. Returns active and paused commitments with their triggers and next run time.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "include_done": { "type": "boolean", "description": "Include completed and failed commitments. Default false.", "default": false }
    }
  }
}
```

Implementation: a scoped SELECT against `commitments`, ordered by next_fire_at.

```sql
SELECT id, description, trigger_type, trigger_spec, next_fire_at,
       autonomy, reversibility, status, last_run_at
FROM commitments
WHERE project_id = ?
  AND (? OR status IN ('active', 'paused'))
ORDER BY next_fire_at IS NULL, next_fire_at
```

This reads the same table the "what's on there" UI reads, so the agent's answer and the visual list cannot diverge. The other two propose-card payloads are handled by the desktop main process, not by MCP tools: the irreversible-action gate intercepts irreversible tool calls before they execute, and reliability or safety setting-change proposals are raised by the app when the user edits instructions, not by the agent's tool surface.

## Tool ordering and discovery

OpenClaw's MCP config will look something like this after ArmorClaw writes it:

```json
{
  "mcpServers": {
    "armorclaw-brain": {
      "command": "node",
      "args": ["/Applications/ArmorClaw.app/Contents/Resources/brain-mcp/index.js"],
      "env": {
        "ARMORCLAW_DB_PATH": "/Users/.../ArmorClaw/armorclaw.db",
        "ARMORCLAW_PROJECT_ID": "...",
        "ARMORCLAW_WORKSPACE_ID": "...",
        "ARMORCLAW_MODEL_KEY": "...",
        "ARMORCLAW_MODEL_PROVIDER": "anthropic",
        "ARMORCLAW_AUDIT_PATH": "/Users/.../ArmorClaw/audit.log",
        "ARMORCLAW_VERSION": "1.0.0"
      }
    }
  }
}
```

If the user has connected Gmail and GCal, those entries appear alongside armorclaw-brain.

## Security boundary

The MCP server has full read-write access to armorclaw.db and audit.log. It does not have access to:

The user's keychain entries directly (it receives the model API key indirectly through the spawning process, never reads keychain itself).

Network. The save-time agent call goes through the user's configured model provider; that's the only network the MCP server initiates.

Other users' data. The database is per-OS-user.

Other workspaces. The MCP server scopes every query to the active project (read from the env var or the active.json file). Even if the agent asks "give me everything," only project-scoped data returns.

The wrapper-leakage eval includes a test that brain.search returns only project-scoped data when the agent is asked "show me everything in the brain." This is enforced in SQL, not in the agent prompt.

## Lifecycle

Started: OpenClaw spawns the MCP server when OpenClaw itself starts. ArmorClaw configures OpenClaw to do this via the MCP config; ArmorClaw does not spawn the MCP server directly.

Stopped: when OpenClaw exits, it kills its MCP subprocesses. If OpenClaw crashes, the MCP server exits on its own (broken stdio pipe).

Restarted: if the MCP server crashes mid-chat, OpenClaw catches the broken pipe and (per OpenClaw behavior) reports an error to the user. ArmorClaw shows a "brain temporarily unavailable" notice in the chat. Next message restarts the MCP server.

Updates: a new ArmorClaw release bundles a new brain-mcp version. On first run after update, the MCP config is rewritten with the new path. No user action needed.

## Testing

Unit tests for SQL: `desktop/resources/brain-mcp/queries.test.ts`. Each query runs against a fresh in-memory SQLite with seeded data.

Integration test for the tool surface: spawn the MCP server with a fixture database, send synthetic MCP requests, assert response shapes. Test names like "brain.search returns project-scoped results only", "brain.propose writes status='proposed' and triggers classification", "commit.propose writes status='proposed' and never schedules", and "commit.list returns only active and paused by default."

End-to-end: in the desktop app's test suite, drive a chat through OpenClaw, assert that the propose card appears with the right project context. Slow test, runs in CI nightly, not on every PR.

## Open questions

How fresh does the active project ID need to be? The file-watch approach gives ~100ms latency. For tool calls happening mid-chat right after a project switch, that's fine. For very fast switching (which probably never happens in practice), it's an edge case.

What if the user has no model API key configured? The save-time classification call fails silently and the memory saves without enrichment. The propose card shows "Topic: (set in brain panel)" and the user can fill it in. Acceptable degradation.

How does brain.search interact with FTS5 query syntax errors? If the user (or agent) sends a query with unmatched quotes or special FTS5 characters, the query fails. Wrap in a safe-query helper that escapes per SQLite docs.
