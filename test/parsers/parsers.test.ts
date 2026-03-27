import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "fixtures");

// Import parsers directly (not through index to avoid .js extension issues)
import { parsePlaintext } from "../../src/ingest/parsers/plaintext.js";
import { parseMarkdown } from "../../src/ingest/parsers/markdown.js";
import { parseCsv } from "../../src/ingest/parsers/csv.js";
import { parseCode } from "../../src/ingest/parsers/code.js";
import { parseJson } from "../../src/ingest/parsers/json.js";
import { getParser, getSupportedExtensions } from "../../src/ingest/parsers/index.js";

// ─── Plaintext Parser ───────────────────────────────────────────────

describe("parsePlaintext", () => {
  it("returns a ParsedDocument with text and metadata", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "test.txt"));
    expect(doc).toHaveProperty("text");
    expect(doc).toHaveProperty("metadata");
    expect(doc).toHaveProperty("structure");
  });

  it("extracts full text content", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "test.txt"));
    expect(doc.text).toContain("Hello world");
    expect(doc.text).toContain("Second paragraph here.");
  });

  it("sets fileType to plaintext", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "test.txt"));
    expect(doc.metadata.fileType).toBe("plaintext");
  });

  it("sets title to filename", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "test.txt"));
    expect(doc.metadata.title).toBe("test.txt");
  });

  it("sets source to file path", async () => {
    const fp = resolve(fixtures, "test.txt");
    const doc = await parsePlaintext(fp);
    expect(doc.metadata.source).toBe(fp);
  });

  it("returns empty structure array", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "test.txt"));
    expect(doc.structure).toEqual([]);
  });

  it("handles empty file", async () => {
    const doc = await parsePlaintext(resolve(fixtures, "empty.txt"));
    expect(doc.text).toBe("");
    expect(doc.metadata.fileType).toBe("plaintext");
  });
});

// ─── Markdown Parser ────────────────────────────────────────────────

describe("parseMarkdown", () => {
  it("returns a ParsedDocument with text and metadata", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "test.md"));
    expect(doc).toHaveProperty("text");
    expect(doc).toHaveProperty("metadata");
    expect(doc).toHaveProperty("structure");
  });

  it("extracts text content", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "test.md"));
    expect(doc.text).toContain("Title");
    expect(doc.text).toContain("Some content");
    expect(doc.text).toContain("Section 2");
    expect(doc.text).toContain("More content");
  });

  it("sets fileType to markdown", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "test.md"));
    expect(doc.metadata.fileType).toBe("markdown");
  });

  it("extracts title from first heading", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "test.md"));
    expect(doc.metadata.title).toBe("Title");
  });

  it("detects heading structure hints", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "test.md"));
    const headings = doc.structure.filter((s) => s.type === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(2);
    // First heading is level 1
    expect(headings[0].level).toBe(1);
    // Second heading is level 2
    expect(headings[1].level).toBe(2);
  });

  it("handles empty file", async () => {
    const doc = await parseMarkdown(resolve(fixtures, "empty.md"));
    expect(doc.text).toBe("");
    expect(doc.metadata.fileType).toBe("markdown");
  });
});

// ─── CSV Parser ─────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("returns a ParsedDocument with text and metadata", async () => {
    const doc = await parseCsv(resolve(fixtures, "test.csv"));
    expect(doc).toHaveProperty("text");
    expect(doc).toHaveProperty("metadata");
    expect(doc).toHaveProperty("structure");
  });

  it("extracts text with headers and rows", async () => {
    const doc = await parseCsv(resolve(fixtures, "test.csv"));
    expect(doc.text).toContain("name");
    expect(doc.text).toContain("age");
    expect(doc.text).toContain("city");
    expect(doc.text).toContain("Alice");
    expect(doc.text).toContain("30");
    expect(doc.text).toContain("NYC");
    expect(doc.text).toContain("Bob");
  });

  it("sets fileType to csv", async () => {
    const doc = await parseCsv(resolve(fixtures, "test.csv"));
    expect(doc.metadata.fileType).toBe("csv");
  });

  it("sets title to filename", async () => {
    const doc = await parseCsv(resolve(fixtures, "test.csv"));
    expect(doc.metadata.title).toBe("test.csv");
  });

  it("includes table structure hint", async () => {
    const doc = await parseCsv(resolve(fixtures, "test.csv"));
    const tables = doc.structure.filter((s) => s.type === "table");
    expect(tables.length).toBe(1);
  });

  it("handles empty file", async () => {
    const doc = await parseCsv(resolve(fixtures, "empty.csv"));
    expect(doc.text).toBe("");
    expect(doc.metadata.fileType).toBe("csv");
  });
});

