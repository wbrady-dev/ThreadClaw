import { resolve } from "path";
import type Database from "better-sqlite3";

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { trackTokens } from "../utils/token-tracker.js";
import { estimateTokens } from "../utils/format.js";
import { getDb, searchVectors, getCollectionByName, listCollections } from "../storage/index.js";
import { searchBm25 } from "../storage/bm25.js";
import { embed, embedQuery } from "../embeddings/client.js";
import { reciprocalRankFusion } from "./hybrid.js";
import { rerank } from "./rerank.js";
import { packContext, packTitles, type PackedChunk } from "./packer.js";
import { extractBrief, type BriefInput } from "./brief.js";
import { cacheKey, getCached, setCached } from "./cache.js";
import { recordQuery } from "../api/analytics.routes.js";
import {
  isExpansionEnabled,
  decomposeQuery,
  generateHyDE,
  generateMultiQuery,
} from "./expansion.js";
import { getGraphDb } from "../storage/graph-sqlite.js";

export interface QueryOptions {
  collection?: string;
  topK?: number;
  tokenBudget?: number;
  useReranker?: boolean;
  useBm25?: boolean;
  expand?: boolean;
  includeParentContext?: boolean;
  /** Return compressed brief instead of full chunks */
  brief?: boolean;
  /** Return only document titles/sources, no content */
  titlesOnly?: boolean;
}

export interface SourceInfo {
  source: string;
  chunkCount: number;
  avgScore: number;
  collection?: string;
}

export interface QueryResult {
  context: string;
  /** Context with matched query terms highlighted in markdown bold (brief mode only) */
  highlighted?: string;
  sources: SourceInfo[];
  queryInfo: {
    strategy: string;
    subQueries?: string[];
    candidatesEvaluated: number;
    chunksReturned: number;
    tokensUsed: number;
    elapsedMs: number;
    collections: string[];
    confidence: number;
    cached?: boolean;
    lowConfidence?: boolean;
    /** Retrieval breakdown for diagnostics */
    retrieval?: {
      vectorHits: number;
      vectorGated: number;
      bm25Hits: number;
      bestDistance: number;
      reranked: boolean;
    };
  };
}

// Similarity threshold from config (L2 distance: lower = more similar).
// Default 1.05 keeps only strong+moderate matches for the reranker.
const getVectorDistanceThreshold = () => config.embedding.similarityThreshold;

/**
 * Token-efficient query pipeline:
 *
 * 1. Cache check (instant return on hit)
 * 2. Optional query expansion
 * 3. Hybrid retrieval (dense + BM25 + RRF)
 * 4. Similarity threshold gate (drop weak results)
 * 5. Smart reranking (skip when top result dominates)
 * 6. Single-source dedup (in brief mode)
 * 7. Output mode: brief (200 tokens) / titles (30 tokens) / full (original)
 */
/** Max query length to prevent abuse / excessive embedding cost */
const MAX_QUERY_LENGTH = 2000;

