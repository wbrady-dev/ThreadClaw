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
import { ParseError } from "../../utils/errors.js";
import { extname } from "path";

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
function getDoclingWrapper(ext: string): Parser {
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

export function getParser(filePath: string): Parser {
  const ext = extname(filePath).toLowerCase();

  // Check if it's a code file via LANG_MAP (avoids maintaining duplicate lists)
  if (isCodeFile(ext) && !PARSER_MAP[ext]) {
    PARSER_MAP[ext] = parseCode;
  }

  // For complex document formats, try Docling first (layout-aware, multi-language)
  // Falls back to local parser if Docling is unavailable
  if (DOCLING_PREFERRED.has(ext)) {
    return getDoclingWrapper(ext);
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
