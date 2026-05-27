import Database from "better-sqlite3";
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

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

  const migrationsDir = join(__dirname, "migrations");

  const migrations = [
    { version: 1, file: "0001_initial.sql" },
  ];

  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) {
      logger.info(`Migration ${migration.version} already applied, skipping`);
      continue;
    }

    const sqlPath = join(migrationsDir, migration.file);
    if (!existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }

    const sql = readFileSync(sqlPath, "utf-8");
    logger.info(`Applying migration ${migration.version}: ${migration.file}`);

    database.exec(sql);

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
