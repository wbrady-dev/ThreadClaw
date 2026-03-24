import type { VectorSearchResult } from "../storage/vectors.js";
import type { BM25SearchResult } from "../storage/bm25.js";
import { config } from "../config.js";

export interface HybridResult {
  chunkId: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from different retrieval methods.
 * score = sum(weight / (k + rank)) across all lists for each chunk.
 * k=60 is the standard constant (robust to different list sizes).
 */
export function reciprocalRankFusion(
  vectorResults: VectorSearchResult[],
  bm25Results: BM25SearchResult[],
  k = config.query.hybridRrfK,
): HybridResult[] {
  const scores = new Map<string, number>();
  const vectorWeight = config.query.hybridVectorWeight;
  const bm25Weight = config.query.hybridBm25Weight;

  // Cap lists to balanced lengths — prevents one source from dominating via volume
  const maxLen = Math.min(Math.max(vectorResults.length, bm25Results.length), 100);
  const vecCapped = vectorResults.slice(0, maxLen);
  const bm25Capped = bm25Results.slice(0, maxLen);

  // Score vector results
  for (let rank = 0; rank < vecCapped.length; rank++) {
    const id = vecCapped[rank].chunkId;
    scores.set(id, (scores.get(id) ?? 0) + vectorWeight / (k + rank + 1));
  }

  // Score BM25 results
  for (let rank = 0; rank < bm25Capped.length; rank++) {
    const id = bm25Capped[rank].chunkId;
    scores.set(id, (scores.get(id) ?? 0) + bm25Weight / (k + rank + 1));
  }

  // Sort by fused score descending
  return Array.from(scores.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score);
}
