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
import { packContext, packTitles, type PackedChunk, type SourceInfo } from "./packer.js";
import { extractBrief, type BriefInput } from "./brief.js";
import { cacheKey, getCached, setCached } from "./cache.js";
import { recordQuery } from "../analytics/query-recorder.js";
import { emitPipelineEvent } from "../analytics/event-stream.js";
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
  /** Generate a synthesized answer from top chunks using an LLM */
  synthesize?: boolean;
}

export type { SourceInfo };

export interface QueryResult {
  context: string;
  /** Context with matched query terms highlighted in markdown bold */
  highlighted?: string;
  sources: SourceInfo[];
  /** LLM-synthesized answer (only when synthesize=true) */
  answer?: string;
  /** Source files cited in the synthesized answer */
  answerCitations?: string[];
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
 * 7. Output mode: brief (~250 tokens) / titles (~50 tokens) / full (original)
 */
/** Max query length to prevent abuse / excessive embedding cost */
const MAX_QUERY_LENGTH = config.query.maxLength;

export async function query(
  queryText: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const start = Date.now();

  // === Input validation ===
  const trimmed = queryText.trim();
  if (!trimmed) {
    const result = emptyResult("", "rejected:empty", [], start);
    recordQuery({
      timestamp: Date.now(), query: "", collection: options.collection ?? "",
      strategy: "rejected:empty", elapsedMs: Date.now() - start,
      candidates: 0, chunksReturned: 0, confidence: 0, cached: false,
      vectorHits: 0, bm25Hits: 0, bestDistance: 0, reranked: false,
    });
    return result;
  }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    queryText = trimmed.slice(0, MAX_QUERY_LENGTH);
  } else {
    queryText = trimmed;
  }

  emitPipelineEvent("query.start", { query: queryText, collection: options.collection, topK: options.topK, brief: options.brief });

  const collectionName = options.collection ?? config.defaults.collection;
  const topK = Math.min(options.topK ?? config.defaults.queryTopK, 100);
  const tokenBudget = Math.min(options.tokenBudget ?? config.defaults.queryTokenBudget, 50000);
  const useReranker = (options.useReranker ?? true) && !config.reranker.disabled;
  const useBm25 = options.useBm25 ?? true;
  const includeParent = options.includeParentContext !== false; // brief/titles guard is applied later at usage site
  const doExpand = options.expand ?? isExpansionEnabled();
  const brief = options.brief ?? false;
  const titlesOnly = options.titlesOnly ?? false;

  // === Cache Check ===
  const ck = cacheKey(queryText, collectionName, { topK, brief, titlesOnly, useReranker, useBm25, doExpand, tokenBudget, includeParent });
  const cached = getCached<QueryResult>(ck);
  if (cached) {
    recordQuery({
      timestamp: Date.now(),
      query: queryText,
      collection: collectionName,
      strategy: cached.queryInfo.strategy,
      elapsedMs: Date.now() - start,
      candidates: 0,
      chunksReturned: cached.queryInfo.chunksReturned,
      confidence: cached.queryInfo.confidence,
      cached: true,
      vectorHits: cached.queryInfo.retrieval?.vectorHits ?? 0,
      bm25Hits: cached.queryInfo.retrieval?.bm25Hits ?? 0,
      bestDistance: cached.queryInfo.retrieval?.bestDistance ?? 0,
      reranked: cached.queryInfo.retrieval?.reranked ?? false,
    });
    return { ...cached, queryInfo: { ...cached.queryInfo, cached: true, elapsedMs: Date.now() - start } };
  }

  // Get DB (migrations run once at server startup in server.ts)
  const dbPath = resolve(config.dataDir, "threadclaw.db");
  const db = getDb(dbPath);

  // Determine collections — don't auto-create on queries
  const searchCollections: string[] = [];
  const allCollections = collectionName === "all" ? listCollections(db) : null;
  if (allCollections) {
    for (const c of allCollections) searchCollections.push(c.id);
  } else {
    const existing = getCollectionByName(db, collectionName);
    if (!existing) {
      const result = emptyResult(queryText, "collection-not-found", [collectionName], start);
      recordQuery({
        timestamp: Date.now(), query: queryText, collection: collectionName,
        strategy: "collection-not-found", elapsedMs: Date.now() - start,
        candidates: 0, chunksReturned: 0, confidence: 0, cached: false,
        vectorHits: 0, bm25Hits: 0, bestDistance: 0, reranked: false,
      });
      return result;
    }
    searchCollections.push(existing.id);
  }

