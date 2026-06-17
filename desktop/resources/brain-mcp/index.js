#!/usr/bin/env node

/**
 * ArmorClaw Brain MCP Server
 *
 * JSON-RPC over stdio. Spawned by OpenClaw as a subprocess.
 * Provides brain.search, brain.propose, commit.propose, commit.list tools.
 */

const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DB_PATH = process.env.ARMORCLAW_DB_PATH;
const PROJECT_ID = process.env.ARMORCLAW_PROJECT_ID;
const WORKSPACE_ID = process.env.ARMORCLAW_WORKSPACE_ID;
const AUDIT_PATH = process.env.ARMORCLAW_AUDIT_PATH;

if (!DB_PATH || !PROJECT_ID || !WORKSPACE_ID) {
  process.stderr.write(
    "brain-mcp: ARMORCLAW_DB_PATH, ARMORCLAW_PROJECT_ID, ARMORCLAW_WORKSPACE_ID required\n"
  );
  process.exit(1);
}

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  const appRequire = createRequire(
    path.join(path.dirname(DB_PATH), "package.json")
  );
  Database = appRequire("better-sqlite3");
}

const db = new Database(DB_PATH, { readonly: false });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

let activeProjectId = PROJECT_ID;
let activeWorkspaceId = WORKSPACE_ID;

const activeJsonPath = path.join(path.dirname(DB_PATH), "active.json");
try {
  fs.watchFile(activeJsonPath, { interval: 100 }, () => {
    try {
      const data = JSON.parse(fs.readFileSync(activeJsonPath, "utf-8"));
      if (data.projectId) activeProjectId = data.projectId;
      if (data.workspaceId) activeWorkspaceId = data.workspaceId;
    } catch {}
  });
} catch {}

function audit(eventType, payload) {
  if (!AUDIT_PATH) return;
  const line = `${new Date().toISOString()} ${eventType} ${JSON.stringify(payload)}\n`;
  try {
    fs.appendFileSync(AUDIT_PATH, line);
  } catch {}
}

// ---- MCP Tool implementations ----

function brainSearch(params) {
  const query = params.query;
  const limit = Math.min(Math.max(params.limit || 8, 1), 20);

  if (!query || typeof query !== "string") {
    return { error: { code: -32602, message: "query is required" } };
  }

  const safeQuery = query.replace(/['"]/g, "").trim();
  if (!safeQuery) {
    return { result: { results: [], total: 0 } };
  }

  try {
    const rows = db
      .prepare(
        `SELECT
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
        LIMIT ?`
      )
      .all(safeQuery, activeProjectId, limit);

    const results = rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      summary: r.summary,
      value: r.value,
      topic: r.topic || null,
      entities: r.entities ? r.entities.split(", ") : [],
      confidence: r.confidence,
    }));

    audit("brain.search", {
      query: safeQuery,
      projectId: activeProjectId,
      resultCount: results.length,
    });

    return { result: { results, total: results.length } };
  } catch (err) {
    return { result: { results: [], total: 0, error: err.message } };
  }
}

