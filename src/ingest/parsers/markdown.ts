import { readFile } from "fs/promises";
import { basename } from "path";
import { load as yamlLoad } from "js-yaml";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

/**
 * Parse markdown files with full Obsidian awareness.
 *
 * Extracts:
 * - YAML frontmatter (all properties via js-yaml, with regex fallback)
 * - Wikilinks: [[Note]], [[Note|Display]], [[Note#heading]] (skips embeds ![[...]])
 * - Inline tags: #tag, #nested/tag (skips headings)
 * - Block references: ^block-id
 * - Heading structure and code blocks
 * - Strips dataview/dataviewjs/tasks code blocks (dynamic queries, not content)
 */
export async function parseMarkdown(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, "utf-8");
  const structure: StructureHint[] = [];
  let text = raw;
  const metadata: DocMetadata = { fileType: "markdown" };

  // ── YAML Frontmatter ──────────────────────────────────────────────
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmMatch) {
    text = raw.slice(fmMatch[0].length);
    extractFrontmatter(fmMatch[1], metadata);
  }

  // ── Strip dataview/dataviewjs/tasks blocks FIRST ───────────────────
  // These are dynamic Obsidian queries, not content. Remove before
  // building code block ranges so all offsets are consistent.
  const dvRegex = /^```(?:dataview|dataviewjs|tasks)\r?\n[\s\S]*?\r?\n\s*```$/gm;
  let dvMatch;
  const dvBlocks: { start: number; end: number }[] = [];
  while ((dvMatch = dvRegex.exec(text)) !== null) {
    dvBlocks.push({ start: dvMatch.index, end: dvMatch.index + dvMatch[0].length });
  }
  // Remove in reverse order to preserve earlier offsets
  for (let i = dvBlocks.length - 1; i >= 0; i--) {
    text = text.slice(0, dvBlocks[i].start) + text.slice(dvBlocks[i].end);
  }

  // ── Code block ranges (on the now-clean text) ─────────────────────
  const codeBlockRegex = /^```(\w*)\r?\n[\s\S]*?\r?\n\s*```$/gm;
  let match;
  const codeBlockRanges: { start: number; end: number }[] = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlockRanges.push({ start: match.index, end: match.index + match[0].length });
    structure.push({
      type: "code_block",
      language: match[1] || undefined,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  const isInsideCodeBlock = (pos: number): boolean =>
    codeBlockRanges.some((r) => pos >= r.start && pos <= r.end);

  // ── Headings (skip inside code blocks) ────────────────────────────
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  while ((match = headingRegex.exec(text)) !== null) {
    if (isInsideCodeBlock(match.index)) continue;
    structure.push({
      type: "heading",
      level: match[1].length,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // ── Wikilinks (skip embeds ![[...]] and code blocks) ──────────────
  // Captures: [[Note Name]], [[Note Name|Display]], [[Note#heading|Display]]
  // Skips: ![[image.png]] (embeds)
  const wikilinkRegex = /(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
  const links: Array<{ target: string; display?: string }> = [];
  while ((match = wikilinkRegex.exec(text)) !== null) {
    if (isInsideCodeBlock(match.index)) continue;
    const target = match[1].trim();
    const display = match[2]?.trim();
    if (target) {
      links.push({ target, ...(display ? { display } : {}) });
    }
  }
  if (links.length > 0) metadata.links = links;

  // ── Inline tags (skip headings and code blocks) ───────────────────
  // Matches #tag and #nested/tag, requires whitespace or line start before #
  const inlineTags: string[] = [];
  const tagRegex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
  while ((match = tagRegex.exec(text)) !== null) {
    if (isInsideCodeBlock(match.index)) continue;
    inlineTags.push(match[1]);
  }

  // Merge inline tags with frontmatter tags, deduplicate
  if (inlineTags.length > 0) {
    const existing = metadata.tags ?? [];
    metadata.tags = [...new Set([...existing, ...inlineTags])];
  }

  // ── Block references ──────────────────────────────────────────────
  const blockRefRegex = /\^([a-zA-Z0-9-]+)\s*$/gm;
  const blockRefs: string[] = [];
  while ((match = blockRefRegex.exec(text)) !== null) {
    if (isInsideCodeBlock(match.index)) continue;
    blockRefs.push(match[1]);
  }
  if (blockRefs.length > 0) metadata.blockRefs = blockRefs;

  // ── Title fallback ────────────────────────────────────────────────
  if (!metadata.title) {
    const firstHeading = structure.find((s) => s.type === "heading");
    if (firstHeading) {
      const headingText = text.slice(firstHeading.startOffset, firstHeading.endOffset);
      metadata.title = headingText.replace(/^#+\s+/, "");
    } else {
      metadata.title = basename(filePath).replace(/\.[^.]+$/, "");
    }
  }

  metadata.source = filePath;
  return { text, structure, metadata };
}

/**
 * Extract metadata from YAML frontmatter.
 * Uses js-yaml for robust parsing, falls back to regex on failure.
 */
function extractFrontmatter(yamlStr: string, metadata: DocMetadata): void {
  // Try js-yaml first (handles all YAML formats correctly)
  try {
    const parsed = yamlLoad(yamlStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fm = parsed as Record<string, unknown>;

      // Store full frontmatter for Obsidian-aware consumers
      metadata.frontmatter = fm;

      // Known fields
      if (typeof fm.title === "string") metadata.title = fm.title;
      else if (typeof fm.title === "number") metadata.title = String(fm.title);

      if (typeof fm.author === "string") metadata.author = fm.author;

      if (fm.date != null) {
        metadata.date = fm.date instanceof Date ? fm.date.toISOString() : String(fm.date);
      }

      // Tags: handle both [a, b] and - a\n- b (js-yaml normalizes both to arrays)
      if (Array.isArray(fm.tags)) {
        metadata.tags = fm.tags
          .map((t: unknown) => String(t).trim())
          .filter((t: string) => t.length > 0);
      } else if (typeof fm.tags === "string") {
        metadata.tags = fm.tags.split(",").map((t) => t.trim()).filter(Boolean);
      }

      // Aliases (Obsidian-specific)
      if (Array.isArray(fm.aliases)) {
        metadata.aliases = fm.aliases
          .map((a: unknown) => String(a).trim())
          .filter((a: string) => a.length > 0);
      } else if (typeof fm.aliases === "string") {
        metadata.aliases = [fm.aliases.trim()].filter(Boolean);
      }

      return; // Success — skip regex fallback
    }
  } catch {
    // js-yaml failed (malformed YAML) — fall through to regex
  }

  // Regex fallback (original parser logic — handles non-strict YAML)
  const titleMatch = yamlStr.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const authorMatch = yamlStr.match(/^author:\s*["']?(.+?)["']?\s*$/m);
  const dateMatch = yamlStr.match(/^date:\s*["']?(.+?)["']?\s*$/m);
  const tagsMatch = yamlStr.match(/^tags:\s*\[(.+?)\]/m);

  if (titleMatch) metadata.title = titleMatch[1];
  if (authorMatch) metadata.author = authorMatch[1];
  if (dateMatch) metadata.date = dateMatch[1];
  if (tagsMatch) {
    metadata.tags = tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, ""));
  }
}
