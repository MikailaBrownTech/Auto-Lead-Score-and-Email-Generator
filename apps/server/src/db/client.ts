import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fromRoot } from "../config/paths";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_DIR = fromRoot("apps/server/drizzle");

/** Opens (or creates) the SQLite database and applies pending migrations. Use ":memory:" in tests. */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
