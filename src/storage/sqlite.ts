import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { logger } from "../utils/logger.js";

let db: Database.Database | null = null;
let storedPath: string | null = null;

export function getDb(dbPath: string): Database.Database {
  const normalized = resolve(dbPath);
  if (db) {
    if (storedPath && storedPath !== normalized) {
      throw new Error(
        `getDb called with path "${normalized}" but already connected to "${storedPath}". ` +
        `ThreadClaw uses a singleton DB connection — cannot open two databases.`,
      );
    }
    return db;
  }
  storedPath = normalized;

  mkdirSync(dirname(normalized), { recursive: true });

  db = new Database(normalized);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Checkpoint WAL every 1000 pages (~4MB) to prevent unbounded growth
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
    try {
      ref.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    try {
      ref.close();
    } catch {}
  }
}
