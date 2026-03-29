import { parseMarkdown } from "./markdown.js";
import { parsePlaintext } from "./plaintext.js";
import { parsePdf } from "./pdf.js";
import { parseHtml } from "./html.js";
import { parseCsv } from "./csv.js";
import { parseCode, isCodeFile } from "./code.js";
import { parseJson } from "./json.js";
import { parseEml } from "./eml.js";
import { parseDocx } from "./docx.js";
import { parsePptx } from "./pptx.js";
import { parseImage } from "./image.js";
import { parseEpub } from "./epub.js";
import { parseAudio } from "./audio.js";
import { parseCanvas } from "./canvas.js";
import { ParseError } from "../../utils/errors.js";
import { extname } from "path";
import { openSync, readSync, closeSync } from "fs";
import { logger } from "../../utils/logger.js";

export interface StructureHint {
  type: "heading" | "code_block" | "table" | "page_break" | "section";
  level?: number;
  language?: string;
  startOffset: number;
  endOffset: number;
}

export interface DocMetadata {
  title?: string;
  author?: string;
  date?: string;
  source?: string;
  fileType: string;
  tags?: string[];
  /** Obsidian: alternative names for this note */
  aliases?: string[];
  /** Obsidian: wikilinks found in the document */
  links?: Array<{ target: string; display?: string; resolvedPath?: string }>;
  /** Obsidian: block reference IDs (^block-id) */
  blockRefs?: string[];
  /** Full YAML frontmatter (all properties, including custom) */
  frontmatter?: Record<string, unknown>;
}

export interface ParsedDocument {
  text: string;
  structure: StructureHint[];
  metadata: DocMetadata;
}

export type Parser = (filePath: string) => Promise<ParsedDocument>;

const PARSER_MAP: Record<string, Parser> = {
  // Markdown
  ".md": parseMarkdown,
  ".markdown": parseMarkdown,
  ".mdx": parseMarkdown,

  // PDF
  ".pdf": parsePdf,

  // HTML
  ".html": parseHtml,
  ".htm": parseHtml,

  // CSV
  ".csv": parseCsv,
  ".tsv": parseCsv,

  // JSON
  ".json": parseJson,
  ".jsonl": parseJson,

  // Email
  ".eml": parseEml,

  // Office Documents
  ".docx": parseDocx,
  ".pptx": parsePptx,
  // .xlsx requires Docling (layout-aware parser) — no local fallback for binary Excel format

  // Code — use LANG_MAP keys dynamically to avoid duplication
  // (isCodeFile checks LANG_MAP internally)

  // Images (OCR via Tesseract)
  ".png": parseImage,
  ".jpg": parseImage,
  ".jpeg": parseImage,
  ".gif": parseImage,
  ".webp": parseImage,
  ".bmp": parseImage,
  ".tiff": parseImage,
  ".tif": parseImage,

  // ePub
  ".epub": parseEpub,

  // Obsidian Canvas
  ".canvas": parseCanvas,

  // Audio (opt-in, requires Whisper)
  ".mp3": parseAudio,
  ".wav": parseAudio,
  ".m4a": parseAudio,
  ".ogg": parseAudio,
  ".flac": parseAudio,
  ".webm": parseAudio,

  // Plain text
  ".txt": parsePlaintext,
  ".log": parsePlaintext,
  ".cfg": parsePlaintext,
  ".ini": parsePlaintext,
  // NOTE: YAML and XML are routed to plaintext. A future enhancement could add
  // structure-aware parsing for these formats.
  ".yaml": parsePlaintext,
  ".yml": parsePlaintext,
  ".toml": parsePlaintext,
  ".xml": parsePlaintext,
};