export async function query(
  queryText: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const start = Date.now();

  // === Input validation ===
  const trimmed = queryText.trim();
  if (!trimmed) {
    return emptyResult("", "rejected:empty", [], start);
  }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    queryText = trimmed.slice(0, MAX_QUERY_LENGTH);
  } else {
    queryText = trimmed;
  }

  const collectionName = options.collection ?? config.defaults.collection;
  const topK = Math.min(options.topK ?? config.defaults.queryTopK, 100);
  const tokenBudget = Math.min(options.tokenBudget ?? config.defaults.queryTokenBudget, 50000);
  const useReranker = (options.useReranker ?? true) && !config.reranker.disabled;
  const useBm25 = options.useBm25 ?? true;
  const includeParent = options.includeParentContext !== false && !options.brief; // skip parent in brief mode
  const doExpand = options.expand ?? isExpansionEnabled();
  const brief = options.brief ?? false;
  const titlesOnly = options.titlesOnly ?? false;

  // === Cache Check ===
  const ck = cacheKey(queryText, collectionName, { topK, brief, titlesOnly, useReranker, useBm25, doExpand, tokenBudget });
  const cached = getCached<QueryResult>(ck);
  if (cached) {
    return { ...cached, queryInfo: { ...cached.queryInfo, cached: true, elapsedMs: Date.now() - start } };
  }

  // Get DB (migrations run once at server startup in server.ts)
  const dbPath = resolve(config.dataDir, "clawcore.db");
  const db = getDb(dbPath);

  // Determine collections — don't auto-create on queries
  const searchCollections: string[] = [];
  const allCollections = collectionName === "all" ? listCollections(db) : null;
  if (allCollections) {
    for (const c of allCollections) searchCollections.push(c.id);
  } else {
    const existing = getCollectionByName(db, collectionName);
    if (!existing) {
      return emptyResult(queryText, "collection-not-found", [collectionName], start);
    }
    searchCollections.push(existing.id);
  }

  const collectionNames = allCollections
    ? allCollections.map((c) => c.name)
    : [collectionName];

  const retrieveCount = topK * 2;
  let strategy = "dense";

  // === Query Expansion (optional) ===
  let allQueryEmbeddings: number[][] = [];
  let allQueryTexts: string[] = [queryText];
  let subQueries: string[] | undefined;

  if (doExpand) {
    const [decomposed, hydeText, variants] = await Promise.all([
      decomposeQuery(queryText),
      generateHyDE(queryText),
      generateMultiQuery(queryText),
    ]);
    subQueries = decomposed.length > 1 ? decomposed : undefined;
    allQueryTexts = [...new Set([queryText, ...decomposed, ...variants])];

    // Parallelize query embeddings + HyDE embedding in a single Promise.all
    if (hydeText) {
      const [queryEmbeddings, hydeEmbeddings] = await Promise.all([
        embed(allQueryTexts, "query"),
        embed([hydeText], "passage"),
      ]);
      allQueryEmbeddings = [...queryEmbeddings, hydeEmbeddings[0]];
      strategy = "expanded+hyde";
    } else {
      allQueryEmbeddings = await embed(allQueryTexts, "query");
      strategy = "expanded";
    }
    // Track expansion tokens (all generated query variants)
    const expansionTokens = allQueryTexts.reduce((s, q) => s + estimateTokens(q), 0);
    trackTokens("queryExpansion", expansionTokens);
  } else {
    allQueryEmbeddings = [await embedQuery(queryText)];
  }
  // Track embed tokens for the query itself
  trackTokens("embed", estimateTokens(queryText));

  // === Retrieve ===
  const allVectorResults = [];
  const allBm25Results = [];

  // Entity-boosted BM25: for short queries (1-2 words), expand with
  // co-occurring terms from the entity graph (precision guard).
  let entityBoostedQuery = queryText;
  if (config.relations.enabled) {
    const wordCount = queryText.trim().split(/\s+/).length;
    if (wordCount <= 2) {
      try {
        const graphDb = getGraphDb(config.relations.graphDbPath);
        const lowerQuery = queryText.toLowerCase().trim();
        const entity = graphDb.prepare(
          "SELECT id FROM entities WHERE name = ? AND mention_count >= 2",
        ).get(lowerQuery) as { id: number } | undefined;
        if (entity) {
          const mentions = graphDb.prepare(
            "SELECT context_terms FROM entity_mentions WHERE entity_id = ? AND context_terms IS NOT NULL AND context_terms != '[]' LIMIT 5",
          ).all(entity.id) as Array<{ context_terms: string }>;
          const coTerms = new Set<string>();
          for (const m of mentions) {
            try {
              const terms = JSON.parse(m.context_terms) as string[];
              for (const t of terms) {
                if (t.toLowerCase() !== lowerQuery) coTerms.add(t);
              }
            } catch { /* skip bad JSON */ }
          }
          if (coTerms.size > 0) {
            entityBoostedQuery = `${queryText} ${[...coTerms].slice(0, 3).join(" ")}`;
            strategy += "+entity_boost";
          }
        }
      } catch {
        // Non-fatal: entity boost failure doesn't block search
      }
    }
  }

  for (const collId of searchCollections) {
    for (const emb of allQueryEmbeddings) {
      try {
        allVectorResults.push(...searchVectors(db, emb, retrieveCount, collId));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Vector search failed, continuing with BM25");
      }
    }
    // BM25 on original query (or entity-boosted for short queries).
    // Running BM25 on all variants adds noise without meaningful recall gain.
    if (useBm25) {
      try {
        allBm25Results.push(...searchBm25(db, entityBoostedQuery, retrieveCount, collId));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "BM25 search failed");
      }
    }
  }

  // === Similarity Threshold Gate ===
  // Filter out results with poor vector distance (likely irrelevant)
  const goodVectorResults = allVectorResults.filter((r) => r.distance < getVectorDistanceThreshold());

  // === Hybrid Merge ===
  let candidateChunkIds: string[];
  if (allBm25Results.length > 0) {
    const hybrid = reciprocalRankFusion(
      goodVectorResults,
      allBm25Results,
    );
    candidateChunkIds = hybrid.slice(0, retrieveCount).map((r) => r.chunkId);
    strategy += "+hybrid";
  } else {
    const seen = new Set<string>();
    candidateChunkIds = [];
    const source = goodVectorResults;
    for (const r of source) {
      if (!seen.has(r.chunkId)) {
        seen.add(r.chunkId);
        candidateChunkIds.push(r.chunkId);
      }
    }
    candidateChunkIds = candidateChunkIds.slice(0, retrieveCount);
  }

  if (candidateChunkIds.length === 0) {
    const result = emptyResult(queryText, strategy, collectionNames, start);
    setCached(ck, result);
    return result;
  }

  // === Fetch Chunks ===
  let chunkData = fetchChunks(db, candidateChunkIds);

  // Parent-child enrichment (skip in brief/titles mode — saves tokens)
  if (includeParent && !brief && !titlesOnly) {
    chunkData = enrichWithParentContext(db, chunkData);
  }

  // === Titles-Only Mode ===
  if (titlesOnly) {
    const titles = packTitles(chunkData);
    const result: QueryResult = {
      context: titles.text,
      sources: titles.sources,
      queryInfo: {
        strategy: strategy + "+titles",
        candidatesEvaluated: candidateChunkIds.length,
        chunksReturned: titles.sources.length,
        tokensUsed: titles.tokenCount,
        elapsedMs: Date.now() - start,
        collections: collectionNames,
        confidence: 0.5,
      },
    };
    setCached(ck, result);
    return result;
  }

  // === Smart Reranking ===
  let rankedChunks: PackedChunk[];
  const noGoodVectors = goodVectorResults.length === 0;
  const shouldSkipRerank = useReranker && config.reranker.smartSkip && chunkData.length >= 2 && shouldSkipReranking(allVectorResults);

  if (useReranker && chunkData.length > 0 && !shouldSkipRerank && !noGoodVectors) {
    // Include contextPrefix (heading chain) so reranker sees same context as embedder
    const rerankCandidateCount = Math.min(chunkData.length, config.reranker.topK);
    const rerankTexts = chunkData.slice(0, rerankCandidateCount).map((c) =>
      c.contextPrefix ? `${c.contextPrefix}\n\n${c.text}` : c.text,
    );
    const rerankResults = await rerank(queryText, rerankTexts, topK * 2);
    const scoreThreshold = config.reranker.scoreThreshold;
    rankedChunks = rerankResults
      .filter((r) => r.index >= 0 && r.index < chunkData.length && r.score >= scoreThreshold)
      .map((r) => ({
        chunkId: chunkData[r.index].id,
        text: chunkData[r.index].text,
        contextPrefix: chunkData[r.index].contextPrefix ?? undefined,
        sourcePath: chunkData[r.index].sourcePath ?? undefined,
        collectionName: chunkData[r.index].collectionName ?? undefined,
        score: r.score,
      }));
    strategy += "+rerank";
    // Track rerank tokens (query + all candidate texts)
    const rerankTokens = estimateTokens(queryText) + chunkData.reduce((s, c) => s + estimateTokens(c.text), 0);
    trackTokens("rerank", rerankTokens);
  } else {
    rankedChunks = chunkData.map((c, i) => ({
      chunkId: c.id,
      text: c.text,
      contextPrefix: c.contextPrefix ?? undefined,
      sourcePath: c.sourcePath ?? undefined,
      collectionName: c.collectionName ?? undefined,
      score: 1 - i / chunkData.length,
    }));
    if (shouldSkipRerank) strategy += "+skip-rerank";
  }

  // === Single-Source Dedup (brief mode) ===
  let topChunks = rankedChunks.slice(0, topK);
  if (brief) {
    topChunks = dedupBySources(topChunks);
  }

  // === Confidence ===
  const bestDistance = allVectorResults.length > 0
    ? Math.min(...allVectorResults.map((r) => r.distance))
    : undefined;
  const confidence = computeConfidence(topChunks, bestDistance);

  // === Output Mode ===
  let context: string;
  let highlighted: string | undefined;
  let tokensUsed: number;
  let chunksReturned: number;
  let sources: SourceInfo[];

  if (brief) {
    // Brief: extract relevant sentences, ~200 tokens
    const briefInput: BriefInput[] = topChunks.map((c) => ({
      text: c.text,
      sourcePath: c.sourcePath,
      collectionName: c.collectionName,
      score: c.score,
    }));
    const briefResult = extractBrief(queryText, briefInput, tokenBudget);
    context = briefResult.text;
    highlighted = briefResult.highlighted;
    tokensUsed = briefResult.tokenCount;
    chunksReturned = topChunks.length;
    sources = briefResult.sources.map((s) => ({
      source: s,
      chunkCount: 1,
      avgScore: topChunks[0]?.score ?? 0,
      collection: collectionName,
    }));
    strategy += "+brief";
  } else {
    // Full: rich citations with source attribution
    const packed = packContext(topChunks, tokenBudget);
    context = packed.context;
    tokensUsed = packed.tokensUsed;
    chunksReturned = packed.chunksUsed;
    sources = packed.sources.map((s) => ({ ...s, collection: collectionName }));
  }

  const elapsed = Date.now() - start;
  const lowConfidence = confidence < 0.3 && chunksReturned > 0;

  logger.info({
    query: queryText,
    strategy,
    candidates: candidateChunkIds.length,
    returned: chunksReturned,
    tokens: tokensUsed,
    confidence: Math.round(confidence * 100),
    elapsedMs: elapsed,
  }, "Query complete");

  const result: QueryResult = {
    context,
    highlighted,
    sources,
    queryInfo: {
      strategy,
      subQueries,
      candidatesEvaluated: candidateChunkIds.length,
      chunksReturned,
      tokensUsed,
      elapsedMs: elapsed,
      collections: collectionNames,
      confidence,
      lowConfidence,
      retrieval: {
        vectorHits: allVectorResults.length,
        vectorGated: allVectorResults.length - goodVectorResults.length,
        bm25Hits: allBm25Results.length,
        bestDistance: Math.round((bestDistance ?? 0) * 1000) / 1000,
        reranked: strategy.includes("rerank") && !strategy.includes("skip-rerank"),
      },
    },
  };

  setCached(ck, result);

  // Record analytics
  recordQuery({
    timestamp: Date.now(),
    query: queryText,
    collection: collectionName,
    strategy,
    elapsedMs: elapsed,
    candidates: candidateChunkIds.length,
    chunksReturned,
    confidence,
    cached: false,
    vectorHits: allVectorResults.length,
    bm25Hits: allBm25Results.length,
    bestDistance: Math.round((bestDistance ?? 0) * 1000) / 1000,
    reranked: strategy.includes("rerank") && !strategy.includes("skip-rerank"),
  });

  return result;
}

