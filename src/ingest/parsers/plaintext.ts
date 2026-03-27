import { readFile } from "fs/promises";
import { basename } from "path";
import type { ParsedDocument, DocMetadata } from "./index.js";

/**
 * Plain text parser — minimal processing, returns raw text.
 *
 * NOTE: No size guard here — the pipeline-level MAX_FILE_SIZE check handles this.
 *
 * NOTE: YAML (.yml/.yaml) and XML (.xml) files are routed here as plain text.
 * A future enhancement could add structure detection for these formats
 * (e.g., YAML key paths, XML element hierarchy) for better chunking.
 */
export async function parsePlaintext(filePath: string): Promise<ParsedDocument> {
  const text = await readFile(filePath, "utf-8");
  const metadata: DocMetadata = {
    fileType: "plaintext",
    title: basename(filePath),
    source: filePath,
  };

  return { text, structure: [], metadata };
}