// Register code extensions from LANG_MAP to avoid maintaining two lists
// (code.ts is the source of truth for supported code languages)
const CODE_EXTENSIONS = [
  ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".c", ".cpp",
  ".h", ".hpp", ".java", ".rb", ".php", ".swift", ".kt", ".cs",
  ".sh", ".ps1", ".sql", ".lua", ".r", ".scala",
];
for (const ext of CODE_EXTENSIONS) {
  if (!PARSER_MAP[ext]) PARSER_MAP[ext] = parseCode;
}

// File types that benefit from Docling's layout-aware parsing
const DOCLING_PREFERRED = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

// Cache the Docling wrapper function to avoid creating a new closure per call
let _doclingWrapper: Parser | null = null;
function getDoclingWrapper(): Parser {
  if (_doclingWrapper) return _doclingWrapper;
  _doclingWrapper = async (fp: string) => {
    const { parseWithDocling } = await import("./docling.js");
    const result = await parseWithDocling(fp);
    if (result) return result;

    // Fallback to local parser
    const localExt = extname(fp).toLowerCase();
    const localParser = PARSER_MAP[localExt];
    if (localParser) return localParser(fp);
    throw new ParseError(`Unsupported file type: ${localExt}`, fp);
  };
  return _doclingWrapper;
}

/**
 * Read the first N bytes of a file for magic-byte validation.
 * Returns empty buffer on any error (file missing, permission denied, etc.).
 */
function readMagicBytes(filePath: string, count: number): Buffer {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(count);
      readSync(fd, buf, 0, count, 0);
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

/** Extensions that require magic-byte validation */
const MAGIC_BYTE_CHECKS: Record<string, { bytes: Buffer; label: string }> = {
  ".pdf": { bytes: Buffer.from("%PDF-", "ascii"), label: "PDF" },
  ".docx": { bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: "ZIP (DOCX)" },
  ".pptx": { bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: "ZIP (PPTX)" },
  ".epub": { bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: "ZIP (EPUB)" },
  ".xlsx": { bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: "ZIP (XLSX)" },
};

/**
 * Validate file magic bytes match the expected format for the extension.
 * Returns true if valid or if no check is defined for this extension.
 */
function validateMagicBytes(filePath: string, ext: string): boolean {
  const check = MAGIC_BYTE_CHECKS[ext];
  if (!check) return true; // No check defined — allow

  const header = readMagicBytes(filePath, check.bytes.length);
  if (header.length === 0) return true; // Can't read — let parser handle the error

  if (!header.subarray(0, check.bytes.length).equals(check.bytes)) {
    logger.warn(
      { filePath, expectedFormat: check.label },
      `Magic bytes mismatch: extension is ${ext} but file header doesn't match ${check.label} format — skipping`,
    );
    return false;
  }
  return true;
}

export function getParser(filePath: string): Parser {
  const ext = extname(filePath).toLowerCase();

  // Check if it's a code file via LANG_MAP (avoids maintaining duplicate lists)
  if (isCodeFile(ext) && !PARSER_MAP[ext]) {
    PARSER_MAP[ext] = parseCode;
  }

  // Magic-byte validation for binary formats — prevent misrouted renamed files
  if (!validateMagicBytes(filePath, ext)) {
    throw new ParseError(`Magic bytes don't match extension ${ext}`, filePath);
  }

  // For complex document formats, try Docling first (layout-aware, multi-language)
  // Falls back to local parser if Docling is unavailable
  if (DOCLING_PREFERRED.has(ext)) {
    return getDoclingWrapper();
  }

  const parser = PARSER_MAP[ext];
  if (!parser) {
    throw new ParseError(`Unsupported file type: ${ext}`, filePath);
  }
  return parser;
}

export function getSupportedExtensions(): string[] {
  // Exclude .xlsx from supported extensions when Docling is the only parser for it
  // (no local fallback exists for binary Excel format)
  const doclingOnly = new Set([".xlsx"]);
  const allExts = new Set([...Object.keys(PARSER_MAP), ...DOCLING_PREFERRED]);
  return [...allExts].filter((ext) => !doclingOnly.has(ext) || PARSER_MAP[ext]);
}