// === Helpers ===

function emptyResult(q: string, strategy: string, collections: string[], start: number): QueryResult {
  return {
    context: "No relevant documents found.",
    sources: [],
    queryInfo: { strategy, candidatesEvaluated: 0, chunksReturned: 0, tokensUsed: 5, elapsedMs: Date.now() - start, collections, confidence: 0 },
  };
}

/**
 * Should we skip the cross-encoder reranker?
 * Yes if: top result has good absolute quality AND clear separation from #2.
 */
function shouldSkipReranking(vectorResults: { distance: number }[]): boolean {
  if (vectorResults.length < 2) return false;

  const sorted = [...vectorResults].sort((a, b) => a.distance - b.distance);
  const top = sorted[0].distance;
  const second = sorted[1].distance;

  // Minimum quality gate: top result must be genuinely close (low distance)
  if (top > 0.8) return false;

  // Perfect match — no need to rerank
  if (top === 0) return true;

  // Clear separation: second result is at least 2x further
  return second / top > 2;
}

/**
 * Dedup by source — keep only the best-scoring chunk per source document.
 */
function dedupBySources(chunks: PackedChunk[]): PackedChunk[] {
  const bySource = new Map<string, PackedChunk>();
  for (const chunk of chunks) {
    const src = chunk.sourcePath ?? "unknown";
    if (!bySource.has(src) || chunk.score > (bySource.get(src)!.score)) {
      bySource.set(src, chunk);
    }
  }
  return Array.from(bySource.values());
}

