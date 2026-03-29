import type Database from "better-sqlite3";
import { config } from "../config.js";

export interface VectorSearchResult {
  chunkId: string;
  distance: number;
}

/** @deprecated Pipeline inserts vectors inline in a transaction. Use direct SQL instead. */
export function insertVector(
  db: Database.Database,
  chunkId: string,
  embedding: number[],
): void {
  const stmt = db.prepare(
    "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)",
  );
  stmt.run(chunkId, new Float32Array(embedding));
}

/** Maximum number of variables per SQLite statement (conservative limit) */
const SQLITE_BATCH_SIZE = 500;

export function searchVectors(
  db: Database.Database,
  queryEmbedding: number[],
  topK: number,
  collectionId?: string,
): VectorSearchResult[] {
  const embeddingBuf = new Float32Array(queryEmbedding);

  if (collectionId) {
    // sqlite-vec requires k=? in WHERE, can't JOIN on vec0 directly.
    // Over-retrieve then batch-filter by collection in a single query.
    const overRetrieve = topK * config.query.vectorOverRetrieveFactor;
    const stmt = db.prepare(`
      SELECT chunk_id as chunkId, distance
      FROM chunk_vectors
      WHERE embedding MATCH ?
        AND k = ?
    `);
    const allResults = stmt.all(embeddingBuf, overRetrieve) as VectorSearchResult[];

    if (allResults.length === 0) return [];

    // Batch filter: split into groups of SQLITE_BATCH_SIZE to avoid SQLite variable limit
    const validIds = new Set<string>();
    for (let i = 0; i < allResults.length; i += SQLITE_BATCH_SIZE) {
      const batch = allResults.slice(i, i + SQLITE_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT c.id FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.id IN (${placeholders}) AND d.collection_id = ?
      `).all(...batch.map((r) => r.chunkId), collectionId) as { id: string }[];
      for (const r of rows) validIds.add(r.id);
    }

    const filtered: VectorSearchResult[] = [];
    for (const r of allResults) {
      if (filtered.length >= topK) break;
      if (validIds.has(r.chunkId)) filtered.push(r);
    }
    return filtered;
  }

  const stmt = db.prepare(`
    SELECT chunk_id as chunkId, distance
    FROM chunk_vectors
    WHERE embedding MATCH ?
      AND k = ?
  `);
  return stmt.all(embeddingBuf, topK) as VectorSearchResult[];
}

export function deleteVectors(
  db: Database.Database,
  chunkIds: string[],
): void {
  // NOTE: Individual DELETE in a loop because sqlite-vec virtual tables don't support
  // bulk DELETE with IN clauses. The transaction wrapper keeps it efficient.
  const stmt = db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
  const deleteMany = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  deleteMany(chunkIds);
}
