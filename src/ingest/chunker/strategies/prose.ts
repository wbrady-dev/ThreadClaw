import { estimateTokens, splitSentences } from "../../../utils/format.js";
import type { Chunk } from "../semantic.js";

/**
 * Prose chunking strategy: split on paragraphs, merge small ones
 * until reaching target token count.
 */
export function chunkProse(
  text: string,
  targetTokens: number,
  maxTokens: number,
): Chunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentParts: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    // If single paragraph exceeds max, split at sentence boundaries
    if (paraTokens > maxTokens) {
      // Flush current buffer
      if (currentParts.length > 0) {
        chunks.push({
          text: currentParts.join("\n\n"),
          position: chunks.length,
          tokenCount: currentTokens,
        });
        currentParts = [];
        currentTokens = 0;
      }

      // Split large paragraph by sentences
      const sentences = splitSentences(para);
      let sentBuf: string[] = [];
      let sentTokens = 0;

      for (const sent of sentences) {
        const st = estimateTokens(sent);
        // Hard split if a single sentence exceeds maxTokens (e.g., minified content)
        if (st > maxTokens && sentBuf.length === 0) {
          // Character-level split for oversized single sentences.
          // NOTE: 4 chars/token heuristic is approximate for Latin text (~3.5-4 chars/token).
          // CJK text averages ~2 chars/token, so chunks may be ~2x the intended token count.
          const chars = sent;
          for (let ci = 0; ci < chars.length; ci += maxTokens * 4) {
            const slice = chars.slice(ci, ci + maxTokens * 4);
            chunks.push({
              text: slice,
              position: chunks.length,
              tokenCount: estimateTokens(slice),
            });
          }
          continue;
        }
        if (sentTokens + st > maxTokens && sentBuf.length > 0) {
          chunks.push({
            text: sentBuf.join(" "),
            position: chunks.length,
            tokenCount: sentTokens,
          });
          sentBuf = [];
          sentTokens = 0;
        }
        sentBuf.push(sent);
        sentTokens += st;
      }

      if (sentBuf.length > 0) {
        chunks.push({
          text: sentBuf.join(" "),
          position: chunks.length,
          tokenCount: sentTokens,
        });
      }
      continue;
    }

    // If adding this paragraph would exceed target, flush
    if (currentTokens + paraTokens > targetTokens && currentParts.length > 0) {
      chunks.push({
        text: currentParts.join("\n\n"),
        position: chunks.length,
        tokenCount: currentTokens,
      });
      currentParts = [];
      currentTokens = 0;
    }

    currentParts.push(para);
    currentTokens += paraTokens;
  }

  // Flush remaining
  if (currentParts.length > 0) {
    chunks.push({
      text: currentParts.join("\n\n"),
      position: chunks.length,
      tokenCount: currentTokens,
    });
  }

  return chunks;
}

// splitSentences imported from utils/format.js
