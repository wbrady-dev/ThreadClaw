import { config } from "../../config.js";
import { estimateTokens } from "../../utils/format.js";
import type { ParsedDocument } from "../parsers/index.js";
import { chunkProse } from "./strategies/prose.js";
import { chunkMarkdown } from "./strategies/markdown.js";
import { chunkHtml } from "./strategies/html.js";
import { chunkCode } from "./strategies/code.js";
import { chunkTable } from "./strategies/table.js";

export interface Chunk {
  text: string;
  contextPrefix?: string;
  position: number;
  tokenCount: number;
}

/**
 * Semantic chunker: selects strategy based on document structure and type,
 * then enforces minimum/maximum chunk size bounds.
 */
export function chunkDocument(doc: ParsedDocument): Chunk[] {
  const { text, structure, metadata } = doc;
  const { chunkMinTokens, chunkMaxTokens, chunkTargetTokens } = config.defaults;

  let chunks: Chunk[];
  const hasHeadings = structure.some((s) => s.type === "heading");

  switch (metadata.fileType) {
    case "markdown":
      chunks = hasHeadings
        ? chunkMarkdown(text, structure, chunkMaxTokens)
        : chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;

    case "html":
      chunks = hasHeadings
        ? chunkHtml(text, structure, chunkMaxTokens)
        : chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;

    case "code":
      chunks = hasHeadings
        ? chunkCode(text, structure, chunkMaxTokens)
        : chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;

    case "docx":
    case "pptx":
      chunks = hasHeadings
        ? chunkMarkdown(text, structure, chunkMaxTokens)
        : chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;

    case "csv":
      chunks = chunkTable(text, chunkMaxTokens);
      break;

    case "pdf":
      chunks = chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;

    default:
      chunks = chunkProse(text, chunkTargetTokens, chunkMaxTokens);
      break;
  }

  // Enforce minimum size: merge small chunks with the previous one
  chunks = mergeSmallChunks(chunks, chunkMinTokens);

  // Add overlap: prepend last N% of previous chunk's text for context preservation
  chunks = addOverlap(chunks, Math.floor(chunkTargetTokens * config.extraction.chunkOverlapRatio));

  // Re-number positions
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].position = i;
  }

  return chunks;
}

/**
 * Add overlap between consecutive chunks for context preservation.
 * Prepends the last N tokens of the previous chunk to the current chunk,
 * preventing information loss at chunk boundaries.
 *
 * TODO(BUG 9): Overlap text is stored verbatim in each chunk row, inflating
 * the DB. Consider storing overlap as a reference (offset + length) to the
 * previous chunk and reconstructing at query time.
 */
function addOverlap(chunks: Chunk[], overlapTokens: number): Chunk[] {
  if (chunks.length <= 1 || overlapTokens <= 0) return chunks;

  const result: Chunk[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];

    // Extract tail of previous chunk as overlap context
    const prevWords = prev.text.split(/\s+/);
    // ~1 token per word (conservative) for overlap sizing
    const overlapWordCount = Math.min(overlapTokens, Math.floor(prevWords.length * 0.3));

    if (overlapWordCount > 0) {
      const overlapText = prevWords.slice(-overlapWordCount).join(" ");
      result.push({
        ...curr,
        text: overlapText + "\n" + curr.text,
        tokenCount: estimateTokens(overlapText + "\n" + curr.text),
      });
    } else {
      result.push({ ...curr });
    }
  }

  return result;
}

function mergeSmallChunks(chunks: Chunk[], minTokens: number): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (chunk.tokenCount < minTokens && merged.length > 0) {
      // Merge with previous chunk
      const prev = merged[merged.length - 1];
      prev.text = prev.text + "\n\n" + chunk.text;
      prev.contextPrefix = prev.contextPrefix || chunk.contextPrefix;
      prev.tokenCount = estimateTokens(prev.text);
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}
