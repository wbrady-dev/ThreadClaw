import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { logger } from "../utils/logger.js";

let db: Database.Database | null = null;
let storedPath: string | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (db) {
    if (dbPath) {
      const normalized = resolve(dbPath);
      if (storedPath && storedPath !== normalized) {
        throw new Error(
          `getDb called with path "${normalized}" but already connected to "${storedPath}". ` +
          `ThreadClaw uses a singleton DB connection — cannot open two databases.`,
        );
      }
    }
    return db;
  }
  if (!dbPath) {
    throw new Error("getDb: no path provided and database not yet initialized");
  }
  const normalized = resolve(dbPath);
  storedPath = normalized;

  mkdirSync(dirname(normalized), { recursive: true });

  db = new Database(normalized);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -16000"); // 16MB
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 67108864"); // 64MB
  db.pragma("wal_autocheckpoint = 1000");

  // Load sqlite-vec extension
  sqliteVec.load(db);
  logger.info("sqlite-vec extension loaded");

  return db;
}

/**
 * Force a WAL checkpoint. Call after large batch operations (bulk ingest)
 * to flush the WAL to the main DB file and free disk space.
 */
export function checkpoint(): void {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Non-critical — auto-checkpoint will handle it
    }
  }
}

/**
 * Reset the singleton for testing. Closes the DB and clears the cached reference.
 * WARNING: Only use in test environments — production code should never call this.
 */
export function _resetForTesting(): void {
  if (db) {
    try { db.close(); } catch {}
  }
  db = null;
  storedPath = null;
}

export function closeDb(): void {
  if (db) {
    const ref = db;
    db = null; // Clear reference first to prevent use-after-close
    storedPath = null; // Reset so next getDb() can accept a new path
    try {
      ref.pragma("wal_checkpoint(PASSIVE)");
    } catch {}
    try {
      ref.close();
    } catch {}
  }
}
