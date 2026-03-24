import { estimateTokens, extractFileName, splitSentences } from "../utils/format.js";
import { config } from "../config.js";

/**
 * Token-efficient sentence extraction for agent consumption.
 * Extracts the most relevant sentences from retrieved chunks
 * instead of returning full raw text. No LLM needed — pure extraction.
 *
 * Scoring:
 * - Term match: +1 per query term found
 * - Position: first sentence 1.5x (topic), last 1.2x (conclusion)
 * - Length: <5 words 0.5x penalty, >50 words 0.8x penalty
 */

interface ScoredSentence {
  text: string;
  score: number;
  sourceIdx: number;  // which chunk it came from
  posInChunk: number; // original position within chunk
  source: string;     // source file for citation
}

// Common boilerplate patterns to strip
const BOILERPLATE = [
  /©\s*\d{4}.*?reserved\.?/gi,
  /all rights reserved\.?/gi,
  /page\s+\d+\s+of\s+\d+/gi,
  /www\.\w+\.\w+/gi,
  /^\s*type your answers? here\.?\s*$/gim,
  /^\s*blank\s*$/gim,
  /^\s*N\/A\s*$/gim,
];

export interface BriefInput {
  text: string;
  sourcePath?: string;
  collectionName?: string;
  score: number;
}

export interface BriefResult {
  text: string;
  sources: string[];
  tokenCount: number;
  /** Text with **matched terms** highlighted in markdown bold */
  highlighted?: string;
}

/**
 * Extract a brief, token-efficient summary from retrieved chunks.
 * Returns the most relevant sentences, reordered for readability.
 */
export function extractBrief(
  query: string,
  chunks: BriefInput[],
  tokenBudget: number = 250,
): BriefResult {
  if (chunks.length === 0) {
    return { text: "No relevant documents found.", sources: [], tokenCount: 5 };
  }

  // Extract query terms (lowercase, deduped, min 3 chars)
  const queryTerms = [...new Set(
    query.toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )];

  // Collect all sentences from all chunks with scores
  const allSentences: ScoredSentence[] = [];
  const sources = new Set<string>();
  const maxScore = Math.max(...chunks.map((c) => c.score), 0.01);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    let text = chunk.text;

    // Strip boilerplate
    for (const pattern of BOILERPLATE) {
      text = text.replace(pattern, "");
    }

    // Split into sentences
    const sentences = splitSentences(text);
    if (sentences.length === 0) continue;

    const source = extractFileName(chunk.sourcePath ?? "unknown");
    sources.add(chunk.collectionName ? `${source} (${chunk.collectionName})` : source);

    for (let si = 0; si < sentences.length; si++) {
      const sent = sentences[si].trim();
      if (!sent || sent.length < 10) continue;

      // Score: term match (normalized by query term count to prevent long docs dominating)
      const lowerSent = sent.toLowerCase();
      let termHits = 0;
      for (const term of queryTerms) {
        if (lowerSent.includes(term)) termHits++;
      }
      const termScore = queryTerms.length > 0 ? termHits / queryTerms.length : 0;

      // Score: position boost (soft — let relevance dominate)
      let posMultiplier = 1.0;
      if (si === 0) posMultiplier = 1.1;                    // first = topic sentence
      else if (si === sentences.length - 1) posMultiplier = 1.05; // last = conclusion

      // Score: length penalty (penalize very short and very long sentences)
      const wordCount = sent.split(/\s+/).length;
      let lengthMultiplier = 1.0;
      if (wordCount < 5) lengthMultiplier = 0.3;
      else if (wordCount > 50) lengthMultiplier = 0.6;

      // Score: chunk relevance normalized to [0, 1]
      const normalizedRelevance = (chunk.score > 0 ? chunk.score : 0) / maxScore;

      // Final score: weighted retrieval relevance + term match
      const finalScore = (normalizedRelevance * config.brief.relevanceWeight + termScore * config.brief.termMatchWeight) * posMultiplier * lengthMultiplier;

      if (finalScore > 0) {
        allSentences.push({
          text: sent,
          score: finalScore,
          sourceIdx: ci,
          posInChunk: si,
          source,
        });
      }
    }
  }

  if (allSentences.length === 0) {
    // No scored sentences — return first sentence of top chunk as fallback
    const fallback = splitSentences(chunks[0].text)[0] ?? chunks[0].text.slice(0, 200);
    const src = extractFileName(chunks[0].sourcePath ?? "unknown");
    return {
      text: `${fallback}\n[Source: ${src}]`,
      sources: [src],
      tokenCount: estimateTokens(fallback) + 5,
    };
  }

  // Sort by score descending
  allSentences.sort((a, b) => b.score - a.score);

  // Select top sentences within token budget, with per-source diversity cap
  const selected: ScoredSentence[] = [];
  let tokenCount = 0;
  const citationTokens = 10; // reserve for source line
  const sourceSentCount = new Map<number, number>(); // sourceIdx -> count
  const maxPerSource = config.brief.maxPerSource; // prevent one large document from dominating

  for (const sent of allSentences) {
    const count = sourceSentCount.get(sent.sourceIdx) ?? 0;
    if (count >= maxPerSource) continue; // diversity cap

    const sentTokens = estimateTokens(sent.text);
    if (tokenCount + sentTokens + citationTokens > tokenBudget) break;
    selected.push(sent);
    tokenCount += sentTokens;
    sourceSentCount.set(sent.sourceIdx, count + 1);
  }

  if (selected.length === 0) {
    // Budget too small — take first sentence anyway
    selected.push(allSentences[0]);
    tokenCount = estimateTokens(allSentences[0].text);
  }

  // Re-order by original position (preserve reading flow)
  selected.sort((a, b) => {
    if (a.sourceIdx !== b.sourceIdx) return a.sourceIdx - b.sourceIdx;
    return a.posInChunk - b.posInChunk;
  });

  // Build output — only cite sources that contributed to selected sentences
  const text = selected.map((s) => s.text).join(" ");
  const usedSources = new Set(selected.map((s) => s.source));
  const sourceList = [...usedSources];
  const citation = `[Source: ${sourceList.join(", ")}]`;
  const finalText = `${text}\n${citation}`;

  // Generate highlighted version with matched terms in markdown bold
  let highlighted: string | undefined;
  if (queryTerms.length > 0) {
    const escapedTerms = queryTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`\\b(${escapedTerms.join("|")})\\b`, "gi");
    const highlightedText = selected.map((s) => s.text.replace(/\*\*/g, "").replace(pattern, "**$1**")).join(" ");
    highlighted = `${highlightedText}\n${citation}`;
  }

  return {
    text: finalText,
    sources: sourceList,
    tokenCount: tokenCount + citationTokens,
    highlighted,
  };
}

