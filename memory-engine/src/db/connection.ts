import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

type ConnectionEntry = {
  db: DatabaseSync;
  refs: number;
};

const _connections = new Map<string, ConnectionEntry>();

function isConnectionHealthy(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function forceCloseConnection(entry: ConnectionEntry): void {
  try {
    entry.db.close();
  } catch {
    // Ignore close failures; caller is already replacing/removing this handle.
  }
}

export function getLcmConnection(dbPath: string, busyTimeoutMs = 5000): DatabaseSync {
  const existing = _connections.get(dbPath);
  if (existing) {
    if (isConnectionHealthy(existing.db)) {
      existing.refs += 1;
      return existing.db;
    }
    forceCloseConnection(existing);
    _connections.delete(dbPath);
  }

  // Ensure parent directory exists (skip for in-memory databases)
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  // Enable foreign key enforcement
  db.exec("PRAGMA foreign_keys = ON");
  // Retry on SQLITE_BUSY (configurable via THREADCLAW_MEMORY_BUSY_TIMEOUT_MS)
  db.exec(`PRAGMA busy_timeout = ${Math.floor(busyTimeoutMs)}`);

  _connections.set(dbPath, { db, refs: 1 });
  return db;
}

export function closeLcmConnection(dbPath?: string): void {
  if (typeof dbPath === "string" && dbPath.trim()) {
    const entry = _connections.get(dbPath);
    if (!entry) {
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      forceCloseConnection(entry);
      _connections.delete(dbPath);
    }
    return;
  }

  for (const entry of _connections.values()) {
    forceCloseConnection(entry);
  }
  _connections.clear();
}