function computeConfidence(chunks: PackedChunk[], bestDistance?: number): number {
  if (chunks.length === 0) return 0;

  // Absolute quality factor from best vector distance (L2: lower = better)
  const distFactor = bestDistance != null
    ? (bestDistance < 0.5 ? 0.8 : bestDistance < 0.8 ? 0.5 : bestDistance < 1.0 ? 0.3 : 0.1)
    : 0.5;

  if (chunks.length === 1) return distFactor;

  // Relative spread-based confidence
  const scores = chunks.map((c) => c.score).sort((a, b) => b - a);
  const separation = scores[0] - (scores[1] ?? 0);
  const spread = scores[0] - scores[scores.length - 1];
  const ratio = spread > 0 ? separation / spread : 0;

  let spreadConf = 0.3;
  spreadConf += ratio * 0.4;
  if (spread > 0.01) spreadConf += 0.1;
  if (spread > 0.05) spreadConf += 0.1;
  if (chunks.length >= 3) spreadConf += 0.1;
  spreadConf = Math.min(1, Math.max(0, spreadConf));

  // Blend absolute quality with relative ranking
  return Math.min(1, 0.5 * distFactor + 0.5 * spreadConf);
}

interface ChunkRow {
  id: string;
  text: string;
  contextPrefix: string | null;
  sourcePath: string | null;
  collectionName: string | null;
  documentId: string;
  position: number;
}

