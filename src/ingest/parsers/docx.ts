import { readFile } from "fs/promises";
import { basename } from "path";
import mammoth from "mammoth";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";
import { logger } from "../../utils/logger.js";

/** Maximum decompressed DOCX size (100 MB) to guard against zip bombs */
const MAX_DOCX_SIZE = 100 * 1024 * 1024;

/**
 * Parse .docx files using mammoth.
 * Converts to markdown-like text preserving headings, lists, and tables.
 * Mammoth produces clean semantic output — ideal for RAG chunking.
 */
export async function parseDocx(filePath: string): Promise<ParsedDocument> {
  try {
    const buffer = await readFile(filePath);

    // Zip bomb / file size guard
    if (buffer.length > MAX_DOCX_SIZE) {
      logger.warn({ filePath, size: buffer.length }, "DOCX file too large, skipping");
      return {
        text: `[DOCX: ${basename(filePath)} — file too large (${Math.round(buffer.length / 1024 / 1024)}MB)]`,
        structure: [],
        metadata: { fileType: "docx", title: basename(filePath, ".docx"), source: filePath },
      };
    }

    // Convert to markdown for best structure preservation
    const result = await mammoth.convertToMarkdown({ buffer });
    const text = result.value;

    const metadata: DocMetadata = {
      fileType: "docx",
      title: basename(filePath, ".docx"),
      source: filePath,
    };

    // Extract headings from the markdown output
    const structure: StructureHint[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    let firstHeading: string | null = null;
    while ((match = headingRegex.exec(text)) !== null) {
      structure.push({
        type: "heading",
        level: match[1].length,
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });

      // Track first heading of any level for title fallback
      if (!firstHeading) {
        firstHeading = match[2].trim();
      }

      // Use first H1 as title
      if (!metadata.title || metadata.title === basename(filePath, ".docx")) {
        if (match[1].length === 1) {
          metadata.title = match[2].trim();
        }
      }
    }

    // Fall back to first heading of any level if no H1 found
    if (metadata.title === basename(filePath, ".docx") && firstHeading) {
      metadata.title = firstHeading;
    }

    // Log warnings if any conversion issues
    if (result.messages.length > 0) {
      const warnings = result.messages
        .filter((m: { type: string; message: string }) => m.type === "warning")
        .map((m: { type: string; message: string }) => m.message);
      if (warnings.length > 0) {
        metadata.tags = ["conversion-warnings"];
      }
    }

    return { text, structure, metadata };
  } catch (err) {
    logger.error({ filePath, error: String(err) }, "DOCX parse failed");
    return {
      text: `[DOCX: ${basename(filePath)} — parse failed: ${err instanceof Error ? err.message?.substring(0, 100) : "unknown error"}]`,
      structure: [],
      metadata: { fileType: "docx", title: basename(filePath, ".docx"), source: filePath },
    };
  }
}
