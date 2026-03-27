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
  // NOTE: Delimiter detection uses the first line only, which may be inaccurate
  // for CSV files with quoted fields containing commas or tabs.
  const delimiter = detectDelimiter(filePath, raw);

  let records: Record<string, string>[];
  try {
    records = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter,
    }) as Record<string, string>[];
  } catch (err) {
    return {
      text: raw.slice(0, 5000), // Fall back to raw text on parse failure
      structure: [],
      metadata: { fileType: delimiter === "\t" ? "tsv" : "csv", title: basename(filePath), source: filePath },
    };
  }

  if (records.length === 0) {
    return {
      text: "",
      structure: [],
      metadata: { fileType: delimiter === "\t" ? "tsv" : "csv", title: basename(filePath), source: filePath },
    };
  }

  // NOTE: Object.keys(records[0]) depends on the first row having all columns.
  // Rows with more columns than the header will have extra columns silently dropped
  // due to relax_column_count. This is a known limitation of the columns: true mode.
  const headers = Object.keys(records[0]);
  const headerLine = headers.join(" | ");
  const lines: string[] = [headerLine, "-".repeat(headerLine.length)];

  for (const record of records) {
    lines.push(headers.map((h) => record[h] ?? "").join(" | "));
  }

  const text = lines.join("\n");

  // Mark table regions for chunking (groups of ~20 rows)
  // NOTE: A single structure hint covers the entire table. Enhancement: detect
  // logical sections (e.g., by blank rows or category columns) for smarter chunking.
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