  const collectionNames = allCollections
    ? allCollections.map((c) => c.name)
    : [collectionName];

  const retrieveCount = topK * config.query.retrieveMultiplier;
  let strategy = "dense";

  // === Query Expansion (optional) ===
  let allQueryEmbeddings: number[][] = [];
  let allQueryTexts: string[] = [queryText];
  let subQueries: string[] | undefined;

  try {
    if (doExpand) {
      emitPipelineEvent("query.expansion", { query: queryText });
      const [decomposed, hydeText, variants] = await Promise.all([
        decomposeQuery(queryText),
        generateHyDE(queryText),
        generateMultiQuery(queryText),
      ]);
      subQueries = decomposed.length > 1 ? decomposed : undefined;
      allQueryTexts = [...new Set([queryText, ...decomposed, ...variants])];

      // Parallelize query embeddings + HyDE embedding in a single Promise.all
      // Skip HyDE if the generated text is too short to be useful for embedding
      if (hydeText && hydeText.length >= 20) {
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
      emitPipelineEvent("query.embed", { query: queryText, variants: 1 });
      allQueryEmbeddings = [await embedQuery(queryText)];
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Embedding failed, falling back to BM25-only retrieval");
    allQueryEmbeddings = [];
  }
  // Track embed tokens for the query itself
  trackTokens("embed", estimateTokens(queryText));

  // === Retrieve ===
  const allVectorResults = [];
  const allBm25Results = [];

  // Entity-boosted retrieval: for short queries (1-2 words), expand with
  // co-occurring terms from the entity graph (precision guard).
  // Boost is applied to both BM25 and vector search for consistent results.
  let entityBoostedQuery = queryText;
  if (config.relations.enabled) {
    const wordCount = queryText.trim().split(/\s+/).length;
    if (wordCount <= 2) {
      try {
        const graphDb = getGraphDb(config.relations.graphDbPath);
        const lowerQuery = queryText.toLowerCase().trim();

        // Try exact composite_id match first, then fuzzy name match (Issue 3 + 5)
        // Entity composite_ids use format "entity:{type}:{name}", so exact `entity:{query}` won't match.
        // Provenance_links.subject_id stores the composite_id from memory_objects.
        let entity = graphDb.prepare(
          "SELECT id, composite_id FROM memory_objects WHERE kind = 'entity' AND composite_id = ? AND json_extract(structured_json, '$.mentionCount') >= 2",
        ).get(`entity:${lowerQuery}`) as { id: number; composite_id: string } | undefined;

        if (!entity) {
          // Fuzzy: match by entity name in structured_json
          entity = graphDb.prepare(
            `SELECT id, composite_id FROM memory_objects
             WHERE kind = 'entity' AND status = 'active'
               AND json_extract(structured_json, '$.name') = ?
               AND COALESCE(json_extract(structured_json, '$.mentionCount'), 1) >= 2
             LIMIT 1`,
          ).get(lowerQuery) as { id: number; composite_id: string } | undefined;
        }

        if (!entity) {
          // Fuzzy LIKE: partial name match (e.g., "orion" matches "project orion")
          entity = graphDb.prepare(
            `SELECT id, composite_id FROM memory_objects
             WHERE kind = 'entity' AND status = 'active'
               AND content LIKE '%' || ? || '%'
               AND COALESCE(json_extract(structured_json, '$.mentionCount'), 1) >= 2
             ORDER BY COALESCE(json_extract(structured_json, '$.mentionCount'), 1) DESC
             LIMIT 1`,
          ).get(lowerQuery) as { id: number; composite_id: string } | undefined;
        }

        if (entity) {
          const mentions = graphDb.prepare(
            "SELECT json_extract(metadata, '$.context_terms') as context_terms FROM provenance_links WHERE subject_id = ? AND predicate = 'mentioned_in' AND json_extract(metadata, '$.context_terms') IS NOT NULL AND json_extract(metadata, '$.context_terms') != 'null' LIMIT 5",
          ).all(entity.composite_id) as Array<{ context_terms: string }>;
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
            const boostTerms = [...coTerms].slice(0, 3);
            entityBoostedQuery = `${queryText} ${boostTerms.join(" ")}`;
            strategy += "+entity_boost";

            // Issue 4: Also embed entity boost terms for vector search
            try {
              const boostEmbedding = await embedQuery(entityBoostedQuery);
              allQueryEmbeddings.push(boostEmbedding);
            } catch { /* non-fatal: vector boost failure should not break pipeline */ }
          }
        }
      } catch (err) {
        if (process.env.DEBUG) console.warn('[query] Entity boost failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  emitPipelineEvent("query.vector_search", { query: queryText, collections: searchCollections.length, embeddings: allQueryEmbeddings.length });

  for (const collId of searchCollections) {
    for (const emb of allQueryEmbeddings) {
      try {
        allVectorResults.push(...searchVectors(db, emb, retrieveCount, collId));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Vector search failed, continuing with BM25");
      }
    }
    if (useBm25) {
      try {
        allBm25Results.push(...searchBm25(db, entityBoostedQuery, retrieveCount, collId));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "BM25 search failed");
      }
    }
  }
  if (useBm25) {
    emitPipelineEvent("query.bm25", { query: entityBoostedQuery, hits: allBm25Results.length });
  }

  // === Deduplicate vector results by chunkId (keep best distance) ===
  const bestByChunk = new Map<string, (typeof allVectorResults)[number]>();
  for (const r of allVectorResults) {
    const prev = bestByChunk.get(r.chunkId);
    if (!prev || r.distance < prev.distance) {
      bestByChunk.set(r.chunkId, r);
    }
  }
  const dedupedVectorResults = Array.from(bestByChunk.values());

  // === Deduplicate BM25 results by chunkId (keep best rank) ===
  const bestBm25ByChunk = new Map<string, (typeof allBm25Results)[number]>();
  for (const r of allBm25Results) {
    const prev = bestBm25ByChunk.get(r.chunkId);
    if (!prev || r.rank < prev.rank) {
      bestBm25ByChunk.set(r.chunkId, r);
    }
  }
  const dedupedBm25Results = Array.from(bestBm25ByChunk.values());

  // === Similarity Threshold Gate ===
  // Filter out results with poor vector distance (likely irrelevant)
  const goodVectorResults = dedupedVectorResults.filter((r) => r.distance < getVectorDistanceThreshold());

  // === Hybrid Merge ===
  let candidateChunkIds: string[];
  if (dedupedBm25Results.length > 0) {
    const hybrid = reciprocalRankFusion(
      goodVectorResults,
      dedupedBm25Results,
    );
    candidateChunkIds = hybrid.slice(0, retrieveCount).map((r) => r.chunkId);
    strategy += "+hybrid";
  } else {
    const seen = new Set<string>();
    candidateChunkIds = [];
    for (const r of goodVectorResults) {
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
    recordQuery({
      timestamp: Date.now(), query: queryText, collection: collectionName,
      strategy, elapsedMs: Date.now() - start,
      candidates: 0, chunksReturned: 0, confidence: 0, cached: false,
      vectorHits: allVectorResults.length, bm25Hits: allBm25Results.length,
      bestDistance: 0, reranked: false,
    });
    return result;
  }

  // === Fetch Chunks ===
  let chunkData = fetchChunks(db, candidateChunkIds);

  // Parent-child enrichment (skip in brief/titles mode — saves tokens)
  if (includeParent && !brief && !titlesOnly) {
    chunkData = enrichWithParentContext(db, chunkData);
  }

  // === Titles-Only Mode ===
  // Only enter titles mode if brief is NOT set (brief takes precedence, matching CLI behavior)
  if (titlesOnly && !brief) {
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
    recordQuery({
      timestamp: Date.now(), query: queryText, collection: collectionName,
      strategy: strategy + "+titles", elapsedMs: Date.now() - start,
      candidates: candidateChunkIds.length, chunksReturned: titles.sources.length,
      confidence: 0.5, cached: false,
      vectorHits: dedupedVectorResults.length, bm25Hits: allBm25Results.length,
      bestDistance: 0, reranked: false,
    });
    return result;
  }

  // === Smart Reranking ===
  let rankedChunks: PackedChunk[];
  let fallbackScores = false; // true when reranker scores are synthetic
  const noGoodVectors = goodVectorResults.length === 0;
  // Use post-gate (goodVectorResults) for skip decision — pre-gate results include irrelevant matches
  const shouldSkipRerank = useReranker && config.reranker.smartSkip && chunkData.length >= 2 && shouldSkipReranking(goodVectorResults);

  // Skip reranking when there's only 1 result — nothing to rerank against, saves latency
  if (useReranker && chunkData.length > 1 && !shouldSkipRerank && !noGoodVectors) {
    const rerankCandidateCount = Math.min(chunkData.length, config.reranker.topK);
    emitPipelineEvent("query.rerank", { query: queryText, candidates: rerankCandidateCount });
    const rerankTexts = chunkData.slice(0, rerankCandidateCount).map((c) =>
      c.contextPrefix ? `${c.contextPrefix}\n\n${c.text}` : c.text,
    );
    const rerankResults = await rerank(queryText, rerankTexts, topK * 2);
    const isFallback = rerankResults.length > 0 && rerankResults[0].fallback === true;
    fallbackScores = isFallback;
    const scoreThreshold = config.reranker.scoreThreshold;
    rankedChunks = rerankResults
      // Skip threshold filtering when using fallback scores (all scores are 1.0)
      // Filter out NaN scores from malformed reranker responses
      .filter((r) => r.index >= 0 && r.index < chunkData.length && Number.isFinite(r.score) && (isFallback || r.score >= scoreThreshold))
      .map((r) => ({
        chunkId: chunkData[r.index].id,
        text: chunkData[r.index].text,
        contextPrefix: chunkData[r.index].contextPrefix ?? undefined,
        sourcePath: chunkData[r.index].sourcePath ?? undefined,
        collectionName: chunkData[r.index].collectionName ?? undefined,
        score: r.score,
      }));
    strategy += isFallback ? "+rerank-fallback" : "+rerank";
    // Track rerank tokens (query + all candidate texts)
    const rerankTokens = estimateTokens(queryText) + chunkData.slice(0, rerankCandidateCount).reduce((s, c) => s + estimateTokens(c.text), 0);
    trackTokens("rerank", rerankTokens);
  } else {
    fallbackScores = true;
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
  // bestDistance is from post-gate (goodVectorResults) only — BM25 results don't have
  // a comparable distance metric, so confidence for BM25-only queries relies on score spread.
  const bestDistance = goodVectorResults.length > 0
    ? Math.min(...goodVectorResults.map((r) => r.distance))
    : undefined;
  const confidence = computeConfidence(topChunks, bestDistance, fallbackScores);

  // === Output Mode ===
  let context: string;
  let highlighted: string | undefined;
  let tokensUsed: number;
  let chunksReturned: number;
  let sources: SourceInfo[];

  if (brief) {
    // Brief: extract relevant sentences, ~250 tokens (up to 500 if user sets explicit budget)
    const briefInput: BriefInput[] = topChunks.map((c) => ({
      text: c.text,
      sourcePath: c.sourcePath,
      collectionName: c.collectionName,
      score: c.score,
    }));
    // If the user explicitly set a token budget, allow up to 500; otherwise cap at 250
    const briefBudget = options.tokenBudget != null
      ? Math.min(tokenBudget, 500)
      : Math.min(tokenBudget, 250);
    const briefResult = extractBrief(queryText, briefInput, briefBudget);
    context = briefResult.text;
    highlighted = briefResult.highlighted;
    tokensUsed = briefResult.tokenCount;
    chunksReturned = topChunks.length;
    // Group topChunks by source to compute per-source stats
    const sourceChunkMap = new Map<string, { scores: number[]; collection?: string; snippet: string }>();
    for (const c of topChunks) {
      const src = c.sourcePath ?? "unknown";
      const entry = sourceChunkMap.get(src);
      if (entry) {
        entry.scores.push(c.score);
      } else {
        sourceChunkMap.set(src, { scores: [c.score], collection: c.collectionName, snippet: c.text.slice(0, 300) });
      }
    }
    sources = briefResult.sources.map((s) => {
      const entry = sourceChunkMap.get(s);
      const scores = entry?.scores ?? [0];
      return {
        source: s,
        chunkCount: scores.length,
        avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        collection: entry?.collection ?? collectionName,
        snippet: entry?.snippet,
      };
    });
    strategy += "+brief";
  } else {
    // Full: rich citations with source attribution
    const packed = packContext(topChunks, tokenBudget, queryText);
    context = packed.context;
    highlighted = packed.highlighted;
    tokensUsed = packed.tokensUsed;
    chunksReturned = packed.chunksUsed;
    // Preserve per-source collection from packer (don't overwrite with the query-level collectionName)
    sources = packed.sources.map((s) => ({ ...s, collection: s.collection ?? collectionName }));
  }

  const elapsed = Date.now() - start;
  const lowConfidence = confidence < config.query.lowConfidenceThreshold && chunksReturned > 0;

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
        vectorHits: dedupedVectorResults.length,
        vectorGated: dedupedVectorResults.length - goodVectorResults.length,
        bm25Hits: allBm25Results.length,
        bestDistance: Math.round((bestDistance ?? 0) * 1000) / 1000,
        reranked: strategy.includes("+rerank") && !strategy.includes("skip-rerank") && !strategy.includes("rerank-fallback"),
      },
    },
  };

  // Optional answer synthesis — produces a direct answer from top chunks
  if (options.synthesize && !options.brief && topChunks.length > 0) {
    try {
      const { synthesizeAnswer } = await import("./synthesize.js");
      const synthesis = await synthesizeAnswer({
        query: queryText,
        chunks: topChunks.map(c => ({
          text: c.text,
          sourcePath: c.sourcePath ?? c.contextPrefix,
          score: c.score,
        })),
      });
      result.answer = synthesis.answer;
      result.answerCitations = synthesis.citations;
      strategy += "+synthesis";
      result.queryInfo.strategy = strategy;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Answer synthesis failed — returning context only");
    }
  }

  // Cache after synthesis so the cached result includes the synthesized answer
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
    vectorHits: dedupedVectorResults.length,
    bm25Hits: allBm25Results.length,
    bestDistance: Math.round((bestDistance ?? 0) * 1000) / 1000,
    reranked: strategy.includes("+rerank") && !strategy.includes("skip-rerank") && !strategy.includes("rerank-fallback"),
  });

  emitPipelineEvent("query.done", {
    query: queryText,
    strategy,
    elapsedMs: elapsed,
    chunks: chunksReturned,
    confidence,
    vectorHits: dedupedVectorResults.length,
    bm25Hits: allBm25Results.length,
    sources: result.sources.map(s => s.source).slice(0, 5),
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

function computeConfidence(chunks: PackedChunk[], bestDistance?: number, fallbackScores = false): number {
  if (chunks.length === 0) return 0;

  // Absolute quality factor from best vector distance (L2: lower = better)
  const distFactor = bestDistance != null
    ? (bestDistance < 0.5 ? 0.8 : bestDistance < 0.8 ? 0.5 : bestDistance < 1.0 ? 0.3 : 0.1)
    : undefined;

  // When scores are synthetic (fallback/no-rerank), rely solely on distance
  // For BM25-only queries (no vector results), derive confidence from result count
  // and score spread rather than returning a fixed 0.5.
  if (fallbackScores) {
    if (distFactor != null) return distFactor;
    // BM25-only: use chunk count as a weak quality signal
    if (chunks.length >= 5) return 0.6;
    if (chunks.length >= 3) return 0.5;
    if (chunks.length >= 1) return 0.35;
    return 0;
  }

  if (chunks.length === 1) return distFactor ?? 0.5;

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
  return Math.min(1, 0.5 * (distFactor ?? 0.5) + 0.5 * spreadConf);
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
      // Build targeted position queries: only fetch [pos-1, pos, pos+1] per match
      // instead of ALL chunks per document (avoids loading entire large documents)
      const positionPairs: Array<{ docId: string; pos: number }> = [];
      for (const c of validChunks) {
        for (let p = Math.max(0, c.position - 1); p <= c.position + 1; p++) {
          positionPairs.push({ docId: c.documentId, pos: p });
        }
      }

      // Deduplicate (docId, pos) pairs
      const uniquePairs = [...new Map(positionPairs.map(p => [`${p.docId}:${p.pos}`, p])).values()];

      // Build a single query with OR conditions for each (document_id, position) pair
      // Batch into groups to avoid excessively long SQL
      const BATCH_SIZE = 200;
      for (let i = 0; i < uniquePairs.length; i += BATCH_SIZE) {
        const batch = uniquePairs.slice(i, i + BATCH_SIZE);
        const conditions = batch.map(() => "(document_id = ? AND position = ?)").join(" OR ");
        const args = batch.flatMap(p => [p.docId, p.pos]);
        const rows = db.prepare(
          `SELECT document_id, id, text, context_prefix as contextPrefix, position FROM chunks
           WHERE ${conditions}`,
        ).all(...args) as { document_id: string; id: string; text: string; contextPrefix: string | null; position: number }[];

        for (const c of rows) {
          if (!neighborMap.has(c.document_id)) neighborMap.set(c.document_id, new Map());
          neighborMap.get(c.document_id)!.set(c.position, c);
        }
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
