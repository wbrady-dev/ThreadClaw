import { readFile } from "fs/promises";
import { basename } from "path";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

/**
 * Parse PDF files using pdfjs-dist.
 * Extracts text page-by-page with page break markers.
 */
export async function parsePdf(filePath: string): Promise<ParsedDocument> {
  const buffer = await readFile(filePath);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
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
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();

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
      console.error(`[pdf] Failed to extract page ${i}: ${err}`);
    }
  }

  doc.destroy();

  return { text: pages.join("\n\n"), structure, metadata };
}

function parsePdfDate(dateStr: string): string {
  const m = dateStr.match(/D:(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return dateStr;
}
