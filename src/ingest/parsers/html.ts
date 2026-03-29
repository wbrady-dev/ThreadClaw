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

    // Extract headings BEFORE Readability mutates the DOM (it removes/restructures elements).
    const preHeadings: Array<{ text: string; level: number }> = [];
    const headingEls = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const heading of headingEls) {
      const headingText = heading.textContent?.trim() ?? "";
      if (headingText) {
        preHeadings.push({
          text: headingText,
          level: parseInt(heading.tagName.charAt(1), 10),
        });
      }
    }

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

    // Build structure hints by searching extracted text for pre-extracted heading text.
    // Offsets are approximate — heading text may appear at different positions in the
    // Readability-cleaned output vs the original DOM.
    const structure: StructureHint[] = [];
    let searchFrom = 0;
    for (const heading of preHeadings) {
      const idx = text.indexOf(heading.text, searchFrom);
      if (idx >= 0) {
        structure.push({
          type: "heading",
          level: heading.level,
          startOffset: idx,
          endOffset: idx + heading.text.length,
        });
        searchFrom = idx + heading.text.length;
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