function fetchChunks(db: Database.Database, chunkIds: string[]): ChunkRow[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT c.id, c.text, c.context_prefix as contextPrefix,
            d.source_path as sourcePath, col.name as collectionName,
            c.document_id as documentId, c.position
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN collections col ON col.id = d.collection_id
     WHERE c.id IN (${placeholders})`,
  ).all(...chunkIds) as ChunkRow[];
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return chunkIds.map((id) => rowMap.get(id)!).filter(Boolean);
}

function enrichWithParentContext(db: Database.Database, chunks: ChunkRow[]): ChunkRow[] {
  if (chunks.length === 0) return [];

  // Batch load: fetch all chunks from relevant documents in one query (avoids N+1)
  const validChunks = chunks.filter((c) => c.documentId && c.position != null);
  const docIds = [...new Set(validChunks.map((c) => c.documentId))];

  const neighborMap = new Map<string, Map<number, { id: string; text: string; contextPrefix: string | null; position: number }>>();

  if (docIds.length > 0) {
    try {
      const placeholders = docIds.map(() => "?").join(",");
      const allDocChunks = db.prepare(
        `SELECT document_id, id, text, context_prefix as contextPrefix, position FROM chunks
         WHERE document_id IN (${placeholders}) ORDER BY document_id, position`,
      ).all(...docIds) as { document_id: string; id: string; text: string; contextPrefix: string | null; position: number }[];

      for (const c of allDocChunks) {
        if (!neighborMap.has(c.document_id)) neighborMap.set(c.document_id, new Map());
        neighborMap.get(c.document_id)!.set(c.position, c);
      }
    } catch {
      // Fall back to returning chunks as-is
      return chunks;
    }
  }

  const enriched: ChunkRow[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);

    if (!chunk.documentId || chunk.position == null) {
      enriched.push(chunk);
      continue;
    }

    const docChunks = neighborMap.get(chunk.documentId);
    if (!docChunks) {
      enriched.push(chunk);
      continue;
    }

    // Gather neighbors (position - 1, position, position + 1)
    const neighbors: { id: string; text: string }[] = [];
    for (let p = Math.max(0, chunk.position - 1); p <= chunk.position + 1; p++) {
      const n = docChunks.get(p);
      if (n) neighbors.push(n);
    }

    if (neighbors.length > 1) {
      enriched.push({ ...chunk, text: neighbors.map((n) => n.text).join("\n\n") });
      for (const n of neighbors) seen.add(n.id);
    } else {
      enriched.push(chunk);
    }
  }
  return enriched;
}
