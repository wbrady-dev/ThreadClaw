import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getGraphDb } from "./graph-sqlite.js";
import { deleteSourceData } from "../relations/ingest-hook.js";

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface CollectionStats {
  id: string;
  name: string;
  documentCount: number;
  chunkCount: number;
  totalTokens: number;
  lastUpdated: string | null;
}

export function createCollection(
  db: Database.Database,
  name: string,
  description?: string,
): Collection {
  const id = uuidv4();
  db.prepare(
    "INSERT INTO collections (id, name, description) VALUES (?, ?, ?)",
  ).run(id, name, description ?? null);

  const result = getCollection(db, id);
  if (!result) throw new Error(`Failed to create collection '${name}' — row not found after insert`);
  return result;
}

export function getCollection(
  db: Database.Database,
  id: string,
): Collection | null {
  return (
    (db
      .prepare("SELECT * FROM collections WHERE id = ?")
      .get(id) as Collection) ?? null
  );
}

export function getCollectionByName(
  db: Database.Database,
  name: string,
): Collection | null {
  return (
    (db
      .prepare("SELECT * FROM collections WHERE name = ?")
      .get(name) as Collection) ?? null
  );
}

export function listCollections(db: Database.Database): Collection[] {
  return db
    .prepare("SELECT * FROM collections ORDER BY created_at")
    .all() as Collection[];
}

export function deleteCollection(db: Database.Database, id: string): void {
  // Gather document IDs inside transaction to avoid race with concurrent inserts
  const docIds: string[] = [];

  db.transaction(() => {
    const rows = db.prepare("SELECT id FROM documents WHERE collection_id = ?").all(id) as { id: string }[];
    for (const r of rows) docIds.push(r.id);

    // Delete vectors for chunks in this collection
    db.prepare(
      `DELETE FROM chunk_vectors WHERE chunk_id IN (
        SELECT c.id FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.collection_id = ?
      )`,
    ).run(id);

    // Cascading deletes handle documents -> chunks -> metadata_index
    db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  })();

  // Clean up graph data in batch (best-effort, outside transaction since it's a separate DB)
  try {
    if (config.relations?.enabled && config.relations?.graphDbPath && docIds.length > 0) {
      const graphDb = getGraphDb(config.relations.graphDbPath);
      // Batch delete: single DELETE with IN clause instead of N individual deletes
      const objectKeys = docIds.map((id) => `document:${id}`);
      const BATCH = 500;
      for (let i = 0; i < objectKeys.length; i += BATCH) {
        const batch = objectKeys.slice(i, i + BATCH);
        const placeholders = batch.map(() => "?").join(",");
        try {
          graphDb.prepare(
            `DELETE FROM provenance_links WHERE object_id IN (${placeholders}) AND predicate = 'mentioned_in'`,
          ).run(...batch);
        } catch {
          // Fallback: try individual deletes on batch failure
          for (const key of batch) {
            try {
              graphDb.prepare(
                "DELETE FROM provenance_links WHERE object_id = ? AND predicate = 'mentioned_in'",
              ).run(key);
            } catch {}
          }
        }
      }
    }
  } catch {} // Non-fatal — graph cleanup is best-effort
}

export function getCollectionStats(
  db: Database.Database,
  id: string,
): CollectionStats | null {
  const collection = getCollection(db, id);
  if (!collection) return null;

  const stats = db
    .prepare(
      `
    SELECT
      COUNT(DISTINCT d.id) as documentCount,
      COUNT(c.id) as chunkCount,
      COALESCE(SUM(c.token_count), 0) as totalTokens,
      MAX(d.created_at) as lastUpdated
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    WHERE d.collection_id = ?
  `,
    )
    .get(id) as {
    documentCount: number;
    chunkCount: number;
    totalTokens: number;
    lastUpdated: string | null;
  };

  return {
    id: collection.id,
    name: collection.name,
    ...stats,
  };
}

export interface DocumentInfo {
  id: string;
  source_path: string;
  collection_id: string;
  collection: string;
  size_bytes: number;
  chunk_count: number;
  created_at: string;
}

