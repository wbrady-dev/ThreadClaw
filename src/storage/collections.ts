import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";

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

  return getCollection(db, id)!;
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
  db.transaction(() => {
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
      const placeholders = chunkIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id IN (${placeholders})`).run(...chunkIds);
    }
    // Cascading deletes handle chunks, metadata_index; FTS triggers handle chunk_fts
    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  })();

  return { chunksDeleted: chunkIds.length };
}

export function resetKnowledgeBase(db: Database.Database): { collectionsDeleted: number; documentsDeleted: number; chunksDeleted: number } {
  // Count before deletion for stats
  const docCount = (db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number }).n;
  const chunkCount = (db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }).n;
  const collCount = (db.prepare("SELECT COUNT(*) as n FROM collections").get() as { n: number }).n;

  // Drop and recreate virtual tables to fully reclaim shadow table space
  const dim = config.embedding.dimensions;
  try { db.exec("DROP TABLE IF EXISTS chunk_vectors"); } catch {}
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    )`);
  } catch {}

  // Delete all collections (cascades: documents, chunks, metadata_index, watch_paths; triggers: chunk_fts)
  db.prepare("DELETE FROM collections").run();

  // Rebuild FTS index to clear shadow table bloat
  try { db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')"); } catch {}

  // Compact database file
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.exec("VACUUM"); } catch {}

  return { collectionsDeleted: collCount, documentsDeleted: docCount, chunksDeleted: chunkCount };
}

export function ensureCollection(
  db: Database.Database,
  name: string,
): Collection {
  const existing = getCollectionByName(db, name);
  if (existing) return existing;
  return createCollection(db, name);
}