// ─── JSON Parser ────────────────────────────────────────────────────

describe("parseJson", () => {
  it("returns a ParsedDocument with text and metadata", async () => {
    const doc = await parseJson(resolve(fixtures, "test.json"));
    expect(doc).toHaveProperty("text");
    expect(doc).toHaveProperty("metadata");
    expect(doc).toHaveProperty("structure");
  });

  it("extracts flattened key-value text", async () => {
    const doc = await parseJson(resolve(fixtures, "test.json"));
    expect(doc.text).toContain("title");
    expect(doc.text).toContain("Test");
    expect(doc.text).toContain("content");
    expect(doc.text).toContain("JSON document");
  });

  it("sets fileType to json", async () => {
    const doc = await parseJson(resolve(fixtures, "test.json"));
    expect(doc.metadata.fileType).toBe("json");
  });

  it("sets title to filename", async () => {
    const doc = await parseJson(resolve(fixtures, "test.json"));
    expect(doc.metadata.title).toBe("test.json");
  });

  it("returns empty structure array", async () => {
    const doc = await parseJson(resolve(fixtures, "test.json"));
    expect(doc.structure).toEqual([]);
  });

  it("handles empty file gracefully", async () => {
    const doc = await parseJson(resolve(fixtures, "empty.json"));
    // Empty string gets passed through as raw text since JSON.parse fails
    expect(doc.metadata.fileType).toBe("json");
  });
});

// ─── Code Parser ────────────────────────────────────────────────────

describe("parseCode", () => {
  it("returns a ParsedDocument with text and metadata", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc).toHaveProperty("text");
    expect(doc).toHaveProperty("metadata");
    expect(doc).toHaveProperty("structure");
  });

  it("extracts full source code as text", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc.text).toContain("function hello()");
    expect(doc.text).toContain("return 'world'");
    expect(doc.text).toContain("class Foo");
  });

  it("sets fileType to code", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc.metadata.fileType).toBe("code");
  });

  it("sets title to filename", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc.metadata.title).toBe("test.js");
  });

  it("tags with detected language", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc.metadata.tags).toContain("javascript");
  });

  it("detects function and class definitions in structure", async () => {
    const doc = await parseCode(resolve(fixtures, "test.js"));
    expect(doc.structure.length).toBeGreaterThanOrEqual(1);
    // Should detect at least the function or class
    const types = doc.structure.map((s) => s.type);
    expect(types).toContain("heading");
  });

  it("handles empty file", async () => {
    const doc = await parseCode(resolve(fixtures, "empty.js"));
    expect(doc.text).toBe("");
    expect(doc.metadata.fileType).toBe("code");
  });
});

// TODO: Missing parser tests for: pdf (pdfjs-dist), docx (mammoth), html (jsdom/readability),
// eml (mailparser), epub, xlsx. Add fixtures and basic smoke tests for each.

// ─── Error Paths ────────────────────────────────────────────────────

describe("Parser error handling", () => {
  it("throws for nonexistent file", async () => {
    await expect(parsePlaintext("/nonexistent/file.txt")).rejects.toThrow();
  });
});

// ─── Parser Registry ────────────────────────────────────────────────

describe("getParser / getSupportedExtensions", () => {
  it("returns a parser function for .txt", () => {
    const parser = getParser("doc.txt");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser function for .md", () => {
    const parser = getParser("doc.md");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser function for .csv", () => {
    const parser = getParser("data.csv");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser function for .json", () => {
    const parser = getParser("data.json");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser function for .js", () => {
    const parser = getParser("code.js");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser for .html", () => {
    const parser = getParser("page.html");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser for .py", () => {
    const parser = getParser("script.py");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser for .ts", () => {
    const parser = getParser("module.ts");
    expect(typeof parser).toBe("function");
  });

  it("returns a parser for .eml", () => {
    const parser = getParser("mail.eml");
    expect(typeof parser).toBe("function");
  });

  it("throws for unsupported extension", () => {
    expect(() => getParser("file.xyz")).toThrow();
  });

  it("lists supported extensions", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain(".txt");
    expect(exts).toContain(".md");
    expect(exts).toContain(".csv");
    expect(exts).toContain(".json");
    expect(exts).toContain(".js");
    expect(exts).toContain(".ts");
    expect(exts).toContain(".py");
  });
});
