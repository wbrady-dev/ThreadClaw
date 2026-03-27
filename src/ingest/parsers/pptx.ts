import { readFile } from "fs/promises";
import { basename } from "path";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";
import { logger } from "../../utils/logger.js";

// PPTX files are ZIP archives containing XML slides
// We parse them without heavy dependencies using JSZip-style extraction

/**
 * Parse .pptx files by extracting slide XML content.
 * Each slide becomes a section with its slide number as context.
 */
export async function parsePptx(filePath: string): Promise<ParsedDocument> {
  try {
    const buffer = await readFile(filePath);

    // PPTX is a ZIP file — use Node's built-in zlib via a lightweight approach
    const { parseBuffer } = await import("./pptx-extractor.js");
    const slides = await parseBuffer(buffer);

    const metadata: DocMetadata = {
      fileType: "pptx",
      title: basename(filePath, ".pptx"),
      source: filePath,
    };

    const structure: StructureHint[] = [];
    const parts: string[] = [];
    let offset = 0;

    for (let i = 0; i < slides.length; i++) {
      const slideHeader = `## Slide ${i + 1}`;
      const slideContent = slides[i].trim();

      if (!slideContent) continue;

      // Title detection heuristic: use first slide's first line if it's short.
      // NOTE: This is fragile — it assumes the first slide's first line is the presentation title.
      // A more robust approach would parse the presentation.xml for dc:title metadata.
      if (i === 0 && slideContent.length < 200) {
        const firstLine = slideContent.split("\n")[0].trim();
        if (firstLine) metadata.title = firstLine;
      }

      structure.push({
        type: "heading",
        level: 2,
        startOffset: offset,
        endOffset: offset + slideHeader.length,
      });

      const section = `${slideHeader}\n${slideContent}`;
      parts.push(section);
      offset += section.length + 2; // +2 for \n\n separator
    }

    return {
      text: parts.join("\n\n"),
      structure,
      metadata,
    };
  } catch (err) {
    logger.error({ filePath, error: String(err) }, "PPTX parse failed");
    return {
      text: `[PPTX: ${basename(filePath)} — parse failed: ${err instanceof Error ? err.message?.substring(0, 100) : "unknown error"}]`,
      structure: [],
      metadata: { fileType: "pptx", title: basename(filePath, ".pptx"), source: filePath },
    };
  }
}
