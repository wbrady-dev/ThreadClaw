import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".sh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".lua": "lua",
  ".r": "r",
  ".scala": "scala",
};

// Regex patterns for function/class definitions by language
const DEFINITION_PATTERNS: Record<string, RegExp> = {
  javascript: /^(?:export\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\(|function))|^(?:export\s+)?class\s+\w+/gm,
  typescript: /^(?:export\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\(|function))|^(?:export\s+)?(?:abstract\s+)?class\s+\w+|^(?:export\s+)?interface\s+\w+/gm,
  python: /^(?:async\s+)?(?:def|class)\s+\w+/gm,
  go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+/gm,
  rust: /^(?:pub\s+)?(?:async\s+)?fn\s+\w+|^(?:pub\s+)?struct\s+\w+|^(?:pub\s+)?enum\s+\w+|^impl\s+/gm,
  // Limit repetition groups to prevent catastrophic backtracking on pathological inputs
  java: /^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+\w+|^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+){1,5}\w+\s*\(/gm,
  c: /^(?:\w+\s+){1,5}\w+\s*\([^)]{0,200}\)\s*\{/gm,
  cpp: /^(?:class|struct)\s+\w+|^(?:\w+\s+){1,5}\w+\s*\([^)]{0,200}\)\s*(?:const\s*)?\{/gm,
  ruby: /^(?:class|module|def)\s+(\w+)/gm,
  php: /^(?:class|function|interface|trait)\s+(\w+)/gm,
  swift: /^(?:class|struct|enum|protocol|func)\s+(\w+)/gm,
  kotlin: /^(?:class|fun|object|interface)\s+(\w+)/gm,
  csharp: /^(?:class|struct|interface|enum|void|static\s+\w+)\s+(\w+)/gm,
  bash: /^(?:function\s+)?(\w+)\s*\(\)/gm,
  powershell: /^function\s+(\w[\w-]*)/gim,
  sql: /^CREATE\s+(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE)\s+\w+/gim,
  lua: /^(?:local\s+)?function\s+(\w+)/gm,
  r: /^(\w+)\s*<-\s*function/gm,
  scala: /^(?:class|object|trait|def)\s+(\w+)/gm,
};

/**
 * Parse source code files with language-aware structure detection.
 *
 * NOTE: No size guard here — the pipeline-level MAX_FILE_SIZE check handles this.
 * For very large source files (e.g., generated code), the structure detection
 * regex patterns may be slow. Consider adding a file-level size check if needed.
 */
export async function parseCode(filePath: string): Promise<ParsedDocument> {
  const text = await readFile(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  const language = LANG_MAP[ext] ?? "unknown";

  const structure: StructureHint[] = [];

  // Find function/class definitions
  // Clone per-call to avoid shared lastIndex state across concurrent calls
  const basePattern = DEFINITION_PATTERNS[language];

  if (basePattern) {
    const pattern = new RegExp(basePattern.source, basePattern.flags);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      structure.push({
        type: "heading",
        level: match[0].includes("class") || match[0].includes("struct") ||
          match[0].includes("interface") || match[0].includes("impl")
          ? 1 : 2,
        language,
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    }
  }

  const metadata: DocMetadata = {
    fileType: "code",
    title: basename(filePath),
    source: filePath,
    tags: [language],
  };

  return { text, structure, metadata };
}

export function isCodeFile(ext: string): boolean {
  return ext.toLowerCase() in LANG_MAP;
}