function brainPropose(params) {
  const { subject, value, confidence } = params;

  if (!subject || typeof subject !== "string") {
    return { error: { code: -32602, message: "subject is required" } };
  }
  if (!value || typeof value !== "string" || value.length > 2000) {
    return {
      error: { code: -32602, message: "value required, max 2000 chars" },
    };
  }
  if (
    typeof confidence !== "number" ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      error: { code: -32602, message: "confidence must be 0-1" },
    };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO memories (id, project_id, subject, value, confidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`
  ).run(id, activeProjectId, subject, value, confidence, now, now);

  audit("brain.propose", {
    memoryId: id,
    projectId: activeProjectId,
    subject,
  });

  // Save-time classification runs async (non-blocking)
  setImmediate(() => classifyMemory(id, subject, value));

  return { result: { ok: true, memory_id: id, review_pending: true } };
}

function commitPropose(params) {
  const { description, trigger_type, trigger_spec, reversibility, done_condition } = params;

  if (!description || typeof description !== "string") {
    return { error: { code: -32602, message: "description is required" } };
  }
  if (!["time", "interval", "manual"].includes(trigger_type)) {
    return { error: { code: -32602, message: "invalid trigger_type" } };
  }

  const autonomyDefault = db
    .prepare("SELECT autonomy_default FROM app_state WHERE id = 1")
    .get();

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, action_template, reversibility, autonomy, status, done_condition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(
    id,
    activeWorkspaceId,
    activeProjectId,
    description,
    trigger_type,
    trigger_spec || "{}",
    description,
    reversibility || "reversible",
    autonomyDefault?.autonomy_default || "gated",
    done_condition || null,
    now,
    now
  );

  audit("commit.propose", {
    commitmentId: id,
    projectId: activeProjectId,
    description,
  });

  return { result: { ok: true, commitment_id: id, review_pending: true } };
}

function commitList(params) {
  const includeDone = params?.include_done || false;

  const rows = db
    .prepare(
      `SELECT id, description, trigger_type, trigger_spec, next_fire_at,
              autonomy, reversibility, status, last_run_at
       FROM commitments
       WHERE project_id = ?
         AND (? OR status IN ('active', 'paused'))
       ORDER BY next_fire_at IS NULL, next_fire_at`
    )
    .all(activeProjectId, includeDone ? 1 : 0);

  return { result: { commitments: rows } };
}

// ---- Save-time classification (async, best-effort) ----

function classifyMemory(memoryId, subject, value) {
  const modelKey = process.env.ARMORCLAW_MODEL_KEY;
  const provider = process.env.ARMORCLAW_MODEL_PROVIDER || "anthropic";

  if (!modelKey) {
    process.stderr.write("brain-mcp: no model key, skipping classification\n");
    return;
  }

  const existingTopics = db
    .prepare(
      "SELECT name FROM topics WHERE workspace_id = ? ORDER BY last_used_at DESC LIMIT 30"
    )
    .all(activeWorkspaceId)
    .map((r) => r.name);

  const existingEntities = db
    .prepare(
      "SELECT name, type FROM entities WHERE workspace_id = ? LIMIT 50"
    )
    .all(activeWorkspaceId)
    .map((r) => `${r.name} (${r.type})`);

  const systemPrompt = `You are classifying a memory the user is about to save. Return a JSON object with:
- summary: a one-sentence summary suitable for quick scanning
- entities: array of { type, name } extracted from the memory. type is one of: person, project, event, organization, place, thing
- topic: a short topic label that this memory belongs to
- topic_is_new: boolean; true if the topic is not in the existing list provided

Existing topics in this workspace: ${existingTopics.join(", ") || "(none)"}
Existing entities in this workspace: ${existingEntities.join(", ") || "(none)"}

Memory subject: ${subject}
Memory value: ${value}

Return ONLY valid JSON, no markdown fences.`;

  const doClassify = async () => {
    try {
      let body, url, headers;

      if (provider === "anthropic") {
        url = "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": modelKey,
          "anthropic-version": "2023-06-01",
        };
        body = JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{ role: "user", content: systemPrompt }],
        });
      } else {
        url = "https://api.openai.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modelKey}`,
        };
        body = JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 500,
          messages: [
            { role: "system", content: "Return only valid JSON." },
            { role: "user", content: systemPrompt },
          ],
        });
      }

      const resp = await fetch(url, { method: "POST", headers, body });
      if (!resp.ok) {
        process.stderr.write(
          `brain-mcp: classification API error ${resp.status}\n`
        );
        return;
      }

      const data = await resp.json();
      let text;
      if (provider === "anthropic") {
        text = data.content?.[0]?.text || "";
      } else {
        text = data.choices?.[0]?.message?.content || "";
      }

      const parsed = JSON.parse(text);

      if (parsed.summary) {
        db.prepare(
          "UPDATE memories SET summary = ?, updated_at = ? WHERE id = ?"
        ).run(parsed.summary, Date.now(), memoryId);
      }

      if (parsed.topic) {
        const topicRow = db
          .prepare("SELECT id FROM topics WHERE workspace_id = ? AND name = ?")
          .get(activeWorkspaceId, parsed.topic);

        let topicId;
        if (topicRow) {
          topicId = topicRow.id;
          db.prepare(
            "UPDATE topics SET use_count = use_count + 1, last_used_at = ? WHERE id = ?"
          ).run(Date.now(), topicId);
        } else {
          topicId = crypto.randomUUID();
          db.prepare(
            "INSERT INTO topics (id, workspace_id, name, use_count, last_used_at, created_at) VALUES (?, ?, ?, 1, ?, ?)"
          ).run(topicId, activeWorkspaceId, parsed.topic, Date.now(), Date.now());
        }
        db.prepare(
          "INSERT OR REPLACE INTO memory_topics (memory_id, topic_id) VALUES (?, ?)"
        ).run(memoryId, topicId);
      }

      if (Array.isArray(parsed.entities)) {
        for (const ent of parsed.entities) {
          if (!ent.name || !ent.type) continue;
          const validTypes = ["person", "project", "event", "organization", "place", "thing"];
          const entType = validTypes.includes(ent.type) ? ent.type : "thing";

          let entityRow = db
            .prepare("SELECT id FROM entities WHERE workspace_id = ? AND type = ? AND name = ?")
            .get(activeWorkspaceId, entType, ent.name);

          let entityId;
          if (entityRow) {
            entityId = entityRow.id;
          } else {
            entityId = crypto.randomUUID();
            db.prepare(
              "INSERT INTO entities (id, workspace_id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(entityId, activeWorkspaceId, ent.name, entType, Date.now(), Date.now());
          }
          db.prepare(
            "INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)"
          ).run(memoryId, entityId);
        }
      }

      audit("brain.classify", {
        memoryId,
        topic: parsed.topic,
        entityCount: parsed.entities?.length || 0,
      });
    } catch (err) {
      process.stderr.write(
        `brain-mcp: classification error: ${err.message}\n`
      );
    }
  };

  doClassify();
}

