-- ArmorClaw v1 initial schema
-- Applied on first launch. Idempotent: each CREATE uses IF NOT EXISTS.
-- Schema mirrors the data model in docs/ARCHITECTURE.md. Changes require an ADR.
--
-- Conventions:
--   - UUIDs stored as TEXT (canonical hyphenated form).
--   - Timestamps stored as INTEGER (Unix epoch ms) for fast comparisons.
--   - Booleans stored as INTEGER (0 or 1).
--   - JSON columns stored as TEXT (parse in application layer).
--   - Snake_case column names. CamelCase happens at the query layer.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ============================================================================
-- Workspaces and projects
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_sort ON workspaces (sort_order);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  color         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  brain_mode    TEXT NOT NULL DEFAULT 'smart' CHECK (brain_mode IN ('smart', 'manual', 'full')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects (workspace_id, sort_order);

-- ============================================================================
-- Chats and messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS chats (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  last_msg_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_project_recent ON chats (project_id, last_msg_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT NOT NULL,
  tool_calls  TEXT,  -- JSON array of tool call records, nullable
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

-- ============================================================================
-- Notes
-- ============================================================================

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content_md  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id  TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags (tag);

-- ============================================================================
-- Memories
-- ============================================================================

CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  subject             TEXT NOT NULL,
  value               TEXT NOT NULL,
  summary             TEXT,
  confidence          REAL NOT NULL DEFAULT 0.5,
  source_chat_id      TEXT REFERENCES chats (id) ON DELETE SET NULL,
  source_message_id   TEXT REFERENCES messages (id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  user_notes          TEXT,
  created_at          INTEGER NOT NULL,
  approved_at         INTEGER,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source_chat ON memories (source_chat_id);

-- ============================================================================
-- Entities and memory_entities
-- ============================================================================

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('person', 'project', 'event', 'organization', 'place', 'thing')),
  aliases       TEXT,  -- JSON array
  canonical_id  TEXT REFERENCES entities (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_entities_workspace_name ON entities (workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities (canonical_id);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id  TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities (entity_id);

-- ============================================================================
-- Topics and memory_topics
-- ============================================================================

CREATE TABLE IF NOT EXISTS topics (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_topics_workspace_mru ON topics (workspace_id, last_used_at DESC);

CREATE TABLE IF NOT EXISTS memory_topics (
  memory_id  TEXT NOT NULL UNIQUE REFERENCES memories (id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_topics_topic ON memory_topics (topic_id);

-- ============================================================================
-- Dossier pins (per-topic generated briefings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS dossier_pins (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  content_md    TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  is_archived   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dossier_pins_topic ON dossier_pins (topic_id, generated_at DESC);

-- ============================================================================
-- Attachments
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  local_path      TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments (project_id, created_at DESC);

-- ============================================================================
-- Integrations
-- ============================================================================

CREATE TABLE IF NOT EXISTS integrations (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('connected', 'disconnected', 'error')),
  token_keychain_ref    TEXT,
  last_used_at          INTEGER,
  created_at            INTEGER NOT NULL,
  UNIQUE (type)
);

-- ============================================================================
-- Audit entries
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT,
  project_id    TEXT,
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_entries (project_id, created_at DESC);

-- ============================================================================
-- App state (single-row)
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_state (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  user_email                      TEXT,
  license_jwt                     TEXT,
  license_expires_at              INTEGER,
  last_validated_at               INTEGER,
  openclaw_version                TEXT,
  openclaw_path                   TEXT,
  telegram_bot_token_keychain_ref TEXT,
  active_workspace_id             TEXT,
  active_project_id               TEXT,
  onboarding_state                TEXT NOT NULL DEFAULT 'welcome',
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);

-- Seed the single row if not present
INSERT OR IGNORE INTO app_state (id, onboarding_state, created_at, updated_at)
VALUES (1, 'welcome', strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000);

-- ============================================================================
-- Full-text search (FTS5)
-- ============================================================================

-- Notes FTS
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5 (
  content_md,
  title,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, content_md, title) VALUES (new.rowid, new.content_md, new.title);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, content_md, title) VALUES ('delete', old.rowid, old.content_md, old.title);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, content_md, title) VALUES ('delete', old.rowid, old.content_md, old.title);
  INSERT INTO notes_fts (rowid, content_md, title) VALUES (new.rowid, new.content_md, new.title);
END;

-- Memories FTS (subject + value + summary)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5 (
  subject,
  value,
  summary,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, subject, value, summary) VALUES (new.rowid, new.subject, new.value, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, subject, value, summary) VALUES ('delete', old.rowid, old.subject, old.value, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, subject, value, summary) VALUES ('delete', old.rowid, old.subject, old.value, old.summary);
  INSERT INTO memories_fts (rowid, subject, value, summary) VALUES (new.rowid, new.subject, new.value, new.summary);
END;

-- Messages FTS
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
END;

-- Entities FTS (for fast cross-walk by name and aliases)
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5 (
  name,
  aliases,
  content='entities',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts (rowid, name, aliases) VALUES (new.rowid, new.name, COALESCE(new.aliases, ''));
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts (entities_fts, rowid, name, aliases) VALUES ('delete', old.rowid, old.name, COALESCE(old.aliases, ''));
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts (entities_fts, rowid, name, aliases) VALUES ('delete', old.rowid, old.name, COALESCE(old.aliases, ''));
  INSERT INTO entities_fts (rowid, name, aliases) VALUES (new.rowid, new.name, COALESCE(new.aliases, ''));
END;

-- ============================================================================
-- Schema version (poor man's migration tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_versions (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (1, strftime('%s', 'now') * 1000);
