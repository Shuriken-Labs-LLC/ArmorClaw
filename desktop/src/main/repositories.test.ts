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

  it("audit entries work", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_entries (event_type, payload_json, created_at) VALUES ('test.event', '{\"key\":\"value\"}', ?)",
    ).run(now);

    const entries = db.prepare("SELECT * FROM audit_entries ORDER BY created_at DESC LIMIT 1").all() as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["event_type"]).toBe("test.event");
  });
});
