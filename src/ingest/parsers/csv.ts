import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { parse } from "csv-parse/sync";
import type { ParsedDocument, StructureHint, DocMetadata } from "./index.js";

/**
 * Detect delimiter: use tab for .tsv files or when the first line contains
 * more tabs than commas.
 */
function detectDelimiter(filePath: string, raw: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".tsv") return "\t";

  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  if (tabs > commas) return "\t";

  return ",";
}

/**
 * Parse CSV/TSV files. Converts to a text representation with headers.
 * Structure hints mark row groups for table chunking.
 */
export async function parseCsv(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, "utf-8");
  const delimiter = detectDelimiter(filePath, raw);

  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter,
  }) as Record<string, string>[];

  if (records.length === 0) {
    return {
      text: "",
      structure: [],
      metadata: { fileType: delimiter === "\t" ? "tsv" : "csv", title: basename(filePath), source: filePath },
    };
  }

  const headers = Object.keys(records[0]);
  const headerLine = headers.join(" | ");
  const lines: string[] = [headerLine, "-".repeat(headerLine.length)];

  for (const record of records) {
    lines.push(headers.map((h) => record[h] ?? "").join(" | "));
  }

  const text = lines.join("\n");

  // Mark table regions for chunking (groups of ~20 rows)
  const structure: StructureHint[] = [{
    type: "table",
    startOffset: 0,
    endOffset: text.length,
  }];

  const metadata: DocMetadata = {
    fileType: delimiter === "\t" ? "tsv" : "csv",
    title: basename(filePath),
    source: filePath,
  };

  return { text, structure, metadata };
}
