import { basename, extname, resolve } from "path";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

/**
 * Parse documents using Docling (via the Python model server).
 * Layout-aware parsing that handles complex PDFs, DOCX, PPTX, XLSX
 * with proper table extraction, reading order, and multi-language support.
 *
 * Falls back to null if Docling is unavailable — callers should use
 * local parsers as fallback.
 */
export async function parseWithDocling(
  filePath: string,
): Promise<ParsedDocument | null> {
  // Validate file path is within expected directories to prevent sending arbitrary paths
  // to the external Docling service
  const absPath = resolve(filePath);
  const allowedBase = resolve(config.dataDir, "..");
  if (!absPath.startsWith(allowedBase)) {
    logger.warn({ filePath: absPath }, "Docling: file path outside allowed base directory, skipping");
    return null;
  }

  // NOTE: Uses config.reranker.url because the Python model server hosts both
  // the reranker and Docling endpoints on the same HTTP server.
  const url = `${config.reranker.url}/parse`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(config.extraction.doclingTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { status: response.status, body },
        "Docling parse failed, falling back to local parser",
      );
      return null;
    }

    const data = (await response.json()) as {
      markdown: string;
      metadata: {
        title?: string;
        author?: string;
        date?: string;
        language?: string;
        page_count?: number;
      };
    };

    if (!data.markdown) {
      return null;
    }

    const text = data.markdown;
    const ext = extname(filePath).toLowerCase();
    const structure: StructureHint[] = [];

    // Extract headings from the markdown output
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(text)) !== null) {
      structure.push({
        type: "heading",
        level: match[1].length,
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    }

    const metadata: DocMetadata = {
      fileType: ext.replace(".", "") || "document",
      source: filePath,
      title: data.metadata.title ?? basename(filePath, ext),
      author: data.metadata.author ?? undefined,
      date: data.metadata.date ?? undefined,
      tags: [],
    };

    // Add language tag if detected
    if (data.metadata.language && data.metadata.language !== "unknown") {
      metadata.tags = [data.metadata.language];
    }

    // Add page count tag for PDFs
    if (data.metadata.page_count) {
      metadata.tags = [...(metadata.tags ?? []), `${data.metadata.page_count}-pages`];
    }

    logger.info(
      {
        filePath,
        chars: text.length,
        headings: structure.length,
        language: data.metadata.language,
      },
      "Docling parse complete",
    );

    return { text, structure, metadata };
  } catch (err) {
    logger.warn(
      { error: String(err) },
      "Docling unavailable, falling back to local parser",
    );
    return null;
  }
}

