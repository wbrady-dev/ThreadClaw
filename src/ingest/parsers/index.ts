import { parseMarkdown } from "./markdown.js";
import { parsePlaintext } from "./plaintext.js";
import { parsePdf } from "./pdf.js";
import { parseHtml } from "./html.js";
import { parseCsv } from "./csv.js";
import { parseCode } from "./code.js";
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

  // Code
  ".js": parseCode,
  ".jsx": parseCode,
  ".ts": parseCode,
  ".tsx": parseCode,
  ".py": parseCode,
  ".go": parseCode,
  ".rs": parseCode,
  ".c": parseCode,
  ".cpp": parseCode,
  ".h": parseCode,
  ".hpp": parseCode,
  ".java": parseCode,
  ".rb": parseCode,
  ".php": parseCode,
  ".swift": parseCode,
  ".kt": parseCode,
  ".cs": parseCode,
  ".sh": parseCode,
  ".ps1": parseCode,

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
  ".yaml": parsePlaintext,
  ".yml": parsePlaintext,
  ".toml": parsePlaintext,
  ".xml": parsePlaintext,
};

// File types that benefit from Docling's layout-aware parsing
const DOCLING_PREFERRED = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

export function getParser(filePath: string): Parser {
  const ext = extname(filePath).toLowerCase();

  // For complex document formats, try Docling first (layout-aware, multi-language)
  // Falls back to local parser if Docling is unavailable
  if (DOCLING_PREFERRED.has(ext)) {
    return async (fp: string) => {
      const { parseWithDocling } = await import("./docling.js");
      const result = await parseWithDocling(fp);
      if (result) return result;

      // Fallback to local parser
      const localParser = PARSER_MAP[ext];
      if (localParser) return localParser(fp);
      throw new ParseError(`Unsupported file type: ${ext}`, fp);
    };
  }

  const parser = PARSER_MAP[ext];
  if (!parser) {
    throw new ParseError(`Unsupported file type: ${ext}`, filePath);
  }
  return parser;
}

export function getSupportedExtensions(): string[] {
  return [...new Set([...Object.keys(PARSER_MAP), ...DOCLING_PREFERRED])];
}
