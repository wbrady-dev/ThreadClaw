import { describe, it, expect } from "vitest";
import { chunkProse } from "../../src/ingest/chunker/strategies/prose.js";
import { chunkMarkdown } from "../../src/ingest/chunker/strategies/markdown.js";
import type { StructureHint } from "../../src/ingest/parsers/index.js";

// TODO: Add chunking strategy tests for: code, table, html.
// These strategies exist in src/ingest/chunker/strategies/ but have zero test coverage.

// ─── Prose Chunking ─────────────────────────────────────────────────

describe("chunkProse", () => {
  it("splits text on paragraph boundaries", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    // Use a small target so each paragraph is its own chunk
    const chunks = chunkProse(text, 5, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk text should be a paragraph or group of paragraphs
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("merges small paragraphs up to target token count", () => {
    const text = "A.\n\nB.\n\nC.";
    // Large target: all paragraphs should merge into one chunk
    const chunks = chunkProse(text, 1000, 2000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("A.");
    expect(chunks[0].text).toContain("B.");
    expect(chunks[0].text).toContain("C.");
  });

  it("returns empty array for empty text", () => {
    const chunks = chunkProse("", 512, 1024);
    expect(chunks).toEqual([]);
  });

  it("returns empty array for whitespace-only text", () => {
    const chunks = chunkProse("   \n\n   ", 512, 1024);
    expect(chunks).toEqual([]);
  });

  it("assigns sequential positions", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: ${"word ".repeat(50)}`
    ).join("\n\n");
    const chunks = chunkProse(paragraphs, 30, 60);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].position).toBe(i);
    }
  });

  it("sets tokenCount on each chunk", () => {
    const text = "Hello world this is a test.\n\nAnother paragraph with more content.";
    const chunks = chunkProse(text, 500, 1000);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("handles a single large paragraph by splitting on sentences", () => {
    // Create a paragraph that exceeds maxTokens (using ~4 chars per token heuristic)
    const longSentences = Array.from({ length: 20 }, (_, i) =>
      `This is sentence number ${i} with enough words to have significant token count.`
    ).join(" ");
    // maxTokens = 50 is low enough to force sentence splitting
    const chunks = chunkProse(longSentences, 30, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("chunks do not have identical content (no full overlap)", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) =>
      `Paragraph ${i}: ${"word ".repeat(40)}`
    ).join("\n\n");
    const chunks = chunkProse(paragraphs, 30, 60);
    // Verify no two adjacent chunks are identical
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].text).not.toBe(chunks[i - 1].text);
    }
  });
});

// ─── Markdown Chunking ──────────────────────────────────────────────

describe("chunkMarkdown", () => {
  const mdText = "# Title\n\nIntro content here.\n\n## Section A\n\nSection A content.\n\n## Section B\n\nSection B content.";

  function makeStructure(text: string): StructureHint[] {
    const hints: StructureHint[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(text)) !== null) {
      hints.push({
        type: "heading",
        level: match[1].length,
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    }
    return hints;
  }

  it("splits on heading boundaries", () => {
    const structure = makeStructure(mdText);
    const chunks = chunkMarkdown(mdText, structure, 2000);
    // Should have chunks for: Title section, Section A, Section B
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("includes heading text in chunk content", () => {
    const structure = makeStructure(mdText);
    const chunks = chunkMarkdown(mdText, structure, 2000);
    const allText = chunks.map((c) => c.text).join(" ");
    expect(allText).toContain("Title");
    expect(allText).toContain("Section A");
    expect(allText).toContain("Section B");
  });

  it("sets contextPrefix with heading chain", () => {
    const structure = makeStructure(mdText);
    const chunks = chunkMarkdown(mdText, structure, 2000);
    // Find a chunk for Section A - should have context prefix
    const sectionAChunk = chunks.find((c) => c.text.includes("Section A content"));
    expect(sectionAChunk).toBeDefined();
    // Assert contextPrefix exists and contains expected heading — do not silently skip
    expect(sectionAChunk!.contextPrefix).toBeDefined();
    expect(sectionAChunk!.contextPrefix).toContain("Section A");
  });

  it("assigns sequential positions", () => {
    const structure = makeStructure(mdText);
    const chunks = chunkMarkdown(mdText, structure, 2000);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].position).toBe(i);
    }
  });

  it("sets tokenCount on each chunk", () => {
    const structure = makeStructure(mdText);
    const chunks = chunkMarkdown(mdText, structure, 2000);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("returns single chunk when no headings present", () => {
    const plainText = "Just some plain text with no headings at all.";
    const chunks = chunkMarkdown(plainText, [], 2000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe(plainText);
  });

  it("handles nested headings in context prefix", () => {
    const nested = "# Top\n\nTop content.\n\n## Mid\n\nMid content.\n\n### Deep\n\nDeep content.";
    const structure = makeStructure(nested);
    const chunks = chunkMarkdown(nested, structure, 2000);
    const deepChunk = chunks.find((c) => c.text.includes("Deep content"));
    expect(deepChunk).toBeDefined();
    // Assert contextPrefix exists — do not silently skip
    expect(deepChunk!.contextPrefix).toBeDefined();
    expect(deepChunk!.contextPrefix).toContain("Top");
    expect(deepChunk!.contextPrefix).toContain("Mid");
    expect(deepChunk!.contextPrefix).toContain("Deep");
  });
});
