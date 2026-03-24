import { estimateTokens } from "../../../utils/format.js";
import { config } from "../../../config.js";
import type { Chunk } from "../semantic.js";

const ROWS_PER_CHUNK = config.extraction.chunkTableRows;

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
    return [{
      text,
      position: 0,
      tokenCount: estimateTokens(text),
    }];
  }

  // First line is header, second is separator
  const header = lines[0];
  const separator = lines[1];
  const dataLines = lines.slice(2);

  const chunks: Chunk[] = [];

  for (let i = 0; i < dataLines.length; i += ROWS_PER_CHUNK) {
    const rowGroup = dataLines.slice(i, i + ROWS_PER_CHUNK);
    const chunkText = [header, separator, ...rowGroup].join("\n");
    const tokens = estimateTokens(chunkText);

    // If this chunk is still too big, reduce rows
    if (tokens > maxTokens) {
      let subBuf = [header, separator];
      let subTokens = estimateTokens(header + "\n" + separator);
      let subStartRow = i;

      for (let ri = 0; ri < rowGroup.length; ri++) {
        const row = rowGroup[ri];
        const rt = estimateTokens(row);
        if (subTokens + rt > maxTokens && subBuf.length > 2) {
          chunks.push({
            text: subBuf.join("\n"),
            contextPrefix: `rows ${subStartRow + 1}-${subStartRow + subBuf.length - 2}`,
            position: chunks.length,
            tokenCount: subTokens,
          });
          subStartRow += subBuf.length - 2;
          subBuf = [header, separator];
          subTokens = estimateTokens(header + "\n" + separator);
        }
        subBuf.push(row);
        subTokens += rt;
      }
      if (subBuf.length > 2) {
        chunks.push({
          text: subBuf.join("\n"),
          contextPrefix: `rows ${subStartRow + 1}-${subStartRow + subBuf.length - 2}`,
          position: chunks.length,
          tokenCount: subTokens,
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
