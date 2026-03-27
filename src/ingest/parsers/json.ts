import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { logger } from "../../utils/logger.js";
import type { ParsedDocument, DocMetadata } from "./index.js";

/**
 * Parse JSON/JSONL files. Flattens structure into readable text.
 */
export async function parseJson(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, "utf-8");
  const metadata: DocMetadata = {
    fileType: "json",
    title: basename(filePath),
    source: filePath,
  };

  let text: string;

  // Use case-insensitive extension check for JSONL detection
  if (extname(filePath).toLowerCase() === ".jsonl") {
    // JSONL: each line is a JSON object
    const lines = raw.split("\n").filter((l) => l.trim());
    const parts: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        parts.push(flattenObject(obj));
      } catch {
        parts.push(line);
      }
    }
    text = parts.join("\n\n");
  } else {
    // Regular JSON
    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) {
        // NOTE: Mixed arrays with both objects and primitives will lose primitive values
        // because flattenObject returns them as bare strings. Consider wrapping primitives
        // in a labeled format (e.g., "value: <primitive>") for better readability.
        text = obj.map((item) => flattenObject(item)).join("\n\n");
      } else {
        text = flattenObject(obj);
      }
    } catch (err) {
      // Malformed JSON — return raw text but log a warning
      logger.warn({ filePath, error: String(err) }, "Malformed JSON, falling back to raw text");
      text = raw;
    }
  }

  return { text, structure: [], metadata };
}

function flattenObject(obj: unknown, prefix = ""): string {
  if (obj === null) return prefix ? `${prefix}: null` : "null";
  if (obj === undefined) return "";
  if (typeof obj !== "object") return `${prefix}${obj}`;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(flattenObject(value, path));
    } else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        value.forEach((item, i) => lines.push(flattenObject(item, `${path}[${i}]`)));
      } else {
        lines.push(`${path}: ${value.join(", ")}`);
      }
    } else {
      lines.push(`${path}: ${value}`);
    }
  }
  return lines.join("\n");
}
