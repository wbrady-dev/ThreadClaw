/**
 * ePub parser — extracts text content from .epub files.
 *
 * ePub files are ZIP archives containing XHTML content files.
 * This parser extracts all text content chapters in reading order
 * using in-memory zip parsing (adm-zip) — no shell commands, no temp files.
 */

import { basename } from "path";
import AdmZip from "adm-zip";
import type { ParsedDocument, DocMetadata, StructureHint } from "./index.js";

/** Maximum total decompressed size (200 MB) to guard against zip bombs */
const MAX_EPUB_DECOMPRESSED = 200 * 1024 * 1024;

export async function parseEpub(filePath: string): Promise<ParsedDocument> {
  const metadata: DocMetadata = {
    fileType: "epub",
    title: basename(filePath, ".epub"),
    source: filePath,
  };

  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    // Zip bomb protection: check total decompressed size before extracting
    let totalUncompressed = 0;
    for (const e of entries) {
      totalUncompressed += e.header.size;
      if (totalUncompressed > MAX_EPUB_DECOMPRESSED) {
        return {
          text: `[ePub: ${metadata.title} — decompressed size exceeds ${MAX_EPUB_DECOMPRESSED / 1024 / 1024}MB limit]`,
          structure: [],
          metadata,
        };
      }
    }

    // Extract OPF metadata + spine reading order
    const opfEntry = entries.find((e) => e.entryName.endsWith(".opf"));
    const opfDir = opfEntry ? opfEntry.entryName.replace(/[^/]*$/, "") : "";
    const spineOrder: string[] = [];

    if (opfEntry) {
      const opf = opfEntry.getData().toString("utf-8");
      const titleMatch = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
      if (titleMatch) metadata.title = titleMatch[1].trim();
      const authorMatch = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
      if (authorMatch) metadata.author = authorMatch[1].trim();

      // Build manifest id→href map
      const manifestItems = new Map<string, string>();
      const itemRe = /<item\s[^>]*?\bid=["']([^"']+)["'][^>]*?\bhref=["']([^"']+)["'][^>]*?\/?>/gi;
      let m: RegExpExecArray | null;
      while ((m = itemRe.exec(opf)) !== null) {
        manifestItems.set(m[1], m[2]);
      }

      // Parse spine order (itemref idref values)
      const spineRe = /<itemref\s[^>]*?\bidref=["']([^"']+)["'][^>]*?\/?>/gi;
      while ((m = spineRe.exec(opf)) !== null) {
        const href = manifestItems.get(m[1]);
        if (href) spineOrder.push(opfDir + decodeURIComponent(href));
      }
    }

    // Collect HTML/XHTML content entries (exclude TOC files)
    // NOTE: .xml files are included for ePubs that use XML for content chapters.
    // This may incorrectly include package metadata XML files in some edge cases.
    const contentMap = new Map<string, AdmZip.IZipEntry>();
    for (const e of entries) {
      const baseName = (e.entryName.split("/").pop() ?? "").toLowerCase();
      if (
        /\.(x?html?|xml)$/i.test(baseName) &&
        !baseName.startsWith("toc") &&
        !e.isDirectory
      ) {
        contentMap.set(e.entryName, e);
      }
    }

    // Order by spine if available, fall back to filename sort
    let contentEntries: AdmZip.IZipEntry[];
    if (spineOrder.length > 0) {
      // Spine-ordered entries first, then any remaining not in spine
      const ordered: AdmZip.IZipEntry[] = [];
      const used = new Set<string>();
      for (const href of spineOrder) {
        const entry = contentMap.get(href);
        if (entry) { ordered.push(entry); used.add(href); }
      }
      for (const [name, entry] of contentMap) {
        if (!used.has(name)) ordered.push(entry);
      }
      contentEntries = ordered;
    } else {
      contentEntries = [...contentMap.values()].sort((a, b) => a.entryName.localeCompare(b.entryName));
    }

    // Extract text from each content entry
    const chapters: string[] = [];
    const structure: StructureHint[] = [];
    let offset = 0;

    for (const entry of contentEntries) {
      const html = entry.getData().toString("utf-8");
      // Strip HTML tags, keep text
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        // Decode numeric HTML entities (&#NNN;) to their character equivalents
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 10) {
        structure.push({
          type: "section",
          startOffset: offset,
          endOffset: offset + text.length,
        });
        chapters.push(text);
        offset += text.length + 2; // +2 for \n\n separator
      }
    }

    const fullText = chapters.join("\n\n");

    if (!fullText || fullText.length < 10) {
      return { text: `[ePub: ${metadata.title} — no readable text content]`, structure: [], metadata };
    }

    return { text: fullText, structure, metadata };
  } catch (err: any) {
    return {
      text: `[ePub: ${metadata.title} — parse failed: ${err.message?.substring(0, 100) ?? "unknown error"}]`,
      structure: [],
      metadata,
    };
  }
}
