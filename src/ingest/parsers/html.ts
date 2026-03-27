import { readFile } from "fs/promises";
import { basename } from "path";
import { pathToFileURL } from "url";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";
import { logger } from "../../utils/logger.js";

/**
 * Parse HTML files using Mozilla Readability for content extraction.
 * Falls back to full body text if Readability can't extract an article.
 */
export async function parseHtml(filePath: string): Promise<ParsedDocument> {
  try {
    const raw = await readFile(filePath, "utf-8");
    // Use pathToFileURL to properly URL-encode the file path (handles spaces, unicode, etc.)
    const fileUrl = pathToFileURL(filePath).href;
    const dom = new JSDOM(raw, { url: fileUrl });
    const doc = dom.window.document;

    const metadata: DocMetadata = {
      fileType: "html",
      source: filePath,
    };

    // Extract metadata from HTML head
    const titleEl = doc.querySelector("title");
    if (titleEl?.textContent) metadata.title = titleEl.textContent.trim();

    const metaAuthor = doc.querySelector('meta[name="author"]');
    if (metaAuthor) metadata.author = metaAuthor.getAttribute("content") ?? undefined;

    const metaDate = doc.querySelector('meta[name="date"]') ??
      doc.querySelector('meta[property="article:published_time"]');
    if (metaDate) metadata.date = metaDate.getAttribute("content") ?? undefined;

    // NOTE: Readability.parse() mutates the DOM in-place (removes elements, restructures).
    // Any DOM queries for structure hints should be done BEFORE calling Readability,
    // or use a cloned document.
    const reader = new Readability(doc);
    const article = reader.parse();

    let text: string;
    if (article?.textContent) {
      text = article.textContent.trim();
      if (article.title && !metadata.title) metadata.title = article.title;
    } else {
      // Fallback: extract body text
      text = doc.body?.textContent?.trim() ?? "";
    }

    if (!metadata.title) {
      metadata.title = basename(filePath, ".html");
    }

    // Find headings for structure hints.
    // NOTE: After Readability processes the DOM, the heading structure may be altered
    // or removed. These offsets are approximate — they search the extracted text for
    // heading text matches, which may not align perfectly with the original structure.
    const structure: StructureHint[] = [];
    const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
    let searchFrom = 0;
    for (const heading of headings) {
      const headingText = heading.textContent?.trim() ?? "";
      const level = parseInt(heading.tagName.charAt(1), 10);
      const idx = text.indexOf(headingText, searchFrom);
      if (idx >= 0) {
        structure.push({
          type: "heading",
          level,
          startOffset: idx,
          endOffset: idx + headingText.length,
        });
        searchFrom = idx + headingText.length;
      }
    }

    return { text, structure, metadata };
  } catch (err) {
    logger.error({ filePath, error: String(err) }, "HTML parse failed");
    return {
      text: `[HTML: ${basename(filePath)} — parse failed: ${err instanceof Error ? err.message?.substring(0, 100) : "unknown error"}]`,
      structure: [],
      metadata: { fileType: "html", source: filePath, title: basename(filePath, ".html") },
    };
  }
}
