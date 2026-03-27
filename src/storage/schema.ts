import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const SCHEMA_VERSION = 5;

function getMigrationStatements(): Record<number, string[]> {
  // NOTE: Embedding dimension is baked at migration time. If the dimension changes
  // (e.g., switching embedding models), the chunk_vectors table must be recreated.
  // A startup validation check should verify that the configured dimension matches
  // the existing vec0 table dimension.
  const dim = config.embedding.dimensions;

  return {
    // NOTE: Migration 1 uses IF NOT EXISTS which is partially redundant with the
    // migration versioning system. It's kept for safety during initial DB creation
    // when the _migrations table doesn't yet exist.
    1: [
      `CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        source_path TEXT,
        content_hash TEXT NOT NULL,
        metadata_json TEXT,
        size_bytes INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        context_prefix TEXT,
        position INTEGER,
        token_count INTEGER,
        content_hash TEXT NOT NULL
      )`,

      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${dim}]
      )`,

      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      )`,

      `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
      END`,

      `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END`,

      `CREATE TABLE IF NOT EXISTS metadata_index (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL
      )`,

      `CREATE INDEX IF NOT EXISTS idx_metadata ON metadata_index(key, value)`,
      `CREATE INDEX IF NOT EXISTS idx_doc_collection ON documents(collection_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chunk_document ON chunks(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_doc_hash ON documents(content_hash)`,

      `CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )`,
    ],

    2: [
      // Parent-child retrieval: link child chunks to parent sections
      `ALTER TABLE chunks ADD COLUMN parent_id TEXT REFERENCES chunks(id)`,

      // Incremental indexing: track file modification time
      `ALTER TABLE documents ADD COLUMN file_mtime TEXT`,

      // Track source path uniqueness per collection for re-indexing
      `CREATE INDEX IF NOT EXISTS idx_doc_source ON documents(source_path, collection_id)`,

      // Watch paths: reserved for DB-backed watch config (currently uses .env WATCH_PATHS)
      `CREATE TABLE IF NOT EXISTS watch_paths (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        tags_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    ],

    3: [
      // Enforce unique collection names (existing duplicates must be resolved manually)
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_name ON collections(name)`,
    ],

    4: [
      // FTS5 content-sync UPDATE trigger (future-proofing — chunks are currently never updated in-place)
      // NOTE: There is no UPDATE trigger gap in practice because chunks are delete+reinsert,
      // not updated in-place. If chunk text UPDATE is ever added, this trigger handles FTS sync.
      `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
      END`,
    ],

    5: [
      `CREATE INDEX IF NOT EXISTS idx_metadata_doc ON metadata_index(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_watch_paths_collection ON watch_paths(collection_id)`,
    ],
  };
}

export function runMigrations(db: Database.Database): void {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
    )
    .get();

  let currentVersion = 0;
  if (tableExists) {
    const row = db
      .prepare("SELECT MAX(version) as v FROM _migrations")
      .get() as { v: number | null };
    currentVersion = row?.v ?? 0;
  }

  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  const MIGRATIONS = getMigrationStatements();

  const migrate = db.transaction(() => {
    for (
      let version = currentVersion + 1;
      version <= SCHEMA_VERSION;
      version++
    ) {
      const statements = MIGRATIONS[version];
      if (!statements) continue;

      for (const sql of statements) {
        try {
          db.exec(sql);
        } catch (err) {
          // ALTER TABLE may fail if column already exists — safe to ignore.
          // NOTE: This suppresses all errors containing "duplicate column", which is
          // intentionally broad to handle both SQLite's exact message and edge cases.
          // Other errors (syntax, constraint) are re-thrown.
          const msg = String(err);
          if (!msg.includes("duplicate column")) throw err;
        }
      }

      db.prepare(
        "INSERT OR REPLACE INTO _migrations (version) VALUES (?)",
      ).run(version);
    }
  });

  migrate();
  logger.info(
    { from: currentVersion, to: SCHEMA_VERSION },
    "Database migrations applied",
  );
}
