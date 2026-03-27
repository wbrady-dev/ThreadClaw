import { estimateTokens, extractFileName } from "../utils/format.js";

export interface PackedChunk {
  chunkId: string;
  text: string;
  contextPrefix?: string;
  sourcePath?: string;
  collectionName?: string;
  score: number;
}

// NOTE: SourceInfo is also defined in query/pipeline.ts. This is the canonical
// definition — pipeline.ts should import from here to avoid duplication.
export interface SourceInfo {
  source: string;
  chunkCount: number;
  avgScore: number;
  collection?: string;
}

export interface PackedResult {
  context: string;
  sources: SourceInfo[];
  chunksUsed: number;
  tokensUsed: number;
}

/**
 * Pack retrieved chunks into a formatted context string with rich citations.
 *
 * Features:
 * - Groups chunks by source document
 * - Includes collection name for multi-collection searches
 * - Shows section context (heading chain) per chunk
 * - Respects token budget
 * - Relevance indicator per source
 */
export function packContext(
  chunks: PackedChunk[],
  tokenBudget: number,
): PackedResult {
  if (chunks.length === 0) {
    return { context: "", sources: [], chunksUsed: 0, tokensUsed: 0 };
  }

  // Group by source
  const bySource = new Map<string, PackedChunk[]>();
  for (const chunk of chunks) {
    const src = chunk.sourcePath ?? "unknown";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(chunk);
  }

  const lines: string[] = [];
  let tokensUsed = 0;
  let chunksUsed = 0;
  const sourceStats: {
    source: string;
    collection?: string;
    chunkCount: number;
    scores: number[];
  }[] = [];

  // Compute relative relevance thresholds from the actual score distribution
  const allScores = chunks.map((c) => c.score).sort((a, b) => b - a);
  const topScore = allScores[0] ?? 0;
  const bottomScore = allScores[allScores.length - 1] ?? 0;
  const range = topScore - bottomScore;

  for (const [source, sourceChunks] of bySource) {
    const sourceName = extractFileName(source);
    const collName = sourceChunks[0]?.collectionName;
    const relevance = relativeRelevanceLabel(sourceChunks[0]?.score ?? 0, topScore, range);

    // Rich citation header
    let header = `\n---\n**[${sourceName}]**`;
    if (collName) header += ` *(${collName})*`;
    header += ` ${relevance}\n`;

    const headerTokens = estimateTokens(header);
    if (tokensUsed + headerTokens > tokenBudget) break;

    lines.push(header);
    tokensUsed += headerTokens;

    const stat = {
      source: sourceName,
      collection: collName ?? undefined,
      chunkCount: 0,
      scores: [] as number[],
    };

    for (const chunk of sourceChunks) {
      const chunkLines: string[] = [];

      if (chunk.contextPrefix) {
        chunkLines.push(`> *${chunk.contextPrefix}*`);
      }
      chunkLines.push(chunk.text);
      chunkLines.push("");

      const chunkText = chunkLines.join("\n");
      const chunkTokens = estimateTokens(chunkText);

      if (tokensUsed + chunkTokens > tokenBudget) break;

      lines.push(chunkText);
      tokensUsed += chunkTokens;
      chunksUsed++;
      stat.chunkCount++;
      stat.scores.push(chunk.score);
    }

    if (stat.chunkCount > 0) {
      sourceStats.push(stat);
    }
  }

  const sources: SourceInfo[] = sourceStats.map((s) => ({
    source: s.source,
    chunkCount: s.chunkCount,
    avgScore: s.scores.reduce((a, b) => a + b, 0) / s.scores.length,
    collection: s.collection,
  }));

  return {
    context: lines.join("\n").trim(),
    sources,
    chunksUsed,
    tokensUsed,
  };
}

/**
 * Titles-only mode — return just document names and collections.
 * ~30 tokens per query. For exploratory "what do I have?" searches.
 */
export function packTitles(chunks: { sourcePath: string | null; collectionName: string | null }[]): {
  text: string;
  sources: SourceInfo[];
  tokenCount: number;
} {
  const bySource = new Map<string, { collection: string; count: number }>();
  for (const chunk of chunks) {
    const src = chunk.sourcePath ?? "unknown";
    const coll = chunk.collectionName ?? "default";
    if (bySource.has(src)) {
      bySource.get(src)!.count++;
    } else {
      bySource.set(src, { collection: coll, count: 1 });
    }
  }

  const lines: string[] = [];
  const sources: SourceInfo[] = [];
  let tokenCount = 0;
  for (const [src, info] of bySource) {
    const name = extractFileName(src);
    const line = `${name} (${info.collection}, ${info.count} chunks)`;
    const lineTokens = estimateTokens(line);
    if (lines.length > 0 && tokenCount + lineTokens > 50) break; // Cap at ~50 tokens, but always include at least 1
    lines.push(line);
    tokenCount += lineTokens;
    sources.push({ source: name, chunkCount: info.count, avgScore: 0, collection: info.collection });
  }

  const text = lines.join("\n");
  return { text, sources, tokenCount };
}

/**
 * Compute relevance label relative to the score distribution.
 * Works regardless of the reranker's absolute score scale.
 *
 * NOTE: These Unicode dot characters may confuse some LLMs that interpret them
 * as formatting or special tokens. Consider using text labels like [HIGH]/[MED]/[LOW]
 * if LLM downstream consumers have issues.
 */
function relativeRelevanceLabel(score: number, topScore: number, range: number): string {
  if (range === 0) return "●●●"; // all scores equal = all equally relevant

  const normalized = (score - (topScore - range)) / range; // 0 = worst, 1 = best
  if (normalized >= 0.75) return "●●●";
  if (normalized >= 0.5) return "●●○";
  if (normalized >= 0.25) return "●○○";
  return "○○○";
}