// ---- JSON-RPC over stdio ----

const TOOLS = [
  {
    name: "brain.search",
    description:
      "Search the user's memories in the current project. Returns matching memories ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        limit: { type: "integer", default: 8, minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "brain.propose",
    description:
      "Propose a memory to save. The user sees a review card and decides whether to approve.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short title, 5-12 words" },
        value: { type: "string", description: "Full content, 1-3 sentences" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["subject", "value", "confidence"],
    },
  },
  {
    name: "commit.propose",
    description:
      "Propose a commitment: a task to do on a schedule or on demand.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        trigger_type: { type: "string", enum: ["time", "interval", "manual"] },
        trigger_spec: { type: "string" },
        reversibility: { type: "string", enum: ["reversible", "irreversible"] },
        done_condition: { type: "string" },
      },
      required: ["description", "trigger_type", "reversibility"],
    },
  },
  {
    name: "commit.list",
    description:
      "List the user's commitments in the current project.",
    inputSchema: {
      type: "object",
      properties: {
        include_done: { type: "boolean", default: false },
      },
    },
  },
];

const toolHandlers = {
  "brain.search": brainSearch,
  "brain.propose": brainPropose,
  "commit.propose": commitPropose,
  "commit.list": commitList,
};

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "armorclaw-brain", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = params?.name;
      const handler = toolHandlers[toolName];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }
      const handlerResult = handler(params?.arguments || {});
      if (handlerResult.error) {
        return { jsonrpc: "2.0", id, error: handlerResult.error };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: JSON.stringify(handlerResult.result) },
          ],
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// Stdio transport: newline-delimited JSON-RPC
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      const response = handleRequest(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      process.stderr.write(`brain-mcp: parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on("end", () => {
  db.close();
  process.exit(0);
});

process.stderr.write("brain-mcp: server started\n");