export function listDocuments(
  db: Database.Database,
  collectionId?: string,
): DocumentInfo[] {
  // NOTE: Conditional SQL string concatenation is safe here because collectionId
  // is used as a parameterized bind value, not interpolated into the query string.
  const sql = `
    SELECT d.id, d.source_path, d.collection_id, c.name as collection,
           d.size_bytes, COUNT(ch.id) as chunk_count, d.created_at
    FROM documents d
    JOIN collections c ON c.id = d.collection_id
    LEFT JOIN chunks ch ON ch.document_id = d.id
    ${collectionId ? "WHERE d.collection_id = ?" : ""}
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `;
  return collectionId
    ? (db.prepare(sql).all(collectionId) as DocumentInfo[])
    : (db.prepare(sql).all() as DocumentInfo[]);
}

export function deleteDocument(db: Database.Database, documentId: string): { chunksDeleted: number } {
  const chunks = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as { id: string }[];
  const chunkIds = chunks.map((c) => c.id);

  // Atomic: delete vectors + document in a single transaction
  db.transaction(() => {
    if (chunkIds.length > 0) {
      // Use subquery instead of spread operator to avoid SQLite variable limit
      db.prepare(
        `DELETE FROM chunk_vectors WHERE chunk_id IN (
          SELECT id FROM chunks WHERE document_id = ?
        )`,
      ).run(documentId);
    }
    // Cascading deletes handle chunks, metadata_index; FTS triggers handle chunk_fts
    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  })();

  // Clean up graph data if relations enabled
  // Retry once to avoid orphaned graph records on transient failures
  try {
    if (config.relations?.enabled && config.relations?.graphDbPath) {
      const graphDb = getGraphDb(config.relations.graphDbPath);
      try {
        deleteSourceData(graphDb, "document", documentId);
      } catch (err) {
        // Retry once on transient failure
        try { deleteSourceData(graphDb, "document", documentId); } catch {}
      }
    }
  } catch {} // Non-fatal — graph cleanup is best-effort

  return { chunksDeleted: chunkIds.length };
}

export function resetKnowledgeBase(db: Database.Database): { collectionsDeleted: number; documentsDeleted: number; chunksDeleted: number } {
  // Count before deletion for stats
  const docCount = (db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number }).n;
  const chunkCount = (db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }).n;
  const collCount = (db.prepare("SELECT COUNT(*) as n FROM collections").get() as { n: number }).n;

  // Drop/recreate vectors + delete all data in a single transaction for crash safety
  const dim = config.embedding.dimensions;
  // Assertion: dim must be a positive integer to prevent SQL injection via string interpolation
  if (!Number.isInteger(dim) || dim <= 0 || dim > 10000) {
    throw new Error(`Invalid embedding dimension: ${dim}`);
  }
  db.transaction(() => {
    try { db.exec("DROP TABLE IF EXISTS chunk_vectors"); } catch (err) {
      logger.warn({ error: String(err) }, "resetKnowledgeBase: failed to drop chunk_vectors");
    }
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${dim}]
      )`);
    } catch (err) {
      logger.warn({ error: String(err) }, "resetKnowledgeBase: failed to recreate chunk_vectors");
    }

    // Delete all collections (cascades: documents, chunks, metadata_index, watch_paths; triggers: chunk_fts)
    db.prepare("DELETE FROM collections").run();

    // Rebuild FTS index to clear shadow table bloat
    try { db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')"); } catch (err) {
      logger.warn({ error: String(err) }, "resetKnowledgeBase: failed to rebuild FTS index");
    }
  })();

  // Compact database file (must be outside transaction — SQLite requirement)
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (err) {
    logger.warn({ error: String(err) }, "resetKnowledgeBase: WAL checkpoint failed");
  }
  try { db.exec("VACUUM"); } catch (err) {
    logger.warn({ error: String(err) }, "resetKnowledgeBase: VACUUM failed");
  }

  return { collectionsDeleted: collCount, documentsDeleted: docCount, chunksDeleted: chunkCount };
}

export function ensureCollection(
  db: Database.Database,
  name: string,
): Collection {
  // Atomic: INSERT OR IGNORE first, then SELECT.
  // No check-then-insert race — the INSERT is the single point of truth.
  // NOTE: A UUID is generated on every call but wasted when the collection already exists.
  // This is acceptable — UUID generation is cheap (~1us) vs the cost of a DB query.
  const id = uuidv4();
  db.prepare(
    "INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)",
  ).run(id, name);

  const result = getCollectionByName(db, name);
  if (!result) throw new Error(`Failed to ensure collection '${name}' — row not found after upsert`);
  return result;
}
