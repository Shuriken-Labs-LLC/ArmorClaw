import Database from "better-sqlite3";
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";
import migration0001 from "./migrations/0001_initial.sql?raw";

let db: Database.Database | undefined;

function getDbPath(): string {
  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  return join(userDataPath, "armorclaw.db");
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized — call initDatabase() first");
  }
  return db;
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath();
  logger.info("Opening database at", dbPath);

  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  migrate(db);

  return db;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: migration0001 },
];

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = database
    .prepare("SELECT version FROM schema_versions ORDER BY version")
    .all() as Array<{ version: number }>;
  const appliedSet = new Set(applied.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.version)) {
      logger.info(`Migration ${migration.version} already applied, skipping`);
      continue;
    }

    logger.info(`Applying migration ${migration.version}`);
    database.exec(migration.sql);
    logger.info(`Migration ${migration.version} applied`);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = undefined;
    logger.info("Database closed");
  }
}
