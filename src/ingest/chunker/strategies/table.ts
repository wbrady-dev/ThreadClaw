import { estimateTokens } from "../../../utils/format.js";
import { config } from "../../../config.js";
import type { Chunk } from "../semantic.js";

const ROWS_PER_CHUNK = config.extraction.chunkTableRows;

/** Detect if a line is a markdown table separator (e.g., |---|---|) */
function isSeparatorLine(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes("-");
}

/**
 * Table chunking strategy: group rows into chunks of ~20 rows.
 * Repeats the header row at the top of each chunk for context.
 */
export function chunkTable(
  text: string,
  maxTokens: number,
): Chunk[] {
  const lines = text.split("\n");
  if (lines.length <= 2) {
    // Two-line CSV: if second line is a separator, strip it
    const filtered = lines.filter((l) => !isSeparatorLine(l));
    const cleanText = filtered.join("\n");
    return [{
      text: cleanText,
      position: 0,
      tokenCount: estimateTokens(cleanText),
    }];
  }

  // First line is header, detect separator pattern instead of assuming line[1]
  const header = lines[0];
  let separatorIdx = -1;
  if (lines.length > 1 && isSeparatorLine(lines[1])) {
    separatorIdx = 1;
  }
  const separator = separatorIdx >= 0 ? lines[separatorIdx] : null;
  const dataLines = lines.slice(separatorIdx >= 0 ? 2 : 1);

  const chunks: Chunk[] = [];

  for (let i = 0; i < dataLines.length; i += ROWS_PER_CHUNK) {
    const rowGroup = dataLines.slice(i, i + ROWS_PER_CHUNK);
    const chunkParts = separator ? [header, separator, ...rowGroup] : [header, ...rowGroup];
    const chunkText = chunkParts.join("\n");
    // Account for newline separators in token estimate
    const tokens = estimateTokens(chunkText);

    // If this chunk is still too big, reduce rows
    if (tokens > maxTokens) {
      const headerParts = separator ? [header, separator] : [header];
      let subBuf = [...headerParts];
      // Re-estimate header tokens including newlines
      let subTokens = estimateTokens(headerParts.join("\n"));
      let subStartRow = i;

      for (let ri = 0; ri < rowGroup.length; ri++) {
        const row = rowGroup[ri];
        const rt = estimateTokens("\n" + row); // account for join separator
        if (subTokens + rt > maxTokens && subBuf.length > headerParts.length) {
          chunks.push({
            text: subBuf.join("\n"),
            contextPrefix: `rows ${subStartRow + 1}-${subStartRow + subBuf.length - headerParts.length}`,
            position: chunks.length,
            tokenCount: subTokens,
          });
          subStartRow += subBuf.length - headerParts.length;
          subBuf = [...headerParts];
          subTokens = estimateTokens(headerParts.join("\n"));
        }
        subBuf.push(row);
        subTokens += rt;
      }
      if (subBuf.length > headerParts.length) {
        chunks.push({
          text: subBuf.join("\n"),
          contextPrefix: `rows ${subStartRow + 1}-${subStartRow + subBuf.length - headerParts.length}`,
          position: chunks.length,
          tokenCount: estimateTokens(subBuf.join("\n")),
        });
      }
    } else {
      chunks.push({
        text: chunkText,
        contextPrefix: `rows ${i + 1}-${Math.min(i + ROWS_PER_CHUNK, dataLines.length)}`,
        position: chunks.length,
        tokenCount: tokens,
      });
    }
  }

  return chunks;
}
