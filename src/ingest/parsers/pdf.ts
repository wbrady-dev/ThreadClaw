import { readFile } from "fs/promises";
import { basename } from "path";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";
import { logger } from "../../utils/logger.js";

// Cache the pdfjs-dist module reference to avoid dynamic import on every call
let _pdfjsLib: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

/**
 * Parse PDF files using pdfjs-dist.
 * Extracts text page-by-page with page break markers.
 */
export async function parsePdf(filePath: string): Promise<ParsedDocument> {
  try {
    const buffer = await readFile(filePath);

    if (!_pdfjsLib) {
      _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    }
    const pdfjsLib = _pdfjsLib;

    // Pass buffer directly — avoid Uint8Array double copy
    const doc = await pdfjsLib.getDocument({
      data: buffer,
      useSystemFonts: true,
    }).promise;

    const metadata: DocMetadata = {
      fileType: "pdf",
      source: filePath,
    };

    // Extract PDF metadata
    try {
      const meta = await doc.getMetadata();
      const info = meta?.info as Record<string, string> | undefined;
      if (info) {
        if (info.Title) metadata.title = info.Title;
        if (info.Author) metadata.author = info.Author;
        if (info.CreationDate) metadata.date = parsePdfDate(info.CreationDate);
      }
    } catch {
      // Metadata extraction can fail on some PDFs
    }

    if (!metadata.title) {
      metadata.title = basename(filePath, ".pdf");
    }

    // Extract text page by page
    const pages: string[] = [];
    const structure: StructureHint[] = [];
    let offset = 0;

    for (let i = 1; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();

        // Use hasEOL to preserve paragraph structure instead of joining all items with space
        const parts: string[] = [];
        for (const item of content.items) {
          if ("str" in item) {
            parts.push(item.str);
            if ((item as any).hasEOL) {
              parts.push("\n");
            }
          }
        }
        const pageText = parts.join("").trim();

        if (pageText) {
          if (pages.length > 0) {
            // Add page break marker (accounts for \n\n join between pages)
            structure.push({
              type: "page_break",
              startOffset: offset,
              endOffset: offset + 2,
            });
            offset += 2; // for the \n\n join
          }
          pages.push(pageText);
          offset += pageText.length;
        }
      } catch (err) {
        // Skip corrupted page — don't abort the entire document
        logger.warn(`[pdf] Failed to extract page ${i}: ${err}`);
      }
    }

    doc.destroy();

    return { text: pages.join("\n\n"), structure, metadata };
  } catch (err) {
    logger.error({ filePath, error: String(err) }, "PDF parse failed");
    return {
      text: `[PDF: ${basename(filePath)} — parse failed: ${err instanceof Error ? err.message?.substring(0, 100) : "unknown error"}]`,
      structure: [],
      metadata: { fileType: "pdf", source: filePath, title: basename(filePath, ".pdf") },
    };
  }
}

function parsePdfDate(dateStr: string): string {
  // Extended regex to handle timezone offset (D:YYYYMMDDHHmmSS+HH'mm')
  const m = dateStr.match(/D:(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?(?:([+-Z])(\d{2})'?(\d{2})?'?)?/);
  if (m) {
    let result = `${m[1]}-${m[2]}-${m[3]}`;
    if (m[4]) result += `T${m[4]}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
    if (m[7] && m[7] !== "Z") {
      result += `${m[7]}${m[8] ?? "00"}:${m[9] ?? "00"}`;
    } else if (m[7] === "Z") {
      result += "Z";
    }
    return result;
  }
  return dateStr;
}
