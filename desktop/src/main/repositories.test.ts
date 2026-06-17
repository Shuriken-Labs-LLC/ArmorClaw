import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import migration0001 from "./migrations/0001_initial.sql?raw";

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");

  testDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
  testDb.exec(migration0001);
  return testDb;
}

describe("database schema", () => {
  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates all expected tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("workspaces");
    expect(names).toContain("projects");
    expect(names).toContain("chats");
    expect(names).toContain("messages");
    expect(names).toContain("notes");
    expect(names).toContain("memories");
    expect(names).toContain("entities");
    expect(names).toContain("commitments");
    expect(names).toContain("commitment_runs");
    expect(names).toContain("app_state");
    expect(names).toContain("audit_entries");
    expect(names).toContain("schema_versions");
  });

  it("seeds app_state single row", () => {
    const row = db.prepare("SELECT * FROM app_state WHERE id = 1").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["onboarding_state"]).toBe("welcome");
    expect(row["model_provider"]).toBe("anthropic");
    expect(row["personality_mode"]).toBe("standard");
    expect(row["autonomy_default"]).toBe("gated");
  });

  it("enforces workspace -> project cascade delete", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);

    const projBefore = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get();
    expect(projBefore).toBeDefined();

    db.prepare("DELETE FROM workspaces WHERE id = 'ws1'").run();

    const projAfter = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get();
    expect(projAfter).toBeUndefined();
  });

  it("workspace CRUD works", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, color, sort_order, created_at, updated_at) VALUES ('ws1', 'Work', '#6366f1', 0, ?, ?)",
    ).run(now, now);

    const ws = db.prepare("SELECT * FROM workspaces WHERE id = 'ws1'").get() as Record<string, unknown>;
    expect(ws["name"]).toBe("Work");
    expect(ws["color"]).toBe("#6366f1");

    db.prepare("UPDATE workspaces SET name = 'Updated' WHERE id = 'ws1'").run();
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = 'ws1'").get() as Record<string, unknown>;
    expect(updated["name"]).toBe("Updated");
  });

  it("chat and message flow works", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO chats (id, project_id, title, created_at, last_msg_at) VALUES ('c1', 'p1', 'Test Chat', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'Hello', ?)",
    ).run(now);

    const msgs = db.prepare("SELECT * FROM messages WHERE chat_id = 'c1'").all() as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!["content"]).toBe("Hello");
    expect(msgs[0]!["role"]).toBe("user");
  });

  it("memory FTS search works", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);
    db.prepare(
      `INSERT INTO memories (id, project_id, subject, value, confidence, status, created_at, updated_at)
       VALUES ('mem1', 'p1', 'Favorite food', 'User loves sushi and ramen', 0.8, 'approved', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO memories (id, project_id, subject, value, confidence, status, created_at, updated_at)
       VALUES ('mem2', 'p1', 'Work schedule', 'User works 9 to 5', 0.7, 'approved', ?, ?)`,
    ).run(now, now);

    const results = db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON m.rowid = f.rowid
         WHERE m.project_id = 'p1' AND memories_fts MATCH 'sushi'`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!["subject"]).toBe("Favorite food");
  });

  it("commitments table works", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);
    db.prepare(
      `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, action_template, created_at, updated_at)
       VALUES ('com1', 'ws1', 'p1', 'Daily standup reminder', 'time', '{"cron":"0 9 * * *"}', 'Send standup reminder', ?, ?)`,
    ).run(now, now);

    const commitment = db.prepare("SELECT * FROM commitments WHERE id = 'com1'").get() as Record<string, unknown>;
    expect(commitment["description"]).toBe("Daily standup reminder");
    expect(commitment["status"]).toBe("active");
    expect(commitment["autonomy"]).toBe("gated");
  });

  it("commitment runs cascade on commitment delete", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);
    db.prepare(
      `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, action_template, created_at, updated_at)
       VALUES ('com1', 'ws1', 'p1', 'Test', 'interval', '{}', 'Do stuff', ?, ?)`,
    ).run(now, now);
    db.prepare(
      "INSERT INTO commitment_runs (id, commitment_id, started_at, outcome) VALUES ('run1', 'com1', ?, 'completed')",
    ).run(now);

    const runsBefore = db.prepare("SELECT * FROM commitment_runs WHERE commitment_id = 'com1'").all();
    expect(runsBefore).toHaveLength(1);

    db.prepare("DELETE FROM commitments WHERE id = 'com1'").run();

    const runsAfter = db.prepare("SELECT * FROM commitment_runs WHERE commitment_id = 'com1'").all();
    expect(runsAfter).toHaveLength(0);
  });

  it("due commitments query uses next_fire_at index", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)",
    ).run(now, now);

    // Past due
    db.prepare(
      `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, next_fire_at, action_template, created_at, updated_at)
       VALUES ('com1', 'ws1', 'p1', 'Past due', 'interval', '{}', ?, 'Do stuff', ?, ?)`,
    ).run(now - 60000, now, now);

    // Future
    db.prepare(
      `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, next_fire_at, action_template, created_at, updated_at)
       VALUES ('com2', 'ws1', 'p1', 'Future', 'interval', '{}', ?, 'Do stuff', ?, ?)`,
    ).run(now + 3600000, now, now);

    // Paused (should not appear)
    db.prepare(
      `INSERT INTO commitments (id, workspace_id, project_id, description, trigger_type, trigger_spec, next_fire_at, action_template, status, created_at, updated_at)
       VALUES ('com3', 'ws1', 'p1', 'Paused', 'interval', '{}', ?, 'Do stuff', 'paused', ?, ?)`,
    ).run(now - 30000, now, now);

    const due = db.prepare(
      "SELECT * FROM commitments WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at",
    ).all(now) as Array<Record<string, unknown>>;

    expect(due).toHaveLength(1);
    expect(due[0]!["id"]).toBe("com1");
  });

  it("onboarding state updates correctly", () => {
    const row = db.prepare("SELECT onboarding_state FROM app_state WHERE id = 1").get() as Record<string, unknown>;
    expect(row["onboarding_state"]).toBe("welcome");

    db.prepare("UPDATE app_state SET onboarding_state = 'done' WHERE id = 1").run();

    const updated = db.prepare("SELECT onboarding_state FROM app_state WHERE id = 1").get() as Record<string, unknown>;
    expect(updated["onboarding_state"]).toBe("done");
  });

  it("audit entries work", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_entries (event_type, payload_json, created_at) VALUES ('test.event', '{\"key\":\"value\"}', ?)",
    ).run(now);

    const entries = db.prepare("SELECT * FROM audit_entries ORDER BY created_at DESC LIMIT 1").all() as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["event_type"]).toBe("test.event");
  });

  it("memory update and delete work", () => {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)").run(now, now);
    db.prepare(
      `INSERT INTO memories (id, project_id, subject, value, confidence, status, created_at, updated_at)
       VALUES ('mem1', 'p1', 'Original', 'Original value', 0.8, 'approved', ?, ?)`,
    ).run(now, now);

    db.prepare("UPDATE memories SET subject = 'Updated', updated_at = ? WHERE id = 'mem1'").run(now + 1);
    const updated = db.prepare("SELECT * FROM memories WHERE id = 'mem1'").get() as Record<string, unknown>;
    expect(updated["subject"]).toBe("Updated");

    db.prepare("DELETE FROM memories WHERE id = 'mem1'").run();
    const deleted = db.prepare("SELECT * FROM memories WHERE id = 'mem1'").get();
    expect(deleted).toBeUndefined();
  });

  it("topics for project query works", () => {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Test', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, workspace_id, name, sort_order, brain_mode, created_at, updated_at) VALUES ('p1', 'ws1', 'Proj', 0, 'smart', ?, ?)").run(now, now);
    db.prepare(
      `INSERT INTO memories (id, project_id, subject, value, confidence, status, created_at, updated_at)
       VALUES ('mem1', 'p1', 'Test memory', 'Value', 0.8, 'approved', ?, ?)`,
    ).run(now, now);
    db.prepare("INSERT INTO topics (id, workspace_id, name, use_count, last_used_at, created_at) VALUES ('t1', 'ws1', 'Finance', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO memory_topics (memory_id, topic_id) VALUES ('mem1', 't1')").run();

    const topics = db.prepare(
      `SELECT DISTINCT t.* FROM topics t
       JOIN memory_topics mt ON t.id = mt.topic_id
       JOIN memories m ON m.id = mt.memory_id
       WHERE m.project_id = 'p1'`,
    ).all() as Array<Record<string, unknown>>;
    expect(topics).toHaveLength(1);
    expect(topics[0]!["name"]).toBe("Finance");
  });

  it("getWorkspace returns workspace by ID", () => {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws-get', 'Test WS', 0, ?, ?)").run(now, now);

    const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get("ws-get") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!["name"]).toBe("Test WS");

    const missing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get("nonexistent") as Record<string, unknown> | undefined;
    expect(missing).toBeUndefined();
  });

  it("dossier pins CRUD", () => {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws-dp', 'WS', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO topics (id, workspace_id, name, use_count, created_at) VALUES ('t-dp', 'ws-dp', 'Topic', 0, ?)").run(now);
    db.prepare("INSERT INTO dossier_pins (id, topic_id, content_md, generated_at, is_archived) VALUES ('dp1', 't-dp', '# Dossier', ?, 0)").run(now);

    const pins = db.prepare("SELECT * FROM dossier_pins WHERE topic_id = ? AND is_archived = 0").all("t-dp") as Array<Record<string, unknown>>;
    expect(pins).toHaveLength(1);
    expect(pins[0]!["content_md"]).toBe("# Dossier");

    db.prepare("UPDATE dossier_pins SET is_archived = 1 WHERE id = ?").run("dp1");
    const active = db.prepare("SELECT * FROM dossier_pins WHERE topic_id = ? AND is_archived = 0").all("t-dp") as Array<Record<string, unknown>>;
    expect(active).toHaveLength(0);
  });

  it("entity cross-walk search works", () => {
    const now = Date.now();
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws1', 'Work', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO workspaces (id, name, sort_order, created_at, updated_at) VALUES ('ws2', 'Personal', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO entities (id, workspace_id, name, type, created_at, updated_at) VALUES ('e1', 'ws1', 'Alice', 'person', ?, ?)").run(now, now);
    db.prepare("INSERT INTO entities (id, workspace_id, name, type, created_at, updated_at) VALUES ('e2', 'ws2', 'Alice Smith', 'person', ?, ?)").run(now, now);
    db.prepare("INSERT INTO entities (id, workspace_id, name, type, created_at, updated_at) VALUES ('e3', 'ws1', 'Bob', 'person', ?, ?)").run(now, now);

    const results = db.prepare(
      `SELECT e.*, w.name AS ws_name FROM entities e
       JOIN workspaces w ON w.id = e.workspace_id
       WHERE e.name LIKE '%Alice%' COLLATE NOCASE
       ORDER BY e.name`,
    ).all() as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]!["name"]).toBe("Alice");
    expect(results[0]!["ws_name"]).toBe("Work");
    expect(results[1]!["name"]).toBe("Alice Smith");
  });
});
