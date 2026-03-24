import type Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ── Semantic Deduplication ──

const SIMILARITY_THRESHOLD = config.extraction.dedupSimilarityThreshold;

/**
 * Find duplicate chunk indices within a batch of new embeddings.
 * Returns Set of indices that should be skipped (duplicates of earlier chunks).
 */
export function findIntraBatchDuplicates(embeddings: number[][]): Set<number> {
  if (embeddings.length < 2) return new Set();

  const MAX_PAIRWISE = config.extraction.dedupMaxPairwise;
  if (embeddings.length > MAX_PAIRWISE) {
    logger.warn(
      { count: embeddings.length, limit: MAX_PAIRWISE },
      "Batch too large for pairwise dedup — skipping intra-batch check",
    );
    return new Set();
  }

  const dupes = new Set<number>();
  for (let i = 1; i < embeddings.length; i++) {
    if (dupes.has(i)) continue;
    for (let j = 0; j < i; j++) {
      if (dupes.has(j)) continue;
      if (cosineSimilarity(embeddings[i], embeddings[j]) >= SIMILARITY_THRESHOLD) {
        dupes.add(i);
        break;
      }
    }
  }
  if (dupes.size > 0) {
    logger.info({ duplicates: dupes.size, total: embeddings.length }, "Intra-batch semantic duplicates removed");
  }
  return dupes;
}

/**
 * Check new embeddings against existing vectors in a collection.
 * Returns Set of indices that are duplicates of already-indexed content.
 *
 * Uses sqlite-vec nearest neighbor search. For normalized vectors:
 * cos_sim = 1 - (L2^2 / 2), so similarity >= 0.95 means L2 <= ~0.316
 */
export function findExistingDuplicates(
  db: Database.Database,
  embeddings: number[][],
  collectionId: string,
): Set<number> {
  const dupes = new Set<number>();
  const L2_THRESHOLD = 0.316; // corresponds to cosine similarity 0.95

  let stmt: ReturnType<Database.Database["prepare"]>;
  try {
    stmt = db.prepare(`
      SELECT chunk_id, distance
      FROM chunk_vectors
      WHERE embedding MATCH ?
        AND k = ?
    `);
  } catch (err) {
    // Vector index may not exist yet (empty DB) — this is expected
    const msg = String(err);
    if (!msg.includes("no such table") && !msg.includes("no such module")) {
      logger.warn({ error: msg }, "Unexpected error preparing dedup query");
    }
    return dupes;
  }

  const filterStmt = db.prepare(`
    SELECT 1 FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.id = ? AND d.collection_id = ?
  `);

  // Wrap in a transaction for better WAL lock efficiency (single lock acquisition)
  const scan = db.transaction(() => {
    for (let i = 0; i < embeddings.length; i++) {
      try {
        // Retrieve k=5 nearest neighbors to handle cross-collection near-duplicates
        // (the closest vector globally may be in a different collection)
        const results = (stmt as any).all(new Float32Array(embeddings[i]), 5) as
          Array<{ chunk_id: string; distance: number }>;

        for (const result of results) {
          if (result.distance <= L2_THRESHOLD) {
            if (filterStmt.get(result.chunk_id, collectionId)) {
              dupes.add(i);
              break;
            }
          } else break; // Results are distance-sorted — no point checking further
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no such table") && !msg.includes("no rows")) {
          logger.warn({ error: msg, chunkIndex: i }, "Unexpected error during semantic dedup");
        }
      }
    }
  });
  scan();

  if (dupes.size > 0) {
    logger.info({ duplicates: dupes.size, total: embeddings.length }, "Existing semantic duplicates found");
  }
  return dupes;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
